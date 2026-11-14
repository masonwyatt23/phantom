import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobLatency, jobLatency } from '../src/cli/fleet-job-latency.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { jobLatency as coreJobLatency } from '../src/core/fleet/job-latency.js';

const fixture = 'test/fixtures/job-latency/jobs.jsonl';
afterEach(() => vi.restoreAllMocks());

const ledger = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\r\n');
const boundary = (event: string, seconds: number, job = 'one') =>
  ({ job, event, ts: new Date(seconds * 1000).toISOString() });

it('preserves the CLI calculation export while allowing direct core use', () => {
  expect(jobLatency).toBe(coreJobLatency);
});

it.each([
  ['empty', ''],
  ['blank', '  \r\n\n'],
])('reports unknown totals for an %s ledger', (_name, text) => {
  const report = jobLatency(text);
  expect(report).toMatchObject({ schema: 'fleet.job-latency.v1', jobs: 0, ignored_events: 0, top_wastes: [] });
  expect(report.phases).toHaveLength(5);
  expect(report.phases.every(phase => phase.measured_jobs === 0 && phase.missing_jobs === 0 && phase.total_seconds === null)).toBe(true);
});

it('deduplicates equivalent timestamps and accepts epoch, negative, and zero-duration boundaries', () => {
  const report = jobLatency(ledger([
    boundary('queued', -1), boundary('queued', -1), boundary('launch', 0),
    { job: 'one', event: 'launch', ts: '1970-01-01T01:00:00+01:00' },
    boundary('checkout_complete', 0),
  ]));
  expect(report.top_wastes.map(phase => [phase.phase, phase.total_seconds])).toEqual([
    ['queue_wait', 1], ['checkout', 0],
  ]);
});

it.each(['queued', 'launch'])('keeps %s permanently ambiguous after distinct times followed by duplicates', event => {
  const report = jobLatency(ledger([
    boundary('queued', 0), boundary('launch', 10),
    boundary(event, 1), boundary(event, 2), boundary(event, event === 'queued' ? 0 : 10),
  ]));
  expect(report.phases[0]).toMatchObject({ measured_jobs: 0, missing_jobs: 1, total_seconds: null });
  expect(report.top_wastes).toEqual([]);
});

it.each([
  ['launch', ['queue_wait', 'checkout']],
  ['checkout_complete', ['checkout', 'model']],
  ['ci_complete', ['ci', 'merge']],
] as const)('excludes both phases sharing an ambiguous %s boundary', (event, affected) => {
  const events = ['queued', 'launch', 'checkout_complete', 'finish', 'ci_start', 'ci_complete', 'merged'];
  const rows = events.map((name, i) => boundary(name, i));
  rows.push(boundary(event, 100), boundary(event, events.indexOf(event)));
  const report = jobLatency(ledger(rows));
  expect(report.top_wastes.map(phase => phase.phase)).toEqual(
    ['queue_wait', 'checkout', 'model', 'ci', 'merge'].filter(phase => !(affected as readonly string[]).includes(phase)),
  );
  expect(report.phases.filter(phase => (affected as readonly string[]).includes(phase.phase))
    .every(phase => phase.measured_jobs === 0 && phase.missing_jobs === 1 && phase.total_seconds === null)).toBe(true);
});

it('preserves field aliases, merged outcomes, and phase order when totals tie', () => {
  const report = jobLatency(ledger([
    { job_id: 'one', type: 'queued', timestamp: '2026-01-01T00:00:00Z' },
    { jobId: 'one', type: 'launch', at: '2026-01-01T00:00:10Z' },
    { job: 'one', event: 'ci_start', ts: '2026-01-01T00:00:00Z' },
    { job: 'one', event: 'ci_complete', ts: '2026-01-01T00:00:10Z' },
    { job: 'one', event: 'outcome', outcome: 'MeRgEd', ts: '2026-01-01T00:00:20Z' },
    { job: 'one', event: 'outcome', state: 'MERGED', ts: '2026-01-01T00:00:20Z' },
  ]));
  expect(report).toMatchObject({ jobs: 1, ignored_events: 0 });
  expect(report.top_wastes.map(phase => [phase.phase, phase.total_seconds])).toEqual([
    ['queue_wait', 10], ['ci', 10], ['merge', 10],
  ]);
});

it('counts valid unknown-only jobs without treating unknown events as phase boundaries', () => {
  const report = jobLatency(ledger([
    boundary('custom', 0), boundary('custom', 1), boundary('different', 2),
    boundary('queued', 0, 'two'), boundary('launch', 10, 'two'),
  ]));
  expect(report).toMatchObject({ jobs: 2, ignored_events: 0 });
  expect(report.phases[0]).toMatchObject({ measured_jobs: 1, missing_jobs: 1, total_seconds: 10 });
  expect(report.phases.slice(1).every(phase => phase.missing_jobs === 2 && phase.total_seconds === null)).toBe(true);
});

it('counts malformed records and preserves precedence of present invalid primary fields', () => {
  const report = jobLatency('invalid\n' + ledger([
    null, [], 42, 'row', {},
    { ...boundary('queued', 0), job: '', job_id: 'fallback' },
    { ...boundary('queued', 0), event: 5, type: 'queued' },
    { ...boundary('queued', 0), ts: 'invalid', timestamp: '1970-01-01T00:00:00Z' },
    { ...boundary('queued', 0), ts: 0 },
    boundary('queued', 0),
  ]));
  expect(report).toMatchObject({ jobs: 1, ignored_events: 10, top_wastes: [] });
});

it('sums multiple measured jobs while excluding missing, reversed, and ambiguous pairs', () => {
  const report = jobLatency(ledger([
    boundary('queued', 0), boundary('launch', 0.25),
    boundary('queued', 0, 'two'), boundary('launch', 0.75, 'two'),
    boundary('queued', 1, 'reversed'), boundary('launch', 0, 'reversed'),
    boundary('queued', 0, 'missing'),
    boundary('queued', 0, 'ambiguous'), boundary('queued', 1, 'ambiguous'), boundary('launch', 2, 'ambiguous'),
  ]));
  expect(report.phases[0]).toMatchObject({ measured_jobs: 2, missing_jobs: 3, total_seconds: 1 });
});

it('handles long repeated event histories without recovering an ambiguous boundary', () => {
  const rows = Array.from({ length: 20_000 }, (_, i) => boundary('queued', i));
  rows.push(boundary('queued', 0), boundary('launch', 30_000));
  const report = jobLatency(ledger(rows));
  expect(report).toMatchObject({ jobs: 1, ignored_events: 0, top_wastes: [] });
});

it('ranks measured phases and excludes ambiguous and missing boundaries', async () => {
  const report = jobLatency(await readFile(fixture, 'utf8'));
  expect(report).toMatchObject({ jobs: 2, ignored_events: 1 });
  expect(report.top_wastes.map(x => [x.phase, x.total_seconds, x.measured_jobs, x.missing_jobs])).toEqual([
    ['merge', 50, 1, 1], ['ci', 40, 1, 1], ['model', 30, 1, 1], ['checkout', 20, 1, 1], ['queue_wait', 10, 1, 1],
  ]);
  expect(report.top_wastes.every(x => x.fix_line.length > 0)).toBe(true);
  expect(jobLatency('{"job":"a","event":"launch","ts":"2026-01-01T00:00:02Z"}\n{"job":"a","event":"queued","ts":"2026-01-01T00:00:03Z"}').top_wastes).toEqual([]);
});

it('supports JSON, reports read errors, and is registered', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetJobLatency(['--jobs', fixture, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string).schema).toBe('fleet.job-latency.v1');
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(coreJobLatency(await readFile(fixture, 'utf8')));
  expect(await cmdFleetJobLatency(['--jobs', '/missing'])).toBe(1);
  expect(await cmdFleetJobLatency(['--json', '--json'])).toBe(2);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['job-latency']!()).cmdFleetJobLatency).toBe('function');
});
