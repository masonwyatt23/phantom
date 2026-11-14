import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChannelHealth } from '../src/core/fleet/channel-health.js';

// Exercises the real default Slack source adapters (journal + sent store +
// status + pgrep) against synthetic evidence under a scratch HOME. Only the
// process/config boundaries are satisfied: agent-network.toml plus a fake
// `channels slack run` process. iMessage stays unconfigured; only the slack
// channel is asserted.

const NOW = new Date('2026-11-13T18:00:00.000Z');
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();
const ahead = (min: number): string => new Date(NOW.getTime() + min * 60_000).toISOString();

const CH = 'C0FAKE336S';
// Slack `<seconds>.<fraction>` ids; binding orders them verbatim.
const T1 = '1763492400.000001';
const T2 = '1763492400.000002';
const M1 = '1763492400.000100';
const M2 = '1763492400.000200';
const R_MID = '1763492400.000150';
const R_LATE = '1763492400.000300';

const journalRow = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ at: ago(8), decision: 'ingested', channelId: CH, threadTs: T1, messageTs: M1, bus: 'posted', ...over });

const receipt = (over: Record<string, unknown>): Record<string, unknown> => ({
  digest: 'ab'.repeat(32), clientId: '00000000-0000-4000-8000-000000000000',
  expiresAt: NOW.getTime() + 86_400_000, ...over,
});
const store = (...receipts: Record<string, unknown>[]): string =>
  JSON.stringify({ version: 1, messages: Object.fromEntries(receipts.map((r, i) => [(i + 1).toString(16).padStart(64, '0'), r])) });

const SLACK_TOML = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;

async function withStores(
  input: { journal?: string[] | null; store?: string | null },
  fn: (runs: string) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'ch-slackbind-336s-'));
  const runs = join(home, 'runs');
  const ash = join(home, '.ashlr');
  const saved = { HOME: process.env['HOME'], ASHLR_HOME: process.env['ASHLR_HOME'] };
  let proc: ChildProcess | null = null;
  try {
    process.env['HOME'] = home;
    process.env['ASHLR_HOME'] = ash;
    mkdirSync(join(ash, 'fleet', 'slack-transport'), { recursive: true });
    mkdirSync(join(runs, 'slack-bridge'), { recursive: true });
    writeFileSync(join(ash, 'agent-network.toml'), SLACK_TOML, { mode: 0o600 });
    if (input.journal != null) {
      writeFileSync(join(runs, 'slack-bridge', 'journal.jsonl'), `${input.journal.join('\n')}\n`, { mode: 0o600 });
    }
    if (input.store != null) {
      writeFileSync(join(ash, 'fleet', 'slack-transport', 'messages.json'), input.store, { mode: 0o600 });
    }
    proc = spawn('bash', ['-c', 'exec -a "channels slack run" sleep 30'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fn(runs);
  } finally {
    proc?.kill('SIGKILL');
    if (saved.HOME === undefined) delete process.env['HOME']; else process.env['HOME'] = saved.HOME;
    if (saved.ASHLR_HOME === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = saved.ASHLR_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

const slackChannel = async (runs: string) =>
  (await readChannelHealth({ now: () => NOW, host: 'fake-host', runsDir: runs })).channels.find((c) => c.channel === 'slack')!;

describe('channel health Slack reply binding (336S)', () => {
  it('one same-thread sent reply clears one request: verified and LIVE, ids never leak', async () => {
    await withStores({
      journal: [journalRow()],
      store: store(receipt({ channel: CH, thread: T1, state: 'sent', ts: R_LATE })),
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s).toMatchObject({ configured: true, processAlive: true, state: 'LIVE', unansweredCount: 0, missing: [] });
      expect(s.proof.requestCoverage).toBe('verified');
      expect(s.proof.durableIngress).toEqual({ posted: 1, duplicate: 0, failed: 0, unverified: 0 });
      expect(s.lastReplyAt).toBe(new Date(Number(R_LATE) * 1000).toISOString());
      const text = JSON.stringify(s);
      for (const id of [CH, T1, M1]) expect(text).not.toContain(id);
    });
  }, 30_000);

  it('two same-thread requests behind one receipt leave exactly one pending', async () => {
    await withStores({
      journal: [journalRow({ at: ago(8) }), journalRow({ at: ago(6), messageTs: M2 })],
      store: store(receipt({ channel: CH, thread: T1, state: 'sent', ts: R_MID })),
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.state).toBe('UNKNOWN');
      expect(s.unansweredCount).toBe(1);
      expect(s.proof.requestCoverage).toBe('unproven');
      expect(s.missing).toContain('slack request unanswered');
      expect(s.missing).not.toContain('slack reply correlation unavailable');
      expect(s.proof.durableIngress).toEqual({ posted: 2, duplicate: 0, failed: 0, unverified: 0 });
    });
  }, 30_000);

  it('a replayed ingress delivery does not create a second pending request', async () => {
    await withStores({
      journal: [journalRow({ at: ago(8) }), journalRow({ at: ago(5), bus: 'duplicate' })],
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.unansweredCount).toBe(1);
      expect(s.state).toBe('LIVE');
      expect(s.proof.requestCoverage).toBe('unproven');
      expect(s.proof.durableIngress).toEqual({ posted: 1, duplicate: 1, failed: 0, unverified: 0 });
    });
  }, 30_000);

  it('wrong-thread, attempted, top-level and id-less sends never clear a request', async () => {
    await withStores({
      journal: [journalRow({ at: ago(8) })],
      store: store(
        receipt({ channel: CH, thread: T2, state: 'sent', ts: R_LATE }),
        receipt({ channel: CH, thread: T1, state: 'attempted' }),
        receipt({ channel: CH, state: 'sent', ts: R_LATE }),
        receipt({ state: 'sent', ts: R_LATE }),
      ),
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.state).toBe('UNKNOWN');
      expect(s.unansweredCount).toBe(1);
      expect(s.proof.requestCoverage).toBe('unproven');
      expect(s.missing).toContain('slack request unanswered');
    });
  }, 30_000);

  it('old metadata-free journal rows stay unproven instead of disappearing', async () => {
    await withStores({
      journal: [JSON.stringify({ at: ago(8), decision: 'ingested', bus: 'posted' })],
      store: store(receipt({ channel: CH, thread: T1, state: 'sent', ts: R_LATE })),
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.state).toBe('UNKNOWN');
      expect(s.unansweredCount).toBe(1);
      expect(s.proof.requestCoverage).toBe('unproven');
      expect(s.missing).toContain('slack reply correlation unavailable');
      expect(s.missing).not.toContain('slack request unanswered');
    });
  }, 30_000);

  it('a durable bus failure stays DEGRADED even when its reply receipt binds', async () => {
    await withStores({
      journal: [journalRow({ bus: 'failed' })],
      store: store(receipt({ channel: CH, thread: T1, state: 'sent', ts: R_LATE })),
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.state).toBe('DEGRADED');
      expect(s.unansweredCount).toBe(0);
      expect(s.proof.requestCoverage).toBe('verified');
      expect(s.missing).toContain('slack durable ingress failed');
      expect(s.proof.durableIngress).toEqual({ posted: 0, duplicate: 0, failed: 1, unverified: 0 });
    });
  }, 30_000);

  it('a malformed sent store keeps the channel UNKNOWN, not guessed', async () => {
    await withStores({
      journal: [journalRow()],
      store: '{not-json',
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.state).toBe('UNKNOWN');
      expect(s.missing).toContain('slack receipt source unreadable');
    });
  }, 30_000);

  it('a degraded journal keeps the channel UNKNOWN, not guessed', async () => {
    await withStores({
      journal: [journalRow(), '{not-json'],
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.state).toBe('UNKNOWN');
      expect(s.missing).toContain('slack receipt source unreadable');
    });
  }, 30_000);

  it('a future-dated request is rejected as evidence, never answered', async () => {
    await withStores({
      journal: [journalRow({ at: ahead(30) })],
      store: store(receipt({ channel: CH, thread: T1, state: 'sent', ts: R_LATE })),
    }, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.state).toBe('UNKNOWN');
      expect(s.unansweredCount).toBe(0);
      expect(s.proof.requestCoverage).toBe('idle');
      expect(s.proof.futureDatedCount).toBe(1);
      expect(s.missing).toContain('slack future-dated receipt ignored');
    });
  }, 30_000);
});
