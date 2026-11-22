import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { composeFleetHealth, readFleetHealth, type HealthSources } from '../src/core/fleet/health.js';
import { buildThroughput } from '../src/core/fleet/throughput.js';
import { familyYield } from '../src/core/fleet/family-yield.js';
import { poolShareSnapshot } from '../src/core/usage/runway.js';
import { cmdFleetHealth } from '../src/cli/fleet-health.js';
import { createFleetMemoryApi } from '../src/core/verse/fleet-memory-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = Date.parse('2026-11-22T19:00:00Z');
const fixture = (): HealthSources => ({
  main: { v: 1, generatedAt: new Date(now).toISOString(), statusAt: new Date(now).toISOString(), source: 'ok', stale: false, guardianOff: false, red: 0,
    repos: [{ repo: 'phantom', branch: 'master', sha: null, state: 'green', checkedAt: null, failingCheck: null, fixJobs: [], emptyAttempts: 0, retryHold: false, nightlyRed: null }] },
  merges: buildThroughput({ ledger: [
    { job: 'RQ-TEST1', event: 'publish', ts: '2026-11-22T18:50:00Z', url: 'https://github.com/ashlrai/phantom/pull/1' },
    { job: 'RQ-TEST1', event: 'merged', ts: '2026-11-22T18:55:00Z', url: 'https://github.com/ashlrai/phantom/pull/1' },
  ].map(row => JSON.stringify(row)).join('\n'), now, hours: 1, by: 'repo', metricsPath: '/fixture/jobs.jsonl' }),
  pools: poolShareSnapshot([{ pool: 'codex-cmp', usedPercent: 10, burnPerHour: 1, hoursToReset: 2 }], new Date(now).toISOString()),
  families: familyYield([{ job: 'RQ-WASTE1', event: 'launch', ts: '2026-11-22T18:30:00Z' },
    { job: 'RQ-WASTE1', event: 'finish', empty: true, ts: '2026-11-22T18:40:00Z' }].map(row => JSON.stringify(row)), now, 24),
  releases: [{ repo: 'phantom', latestTag: 'v1', tagDate: '2026-11-21T19:00:00Z', commitsSinceTag: 2, state: 'ok', reason: 'Release cadence is current.' }],
});
afterEach(() => vi.restoreAllMocks());
it('composes exactly five linked answers from the existing report fixtures', () => {
  expect(composeFleetHealth(fixture(), now).lines).toEqual([
    { id: 'main', text: 'Main: green.' }, { id: 'merges', text: 'Merges, last hour: 1 PR; publish to merge median 5m 0s.' },
    { id: 'pools', text: 'Unused before reset: codex-cmp (88% unused).' }, { id: 'families', text: 'Wasted starts, last 24 hours: WASTE: 1 empty of 1 starts.' },
    { id: 'releases', text: 'Unreleased work: phantom.' },
  ]);
});
it.each(['main', 'merges', 'pools', 'families', 'releases'] as const)('%s fails independently with a plain reason', id => {
  const report = composeFleetHealth({ ...fixture(), [id]: null }, now);
  expect(report.lines).toHaveLength(5);
  expect(report.lines.find(line => line.id === id)?.text).toMatch(/unknown, because .+/);
  expect(report.lines.filter(line => line.id !== id).map(line => line.text)).toEqual(composeFleetHealth(fixture(), now).lines.filter(line => line.id !== id).map(line => line.text));
});
it('keeps partial evidence unknown and reports unreleased commits even within the release cadence', () => {
  const s = fixture(); s.main!.stale = true; s.merges!.totals.median_publish_to_merge_s = null;
  s.pools!.pools.push(...poolShareSnapshot([{ pool: 'claude', usedPercent: null, burnPerHour: null, hoursToReset: null, reason: 'no recent reading' }], null).pools);
  s.releases!.push({ repo: 'locus', latestTag: null, tagDate: null, commitsSinceTag: null, state: 'unknown', reason: 'local and remote git unavailable' });
  const lines = composeFleetHealth(s, now).lines;
  for (const id of ['main', 'merges', 'pools', 'releases']) expect(lines.find(line => line.id === id)?.text).toContain('unknown, because');
  expect(lines[4]?.text).toContain('phantom; unknown, because locus: local and remote git unavailable');
});
it('serves the same fixture through CLI JSON, text and the GET API; refuses mutations', async () => {
  const read = vi.fn(async () => fixture()), opts = { runsDir: '/fixture', now, read }, expected = await readFleetHealth(opts);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetHealth(['--json'], opts)).toBe(0); expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual(expected);
  expect(await cmdFleetHealth([], opts)).toBe(0); expect(log.mock.calls.at(-1)![0]).toBe(expected.lines.map(line => line.text).join('\n'));
  const api = createFleetMemoryApi({ readHealth: () => readFleetHealth(opts) }); let status = 0, body = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { body = text; } } as ServerResponse;
  expect(await api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/health', 'GET')).toBe(true);
  expect(status).toBe(200); expect(JSON.parse(body)).toEqual(expected);
  await api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/health', 'POST'); expect(status).toBe(405);
  read.mockClear(); await cmdFleetHealth(['--help'], opts); expect(read).not.toHaveBeenCalled();
});
