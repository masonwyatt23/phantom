import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetMergeGraph } from '../src/cli/fleet-merge-graph.js';
import { readTaskCheckJobs } from '../src/cli/fleet-task-check.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-10T12:30:00Z');
let home = '';
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleet-merge-graph-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { out.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation((value: unknown) => { err.push(String(value)); });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  rmSync(home, { recursive: true, force: true });
});

function writeLedger(rows: unknown[]): void {
  const dir = join(home, '.ashlr-runs', 'metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jobs.jsonl'), rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
}

describe('fleet merge-graph recovery', () => {
  it('reads a real temp jobs ledger through readTaskCheckJobs', async () => {
    writeLedger([
      { event: 'launch', job: 'RQ-TEST', lane: 'devin', ts: '2026-11-10T10:00:00Z' },
      { event: 'outcome', job: 'RQ-TEST', state: 'MERGED', ts: '2026-11-10T11:00:00Z', ttm_s: 60 },
    ]);
    expect(await cmdFleetMergeGraph(['--json'], readTaskCheckJobs, now)).toBe(0);
    const report = JSON.parse(out[0]!);
    expect(report).toMatchObject({ schema: 'metrics.merges.v1', known: true, windowHours: 24 });
    expect(report.lanes).toEqual([expect.objectContaining({ lane: 'devin' })]);
    expect(report.lanes[0].buckets).toHaveLength(24);
    expect(report.lanes[0].buckets.find((bucket: { start: string }) => bucket.start === '2026-11-10T11:00:00.000Z'))
      .toMatchObject({ merges: 1, medianSeconds: 60 });
  });

  it('distinguishes an unreadable ledger from a readable empty one', async () => {
    expect(await cmdFleetMergeGraph(['--json'], readTaskCheckJobs, now)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ known: false, lanes: null });
    out = [];
    writeLedger([]);
    expect(await cmdFleetMergeGraph(['--json'], readTaskCheckJobs, now)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ known: true, lanes: [] });
  });

  it('prints concise human output and rejects bad arguments without reading', async () => {
    writeLedger([{ event: 'outcome', job: 'RQ-HUMAN', state: 'MERGED', ts: '2026-11-10T11:00:00Z' }]);
    expect(await cmdFleetMergeGraph([], readTaskCheckJobs, now)).toBe(0);
    expect(out[0]).toBe('unknown: 1 merge');
    const read = vi.fn(readTaskCheckJobs);
    for (const args of [['--bogus'], ['x'], ['--json', '--json']]) {
      expect(await cmdFleetMergeGraph(args, read, now)).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(err.length).toBeGreaterThan(0);
  });

  it('is registered for fleet dispatch', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['merge-graph']!()).cmdFleetMergeGraph).toBe(cmdFleetMergeGraph);
  });
});
