import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseAdvanceBatch } from '../src/cli/fleet-release-advance-batch.js';
import { runReleaseAdvanceBatch } from '../src/core/fleet/release-advance-batch.js';
import type { ReleaseAdvanceOnceReport } from '../src/core/fleet/release-advance-once.js';

// Fake repositories and tags only; every remote mutation goes through the once seam.
const REPO = 'ashlrai/fake-one';
const TAG = 'v1.0.0';
const OTHER_REPO = 'ashlrai/fake-two';
const OTHER_TAG = 'v1.0.1';

let stateDir: string;
let output: string[];
let errors: string[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'rab-ndjson-'));
  output = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v: unknown) => { errors.push(String(v)); return true; });
});
afterEach(() => vi.restoreAllMocks());

const doc = (candidates: unknown): string => JSON.stringify({ version: 1, candidates });
const pair = (repo = REPO, tag = TAG) => ({ repo, tag });
const feed = (...chunks: (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> => (async function* () { yield* chunks; })();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const lines = (): Record<string, unknown>[] => output.map(line => JSON.parse(line) as Record<string, unknown>);

const onceReport = (outcome: ReleaseAdvanceOnceReport['outcome'], patch: Partial<ReleaseAdvanceOnceReport> = {}): ReleaseAdvanceOnceReport => ({
  version: 1, repo: REPO, tag: TAG, apply: false, outcome, reason: `${outcome}_reason`,
  lock: 'not-taken', receipt: { state: 'none', record: null }, advance: null, ...patch,
});

const deferred = () => {
  let resolve!: (report: ReleaseAdvanceOnceReport) => void;
  const promise = new Promise<ReleaseAdvanceOnceReport>(r => { resolve = r; });
  return { promise, resolve };
};

describe('release-advance-batch core observer', () => {
  it('without an observer the aggregate report is unchanged', async () => {
    const once = vi.fn(async (repo: string, tag: string) => onceReport('planned', { repo, tag }));
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    const report = await runReleaseAdvanceBatch(candidates, { once, stateDir });
    expect(report).toEqual({
      version: 1, apply: false, total: 2, succeeded: 2, unsuccessful: 0, counts: { planned: 2 },
      completed: [`${REPO}@${TAG}`, `${OTHER_REPO}@${OTHER_TAG}`], remaining: [],
      entries: [onceReport('planned'), onceReport('planned', { repo: OTHER_REPO, tag: OTHER_TAG })],
    });
  });

  it('an observer sees each finished entry in order and leaves the report identical', async () => {
    const once = vi.fn(async (repo: string, tag: string) => onceReport('planned', { repo, tag }));
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    const bare = await runReleaseAdvanceBatch(candidates, { once });
    const seen: { index: number; total: number; repo: string }[] = [];
    const observed = await runReleaseAdvanceBatch(candidates, {
      once,
      onEntry: ({ index, total, report }) => { seen.push({ index, total, repo: report.repo }); },
    });
    expect(observed).toEqual(bare);
    expect(seen).toEqual([{ index: 1, total: 2, repo: REPO }, { index: 2, total: 2, repo: OTHER_REPO }]);
  });

  it('an observer error rejects the batch unchanged and starts no later candidate', async () => {
    const once = vi.fn(async (repo: string, tag: string) => onceReport('submitted', { repo, tag, apply: true }));
    const sinkError = new Error('sink closed');
    const run = runReleaseAdvanceBatch([pair(), pair(OTHER_REPO, OTHER_TAG)], {
      once, apply: true, onEntry: () => { throw sinkError; },
    });
    await expect(run).rejects.toBe(sinkError);
    expect(once).toHaveBeenCalledTimes(1);
  });
});

describe('fleet release-advance-batch --ndjson', () => {
  it('emits the first entry while the second candidate is still unresolved', async () => {
    const gates = [deferred(), deferred()];
    let started = 0;
    const once = vi.fn(() => gates[started++]!.promise);
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    const text = doc(candidates);
    const pending = cmdFleetReleaseAdvanceBatch(['--stdin', '--ndjson'],
      { input: feed(text.slice(0, 9), text.slice(9)), once, stateDir });
    await tick();
    expect(once).toHaveBeenCalledTimes(1);
    expect(output).toHaveLength(0);

    gates[0]!.resolve(onceReport('planned'));
    await tick();
    expect(once).toHaveBeenCalledTimes(2);
    expect(lines()).toEqual([expect.objectContaining({ version: 1, type: 'entry', index: 1, total: 2, repo: REPO, tag: TAG })]);

    gates[1]!.resolve(onceReport('blocked', { repo: OTHER_REPO, tag: OTHER_TAG }));
    expect(await pending).toBe(1);

    const records = lines();
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ version: 1, type: 'entry', index: 1, total: 2, repo: REPO, tag: TAG,
      result: onceReport('planned') });
    expect(records[1]).toMatchObject({ version: 1, type: 'entry', index: 2, total: 2, repo: OTHER_REPO, tag: OTHER_TAG,
      result: onceReport('blocked', { repo: OTHER_REPO, tag: OTHER_TAG }) });
    expect(records[2]).toMatchObject({ version: 1, type: 'summary',
      report: { total: 2, succeeded: 1, unsuccessful: 1, counts: { planned: 1, blocked: 1 } } });
    expect(errors).toHaveLength(0);
  });

  it('the summary record matches the existing --json aggregate for the same run', async () => {
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    const make = () => vi.fn(async (repo: string, tag: string, o: { apply?: boolean }) =>
      onceReport(o.apply === true ? 'submitted' : 'planned', { repo, tag, apply: o.apply === true }));
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--apply', '--json'],
      { input: feed(doc(candidates)), once: make(), stateDir })).toBe(0);
    const aggregate = JSON.parse(output[0]!) as unknown;
    output = [];
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--apply', '--ndjson'],
      { input: feed(doc(candidates)), once: make(), stateDir })).toBe(0);
    expect(lines().at(-1)).toEqual({ version: 1, type: 'summary', report: aggregate });
  });

  it('a blocked entry does not stop the next candidate', async () => {
    const once = vi.fn(async (repo: string, tag: string) =>
      repo === REPO ? onceReport('blocked', { repo, tag }) : onceReport('planned', { repo, tag }));
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--ndjson'],
      { input: feed(doc([pair(), pair(OTHER_REPO, OTHER_TAG)])), once, stateDir })).toBe(1);
    expect(once).toHaveBeenCalledTimes(2);
    expect(lines().map(r => r.type)).toEqual(['entry', 'entry', 'summary']);
  });

  it.each([
    ['not json', '{'],
    ['unknown top field', JSON.stringify({ version: 1, candidates: [pair()], extra: 1 })],
    ['duplicate candidates', doc([pair(), pair()])],
    ['bad tag', doc([{ repo: REPO, tag: 'latest' }])],
    ['17 candidates', doc(Array.from({ length: 17 }, (_, i) => pair(REPO, `v1.0.${i}`)))],
  ])('malformed input (%s) makes zero calls and prints one invalid record', async (_label, text) => {
    const once = vi.fn();
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--ndjson'], { input: feed(text), once, stateDir })).toBe(2);
    expect(once).not.toHaveBeenCalled();
    expect(lines()).toEqual([{ version: 1, outcome: 'invalid', reason: expect.any(String) }]);
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });

  it('rejects --json together with --ndjson before reading stdin', async () => {
    const once = vi.fn();
    let iterated = false;
    const poison = (async function* () { iterated = true; yield doc([pair()]); })();
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json', '--ndjson'], { input: poison, once, stateDir })).toBe(2);
    expect(iterated).toBe(false);
    expect(once).not.toHaveBeenCalled();
    expect(lines()).toEqual([{ version: 1, outcome: 'invalid', reason: 'json_and_ndjson' }]);
    expect(errors).toHaveLength(0);
  });

  it('a stdout failure becomes exit 1 with no second candidate, not invalid input', async () => {
    const once = vi.fn(async (repo: string, tag: string) => onceReport('submitted', { repo, tag, apply: true }));
    vi.mocked(console.log).mockImplementation((v: unknown) => {
      if (String(v).includes('"type":"entry"')) throw new Error('EPIPE');
      output.push(String(v));
    });
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--apply', '--ndjson'],
      { input: feed(doc([pair(), pair(OTHER_REPO, OTHER_TAG)])), once, stateDir })).toBe(1);
    expect(once).toHaveBeenCalledTimes(1);
    expect(errors.join('')).toContain('Output failed');
    expect(output.join('')).not.toContain('invalid');
  });

  it('plain --json and default output stay one aggregate line with no records', async () => {
    const once = vi.fn(async (repo: string, tag: string) => onceReport('planned', { repo, tag }));
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin'], { input: feed(doc([pair()])), once, stateDir })).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('Release advance batch (dry run)');
    output = [];
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json'], { input: feed(doc([pair()])), once, stateDir })).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ total: 1, counts: { planned: 1 } });
  });
});
