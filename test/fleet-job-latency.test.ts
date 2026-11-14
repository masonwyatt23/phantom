import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobLatency, jobLatency as cliJobLatency } from '../src/cli/fleet-job-latency.js';
import { jobLatency } from '../src/core/fleet/job-latency.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const fixture = 'test/fixtures/job-latency/jobs.jsonl';
afterEach(() => vi.restoreAllMocks());

const ledger = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\r\n');
const boundary = (event: string, seconds: number) => ({ job: 'a', event, ts: new Date(seconds * 1000).toISOString() });

it('keeps the CLI analysis export compatible with the core implementation', () => {
  expect(cliJobLatency).toBe(jobLatency);
});

it('deduplicates equal timestamps, including zero, and measures zero-length phases', () => {
  const report = jobLatency(ledger([
    boundary('queued', 0), boundary('queued', 0),
    boundary('launch', 0), boundary('launch', 0),
    boundary('checkout_complete', 20),
  ]));
  expect(report.top_wastes.map(p => [p.phase, p.total_seconds])).toEqual([
    ['checkout', 20], ['queue_wait', 0],
  ]);
});

it.each(['queued', 'launch'])('keeps %s ambiguous after distinct timestamps and later duplicates', event => {
  const rows = [boundary('queued', 0), boundary('launch', 10), boundary('checkout_complete', 20)];
  // A heavily repeated boundary must never become unique again.
  for (let i = 0; i < 1000; i++) rows.push(boundary(event, i));
  rows.push(boundary(event, event === 'queued' ? 0 : 10));
  const report = jobLatency(ledger(rows));
  expect(report.phases[0]).toMatchObject({ measured_jobs: 0, missing_jobs: 1, total_seconds: null });
  expect(report.phases[1]).toMatchObject({ measured_jobs: event === 'launch' ? 0 : 1 });
});

it('preserves aliases, merged outcomes, and jobs with only unrelated valid events', () => {
  const report = jobLatency(ledger([
    { job_id: 'a', type: 'ci_start', timestamp: '2026-01-01T00:00:00Z' },
    { jobId: 'a', event: 'ci_complete', at: '2026-01-01T00:00:10Z' },
    { job: 'a', event: 'outcome', state: 'MERGED', ts: '2026-01-01T00:00:30Z' },
    { job: 'a', event: 'merged', ts: '2026-01-01T00:00:30.000Z' },
    { job: 'unmeasured', event: 'heartbeat', ts: '2026-01-01T00:00:00Z' },
  ]));
  expect(report).toMatchObject({ jobs: 2, ignored_events: 0 });
  expect(report.top_wastes.map(p => [p.phase, p.total_seconds, p.missing_jobs])).toEqual([
    ['merge', 20, 1], ['ci', 10, 1],
  ]);
});

it('counts malformed events without treating blank lines as errors', () => {
  const report = jobLatency('\n \r\n{\n' + ledger([
    null, [], 42, {},
    { ...boundary('queued', 0), job: '' },
    { ...boundary('queued', 0), ts: 'invalid' },
    { ...boundary('queued', 0), event: 42 },
  ]));
  expect(report).toMatchObject({ jobs: 0, ignored_events: 8, top_wastes: [] });
  expect(report.phases.every(p => p.measured_jobs === 0 && p.total_seconds === null)).toBe(true);
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
  expect(await cmdFleetJobLatency(['--jobs', '/missing'])).toBe(1);
  expect(await cmdFleetJobLatency(['--json', '--json'])).toBe(2);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['job-latency']!()).cmdFleetJobLatency).toBe('function');
});
