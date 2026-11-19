import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchDedupe, launchDedupeFile, type LaunchEvidence } from '../src/core/queue/launch-dedupe.js';
import { parseMainLog } from '../src/core/queue/launch-evidence.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const DAY = 86_400_000;
const row = (id: string, goal: string, extra = 'repo=phantom', status = 'READY') => `- ${status} ${id} (P1, ${extra}): ${goal}\n`;
const evidence = (over: Partial<LaunchEvidence> = {}): LaunchEvidence => ({ repo: 'ashlrai/phantom', main: [], openPrs: [], ...over });
const run = (text: string, ev: LaunchEvidence) => launchDedupe(text, ev, { now: NOW });

describe('launch dedupe', () => {
  it('avoids equivalent work already on main or in an open PR, and keeps distinct work', () => {
    const text =
      row('RQ-LANDED', 'Document sandbox escape handling in docs/SANDBOX.md for operators.') +
      row('RQ-BYTITLE', 'Cover guardian repeat retry backoff failing-run in src/core/fleet/guardian-repeat.ts.') +
      row('RQ-INFLIGHT', 'Rename the ledger writer in src/core/queue/journal.ts to append-only mode.') +
      row('RQ-PRID', 'Totally different words for src/core/other.ts') +
      row('RQ-DISTINCT', 'Add latency histogram buckets to src/core/fleet/guardian-repeat.ts report output.') +
      row('RQ-OTHERREPO', 'Cover retry backoff in src/core/fleet/guardian-repeat.ts with a failing-run case.', 'repo=locus') +
      row('RQ-UNKNOWN', 'no evidence at all');
    const result = run(text, evidence({
      main: [
        { sha: 'abc1234def', subject: 'bridge(RQ-LANDED): guardian retry', at: NOW - DAY, paths: [] },
        { sha: 'bbb2222def', subject: 'Cover guardian repeat retry backoff failing-run', at: NOW - 2 * DAY, paths: ['src/core/fleet/guardian-repeat.ts'] },
      ],
      openPrs: [
        { number: 7280, title: 'Rename ledger writer journal append-only mode', headRef: 'bridge/x', updatedAt: NOW - DAY, paths: ['src/core/queue/journal.ts'] },
        { number: 7281, title: 'bridge: RQ-PRID', headRef: 'codex-bridge/RQ-PRID', updatedAt: NOW - DAY, paths: [] },
      ],
    }));
    expect(result.report.avoided.map(a => [a.id, a.via, a.of, a.match])).toEqual([
      ['RQ-LANDED', 'main', 'abc1234', 'job-id'],
      ['RQ-BYTITLE', 'main', 'bbb2222', 'goal'],
      ['RQ-INFLIGHT', 'open-pr', '#7280', 'goal'],
      ['RQ-PRID', 'open-pr', '#7281', 'job-id'],
    ]);
    expect(result.report).toMatchObject({ candidates: 7, launch: 3, avoidedEmptyLaunches: 4, gaps: [], applied: false });
    expect(result.output).toContain('- SUPERSEDED-BY-main-abc1234 RQ-LANDED');
    expect(result.output).toContain('- SUPERSEDED-BY-pr-7280 RQ-INFLIGHT');
    for (const id of ['RQ-DISTINCT', 'RQ-OTHERREPO', 'RQ-UNKNOWN']) expect(result.output).toContain(`- READY ${id}`);
    // Marked rows are not READY any more: a second pass is a no-op.
    expect(run(result.output, evidence({ main: [], openPrs: [] })).report.avoided).toEqual([]);
  });

  it('counts queued repeats as avoided launches too', () => {
    const text = row('RQ-OLD', 'module guardian retry repair deduplicate', 'repo=phantom', 'CLAIMED 09:15 dispatchd') +
      row('RQ-NEW', 'module guardian retry repair deduplicate');
    const { report } = run(text, evidence());
    expect(report.avoided).toMatchObject([{ id: 'RQ-NEW', via: 'queued', of: 'RQ-OLD' }]);
    expect(report).toMatchObject({ candidates: 1, launch: 0, avoidedEmptyLaunches: 1 });
  });

  it('ignores stale and undated evidence and says so', () => {
    const text = row('RQ-OLDMAIN', 'Cover guardian repeat retry backoff in src/core/fleet/guardian-repeat.ts') +
      row('RQ-IDLEPR', 'Rename ledger writer journal append-only in src/core/queue/journal.ts') +
      row('RQ-UNDATED', 'bridge target');
    const result = run(text, evidence({
      main: [
        { sha: 'aaa1111', subject: 'bridge(RQ-OLDMAIN): x', at: NOW - 15 * DAY, paths: [] },
        { sha: 'ccc3333', subject: 'bridge(RQ-UNDATED): x', at: null, paths: [] },
      ],
      openPrs: [{ number: 9, title: 'Rename ledger writer journal append-only', headRef: 'b', updatedAt: NOW - 4 * DAY, paths: ['src/core/queue/journal.ts'] }],
    }));
    expect(result.report).toMatchObject({ avoided: [], avoidedEmptyLaunches: 0, launch: 3 });
    expect(result.report.stale).toEqual([
      { kind: 'main', ref: 'aaa1111', reason: 'older-than-window' },
      { kind: 'main', ref: 'ccc3333', reason: 'undated' },
      { kind: 'open-pr', ref: '#9', reason: 'older-than-window' },
    ]);
    expect(result.output).toBe(text);
  });

  it('treats unreadable evidence as a gap, never as a verdict', () => {
    const text = row('RQ-A', 'Cover guardian repeat retry backoff in src/core/fleet/guardian-repeat.ts');
    const result = run(text, evidence({ main: null, openPrs: null }));
    expect(result.report.gaps).toEqual(['main: default-branch history unavailable', 'open-pr: snapshot unavailable']);
    expect(result.report.avoided).toEqual([]);
    expect(run(text, evidence({ repo: '' })).report.gaps).toContain('repo: identity unavailable');
  });

  it('does not match an id that only appears inside a longer id', () => {
    const result = run(row('RQ-FOO', 'tiny'), evidence({ main: [{ sha: 'ddd4444', subject: 'bridge(RQ-FOO2): x', at: NOW, paths: [] }] }));
    expect(result.report.avoided).toEqual([]);
  });

  it('previews without writing and applies under the shared lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-dedupe-'));
    const path = join(dir, 'router-queue.md');
    const text = row('RQ-LANDED', 'anything') + row('RQ-FRESH', 'other work');
    await writeFile(path, text);
    const ev = evidence({ main: [{ sha: 'abc1234', subject: 'bridge(RQ-LANDED): done', at: NOW - 1, paths: [] }] });
    expect((await launchDedupeFile(path, ev, false, { now: NOW })).applied).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(text);
    expect((await launchDedupeFile(path, ev, true, { now: NOW })).applied).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(text.replace('- READY RQ-LANDED', '- SUPERSEDED-BY-main-abc1234 RQ-LANDED'));
  });

  it('parses git log output and drops malformed records', () => {
    const raw = '\x1eabc1234\x1f1795000000\x1fbridge(RQ-A): x (#1)\n\nsrc/a.ts\ntest/a.test.ts\n\x1ezzz\x1f1\x1fbad\n\x1edef5678\x1fnope\x1fdate\n';
    expect(parseMainLog(raw)).toEqual([
      { sha: 'abc1234', subject: 'bridge(RQ-A): x (#1)', at: 1795000000000, paths: ['src/a.ts', 'test/a.test.ts'] },
      { sha: 'def5678', subject: 'date', at: null, paths: [] },
    ]);
  });
});
