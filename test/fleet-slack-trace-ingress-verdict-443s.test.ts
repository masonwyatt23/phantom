import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, slackBridgeDir, type SlackObservation } from '../src/core/agents/slack-journal.js';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';

const CH = 'C0FAKE0001';
const T1 = '1731000000.000100';
const MSG1 = '1731000010.000100';
const MSG2 = '1731000020.000100';
const REPLY = '1731000050.000100';
const REPLY2 = '1731000100.000100';
// `at` values precede the receipt ts so bindSlackReplies can answer; NOW is later still.
const NOW = new Date('2024-11-08T00:00:00.000Z');
const AT1 = '2024-11-07T17:00:00.000Z';
const AT2 = '2024-11-07T17:01:00.000Z';
const AT3 = '2024-11-07T17:02:00.000Z';
const DIGEST = 'a'.repeat(64);
const CLIENT = '11111111-1111-1111-1111-111111111111';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'slack-trace-443s-'));
  roots.push(dir);
  return { runsDir: join(dir, 'runs'), stateRoot: join(dir, 'state') };
}

const ingest = (runsDir: string, at: string, messageTs: string, threadTs: string = T1,
  extra: Partial<SlackObservation> = {}): void => {
  recordSlackObservation({ at, decision: 'ingested', channelId: CH, messageTs, threadTs, ...extra }, { runsDir });
};

type Row = { channel: string; thread?: string; state: 'attempted' | 'sent'; ts?: string };
function writeStore(stateRoot: string, rows: Row[]): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const messages: Record<string, unknown> = {};
  rows.forEach((row, i) => {
    messages[String(i).padStart(64, '0')] = { digest: DIGEST, clientId: CLIENT, expiresAt: 9e12, ...row };
  });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
}

function degradeSends(stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateRoot, 'messages.json'), '{not json', { mode: 0o600 });
}

function degradeJournal(runsDir: string): void {
  const dir = slackBridgeDir(runsDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'journal.jsonl'), '{corrupt\n', { mode: 0o600 });
}

async function run(args: string[], deps: { runsDir: string; stateRoot: string }) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetSlackTrace(args, { ...deps, now: () => NOW });
  return { code, lines: log.mock.calls.map((c) => String(c[0])) };
}

const answeredStore = (stateRoot: string): void =>
  writeStore(stateRoot, [{ channel: CH, thread: T1, state: 'sent', ts: REPLY }]);

describe('fleet slack-trace ingress verdict (443s)', () => {
  it('unknown ingress with a real matching sent receipt exits 1 and keeps row evidence', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1); // no bus field -> ingress unknown
    answeredStore(p.stateRoot);
    const { code, lines } = await run(['--json'], p);
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    const trace = JSON.parse(lines[0]!);
    expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(trace.rows).toHaveLength(1);
    expect(trace.rows[0]).toMatchObject({
      at: AT1, channelId: CH, threadTs: T1, messageTs: MSG1,
      ingress: 'unknown', outcome: 'answered', replyTs: REPLY,
    });
    // Human output already names the ingress verdict per row.
    const human = await run([], p);
    expect(human.code).toBe(1);
    expect(human.lines.some((l) => l.includes(`ingress=unknown -> ANSWERED reply=${REPLY}`))).toBe(true);
  });

  it('posted ingress with a same-thread sent receipt exits 0', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    answeredStore(p.stateRoot);
    const { code, lines } = await run([], p);
    expect(code).toBe(0);
    expect(lines[1]).toContain(`ingress=posted -> ANSWERED reply=${REPLY}`);
  });

  it('duplicate ingress with a same-thread sent receipt exits 0', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'duplicate' });
    answeredStore(p.stateRoot);
    const { code } = await run([], p);
    expect(code).toBe(0);
  });

  it('one unknown-ingress row poisons an otherwise verified trace', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    ingest(p.runsDir, AT2, MSG2, T1); // unknown ingress, same thread
    writeStore(p.stateRoot, [
      { channel: CH, thread: T1, state: 'sent', ts: REPLY },
      { channel: CH, thread: T1, state: 'sent', ts: REPLY2 },
    ]);
    const { code, lines } = await run(['--json'], p);
    expect(code).toBe(1);
    const trace = JSON.parse(lines[0]!);
    expect(trace.counts.answered).toBe(2);
    expect(trace.rows.map((r: { ingress: string }) => r.ingress)).toEqual(['posted', 'unknown']);
  });

  it('failed ingress stays a failure even with a matching receipt', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'failed' });
    answeredStore(p.stateRoot);
    const { code, lines } = await run([], p);
    expect(code).toBe(1);
    expect(lines[1]).toContain(`ingress=failed -> BUS-FAILED`);
  });

  it('a degraded sends source fails verification and reports degraded', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    degradeSends(p.stateRoot);
    const { code, lines } = await run(['--json'], p);
    expect(code).toBe(1);
    const trace = JSON.parse(lines[0]!);
    expect(trace.sources).toEqual({ journal: 'ok', sends: 'degraded' });
  });

  it('a degraded journal source fails verification and reports degraded', async () => {
    const p = setup();
    degradeJournal(p.runsDir);
    answeredStore(p.stateRoot);
    const { code, lines } = await run(['--json'], p);
    expect(code).toBe(1);
    const trace = JSON.parse(lines[0]!);
    expect(trace.sources).toEqual({ journal: 'degraded', sends: 'ok' });
    expect(trace.rows).toHaveLength(0);
  });

  it('healthy sources with no matching rows fail verification', async () => {
    const p = setup();
    recordSlackObservation(
      { at: AT3, decision: 'ignored', channelId: CH, messageTs: '1731000030.000100', threadTs: T1, reason: 'untrusted-sender' },
      { runsDir: p.runsDir });
    answeredStore(p.stateRoot);
    const { code, lines } = await run([], p);
    expect(code).toBe(1);
    expect(lines).toEqual([`slack trace as of ${NOW.toISOString()} (journal=ok sends=ok)`,
      'No matching request evidence; verification unsuccessful.']);
  });

  it('missing sources fail verification', async () => {
    const p = setup();
    const { code, lines } = await run([], p);
    expect(code).toBe(1);
    expect(lines[0]).toContain('journal=missing sends=missing');
  });
});
