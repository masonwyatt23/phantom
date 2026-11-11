/**
 * RQ-PHX-TEAMMATEGAP173: the agent-facing `phm fleet teammate-gap` verb over the
 * existing reply-gap reader. Fake state only: temp runs dirs written through the
 * current recordTeammateText / markTeammateTextsAnswered APIs. No live inbox,
 * no sends, and never the real home directory.
 */
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetTeammateGap } from '../src/cli/fleet-teammate-gap.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { markTeammateTextsAnswered, recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { teammateReplyGap, type ReplyGapEvent } from '../src/core/comms/teammate-reply-gap.js';

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const at = (minsAgo: number): Date => new Date(NOW - minsAgo * 60_000);
const iso = (minsAgo: number): string => at(minsAgo).toISOString();

const roots: string[] = [];
function runsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teammate-gap-173-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  delete process.env.ASHLR_RUNS_DIR;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

const SECRET_HANDLE = 'teammate-fake@example.invalid';
const SECRET_BODY = 'zebra-body-marker please reply?';

async function run(args: string[], dir?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdFleetTeammateGap(args, { output: t => out.push(t), error: t => err.push(t), runsDir: dir, now: () => NOW });
  return { code, out, err, json: () => JSON.parse(out.join('\n')) as Record<string, any> };
}

describe('fleet teammate-gap (real verb, fake inbox state)', () => {
  it('is registered in the fleet convention registry and resolves to the same handler', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['teammate-gap']!();
    expect(mod.cmdFleetTeammateGap).toBe(cmdFleetTeammateGap);
  });

  it('reports unknown with no teammates when the store is absent', async () => {
    const r = await run(['--json'], runsDir());
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ schema: 'fleet.teammate-gap.v1', state: 'unknown', sourceState: 'missing', teammates: [] });
  });

  it('flags a text waiting past five minutes as late, with only counts, ages and timestamps', async () => {
    const dir = runsDir();
    expect(recordTeammateText({ rowid: 11, handle: SECRET_HANDLE, text: SECRET_BODY }, dir, at(8))).toBe(true);
    const r = await run(['--json'], dir);
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j).toMatchObject({ state: 'late', sourceState: 'healthy', warnAfterMinutes: 5, answeredTimestampBasis: 'inbound-receipt' });
    expect(j.teammates).toEqual([{
      label: 'Teammate 1', state: 'late', unansweredCount: 1,
      oldestUnansweredAt: iso(8), oldestUnansweredAgeMinutes: 8,
      lastInboundAt: iso(8), lastAnsweredReceiptAt: null,
    }]);
    expect(r.out.join('\n')).not.toMatch(/zebra|example\.invalid|imessage:|"handle"|"senderId"|"body"|"text"/);
  });

  it('reports ok inside the warn window', async () => {
    const dir = runsDir();
    recordTeammateText({ rowid: 12, handle: SECRET_HANDLE, text: 'ping?' }, dir, at(2));
    const j = (await run(['--json'], dir)).json();
    expect(j.state).toBe('ok');
    expect(j.teammates[0]).toMatchObject({ state: 'ok', unansweredCount: 1, oldestUnansweredAgeMinutes: 2 });
  });

  it('clears an answered text and reports its receipt time, not a send time', async () => {
    const dir = runsDir();
    recordTeammateText({ rowid: 13, handle: SECRET_HANDLE, text: 'status?' }, dir, at(30));
    expect(markTeammateTextsAnswered([13], dir, at(10))).toBe(1);
    const j = (await run(['--json'], dir)).json();
    expect(j.state).toBe('ok');
    expect(j.teammates).toEqual([{
      label: 'Teammate 1', state: 'ok', unansweredCount: 0,
      oldestUnansweredAt: null, oldestUnansweredAgeMinutes: null,
      lastInboundAt: iso(30), lastAnsweredReceiptAt: iso(30),
    }]);
    const human = (await run([], dir)).out.join('\n');
    expect(human).toContain('Answered times are inbound receipt times, not measured send times.');
  });

  it('keeps an older open text waiting when a later text from the same teammate was answered', async () => {
    // Regression for the master reader's pairing rule, which reported 0 waiting here.
    const dir = runsDir();
    recordTeammateText({ rowid: 20, handle: SECRET_HANDLE, text: 'first?' }, dir, at(12));
    recordTeammateText({ rowid: 21, handle: SECRET_HANDLE, text: 'second?' }, dir, at(9));
    markTeammateTextsAnswered([21], dir, at(1));
    const j = (await run(['--json'], dir)).json();
    expect(j.state).toBe('late');
    expect(j.teammates[0]).toMatchObject({
      unansweredCount: 1, state: 'late', oldestUnansweredAgeMinutes: 12,
      oldestUnansweredAt: iso(12), lastInboundAt: iso(9), lastAnsweredReceiptAt: iso(9),
    });
  });

  it('separates teammates under generic labels and reports each group', async () => {
    const dir = runsDir();
    recordTeammateText({ rowid: 30, handle: 'alpha-fake@example.invalid', text: 'alpha?' }, dir, at(7));
    recordTeammateText({ rowid: 31, handle: 'beta-fake@example.invalid', text: 'beta?' }, dir, at(3));
    markTeammateTextsAnswered([31], dir, at(1));
    const j = (await run(['--json'], dir)).json();
    expect(j.teammates.map((t: { label: string }) => t.label)).toEqual(['Teammate 1', 'Teammate 2']);
    expect(j.teammates.map((t: { unansweredCount: number }) => t.unansweredCount).sort()).toEqual([0, 1]);
    expect(j.state).toBe('late');
    expect(JSON.stringify(j)).not.toMatch(/fake@example|imessage:/);
  });

  it('reports unknown, not ok, when the store has a malformed line and nothing is late', async () => {
    const dir = runsDir();
    recordTeammateText({ rowid: 40, handle: SECRET_HANDLE, text: 'ping?' }, dir, at(2));
    appendFileSync(join(dir, 'imessage', 'teammates.jsonl'), 'not-json\n');
    const j = (await run(['--json'], dir)).json();
    expect(j).toMatchObject({ sourceState: 'degraded', state: 'unknown' });
  });

  it('still reports late when a degraded store has a late text', async () => {
    const dir = runsDir();
    recordTeammateText({ rowid: 41, handle: SECRET_HANDLE, text: 'ping?' }, dir, at(9));
    appendFileSync(join(dir, 'imessage', 'teammates.jsonl'), 'not-json\n');
    const j = (await run(['--json'], dir)).json();
    expect(j).toMatchObject({ sourceState: 'degraded', state: 'late' });
  });

  it('prints one human line per teammate with no body or handle', async () => {
    const dir = runsDir();
    recordTeammateText({ rowid: 50, handle: SECRET_HANDLE, text: SECRET_BODY }, dir, at(6));
    const r = await run([], dir);
    expect(r.code).toBe(0);
    const lines = r.out.join('\n').split('\n');
    expect(lines[0]).toBe('Teammate reply gap: late (store healthy, warn after 5m)');
    expect(lines[1]).toMatch(/^ {2}Teammate 1: late, 1 waiting, oldest 6m/);
    expect(lines.at(-1)).toBe('Answered times are inbound receipt times, not measured send times.');
    expect(r.out.join('\n')).not.toMatch(/zebra|example\.invalid|imessage:/);
  });

  it('honors ASHLR_RUNS_DIR when no --runs-dir is given', async () => {
    const dir = runsDir();
    recordTeammateText({ rowid: 60, handle: SECRET_HANDLE, text: 'ping?' }, dir, at(7));
    process.env.ASHLR_RUNS_DIR = dir;
    const out: string[] = [];
    const code = await cmdFleetTeammateGap(['--json'], { output: t => out.push(t), now: () => NOW });
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!).state).toBe('late');
  });
});

describe('fleet teammate-gap argument validation', () => {
  it.each([
    ['--bogus'],
    ['positional'],
    ['--json', '--json'],
    ['--runs-dir'],
    ['--runs-dir', '--json'],
    ['--runs-dir', ''],
  ])('rejects %j with exit 2 and no output', async (...args) => {
    const r = await run(args, runsDir());
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(r.err[0]).toMatch(/invalid arguments/);
  });

  it('prints usage for --help and exits 0 without reading state', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^Usage: phm fleet teammate-gap/);
  });
});

describe('reply-gap pure computation (retained recovered cases, multiple events and threshold)', () => {
  const min = (n: number) => NOW - n * 60_000;
  const ev = (teammate: string, direction: ReplyGapEvent['direction'], minsAgo: number): ReplyGapEvent => ({ teammate, direction, at: min(minsAgo) });

  it('counts only inbound texts with no later outbound, across several teammates', () => {
    const gaps = teammateReplyGap([
      ev('A', 'inbound', 20), ev('A', 'outbound', 15), ev('A', 'inbound', 6), ev('A', 'inbound', 1),
      ev('B', 'inbound', 3),
    ], NOW);
    expect(gaps.map(g => [g.teammate, g.unansweredCount, g.state])).toEqual([['A', 2, 'late'], ['B', 1, 'ok']]);
    expect(gaps[0]).toMatchObject({ oldestUnansweredMs: 6 * 60_000, lastInboundAt: min(1), lastOutboundAt: min(15) });
  });

  it('treats the warn threshold as inclusive and honors a custom threshold', () => {
    const [exact] = teammateReplyGap([ev('A', 'inbound', 5)], NOW);
    expect(exact!.state).toBe('late');
    const [under] = teammateReplyGap([ev('A', 'inbound', 4)], NOW);
    expect(under!.state).toBe('ok');
    const [custom] = teammateReplyGap([ev('A', 'inbound', 4)], NOW, { warnAfterMs: 3 * 60_000 });
    expect(custom!.state).toBe('late');
  });

  it('never invents ok without evidence', () => {
    expect(teammateReplyGap(null, NOW)[0]).toMatchObject({ state: 'unknown', unansweredCount: 0 });
  });
});
