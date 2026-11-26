import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { guardianReceipt, planGuardianEmptyRecovery as plan } from '../src/core/fleet/guardian-empty-recovery.js';
import { cmdJobsRetryEmpty } from '../src/cli/jobs-retry-empty.js';

const job = 'RQ-FIX-MAIN-phantom-abc1234';
const queue = `- DONE ${job} (P0, pool=codex-personal, tier=work, repo=phantom, size<=80): Fix failing typecheck.\n`;
const launch = { event: 'launch', job, repo: 'phantom', tier: 'work', ts: '2026-11-23T12:00:00Z' };
const finish = { event: 'finish', job, empty: true, exit_code: 124, failure_reason: 'launch_timeout', ts: '2026-11-23T12:05:00Z' };
const ledger = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');
const initial = ledger(launch, finish);
const retry = () => plan(queue, initial, new Set()).lines[0]!;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('preserves failure references, source constraints and measured tier with one deterministic retry', () => {
  const line = retry();
  expect(line).toContain(`${job}-EMPTYRETRY-work (P0, pool=codex-personal, tier=work, repo=phantom, size<=80)`);
  expect(line).toContain(`${job}.log`); expect(line).toContain('exit 124');
  expect(plan(queue, initial, new Set()).lines).toEqual([line]);
  expect(plan(queue.replace('tier=work', 'tier=fast'), initial, new Set()).lines[0]).toContain('tier=work');
  expect(plan(queue, ledger(launch, { ...finish, exit_code: 0 }), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, { ...finish, exit_code: null }), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, { ...finish, exit_code: 0, pool_error: 'rate_limit' }), new Set()).lines).toHaveLength(1);
});

it('deduplicates queued and live jobs, duplicate finishes, pending PRs and torn evidence', () => {
  expect(plan(queue, ledger(launch, finish, finish), new Set()).lines).toEqual([retry()]);
  const child = `${job}-EMPTYRETRY-work`;
  for (const state of ['READY', 'CLAIMED codex-personal now']) {
    expect(plan(queue + retry().replace('- READY', `- ${state}`), initial, new Set()).lines).toEqual([]);
  }
  for (const extra of [{ ...launch, job: child }, { event: 'publish', job, ts: finish.ts, url: 'https://github.com/ashlrai/phantom/pull/42' }]) {
    expect(plan(queue, ledger(launch, finish, extra), new Set()).lines).toEqual([]);
  }
  expect(plan(queue, initial + '\n{', new Set()).lines).toEqual([]);
  expect(plan(queue + queue, initial, new Set()).lines).toEqual([]);
  expect(plan(queue.replace('- DONE', '- READY'), initial, new Set()).lines).toEqual([]);
  const newer = { ...launch, ts: '2026-11-23T12:10:00Z' };
  expect(plan(queue, ledger(launch, newer, finish), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, newer, { event: 'other' }, finish), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, { ...newer, ts: finish.ts }, finish), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, finish, { ...newer, job: 'RQ-FIX-MAIN-other', repo: 'phantom' }), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, finish, { ...newer, job: 'RQ-FIX-MAIN-other', repo: 'locus' }), new Set()).lines).toHaveLength(1);
  expect(plan(queue, ledger(launch, finish, { ...newer, ts: 'unknown' }), new Set()).lines).toEqual([]);
});

it('exhausts one retry per tier without retry chains and retains the failed child context', () => {
  const child = `${job}-EMPTYRETRY-work`, receipt = new Set([guardianReceipt(job, 'work')]);
  const pending = queue + retry();
  expect(plan(pending, initial, receipt)).toEqual({ lines: [], escalations: [] });
  const done = ledger(launch, finish, { ...launch, job: child }, { ...finish, job: child, exit_code: 2 });
  const exhausted = plan(pending, done, receipt);
  expect(exhausted.lines).toEqual([]);
  expect(exhausted.escalations).toEqual([{ job: child, root: job, tier: 'work', exitCode: 2, reason: 'The run failed without a publishable change.' }]);
  expect(plan(queue, initial, receipt).lines).toEqual([]); // Receipt survives queue removal.
  expect(plan(queue.replace('tier=work', 'tier=mid'), ledger({ ...launch, tier: 'mid' }, finish), receipt).lines).toHaveLength(1);
});

it('deduplicates coverage scans across prefixes and numbered jobs, including legacy receipts', () => {
  const alias = 'FIXUP-MAIN-phantom-abc1234-r2';
  expect(guardianReceipt(alias, 'work')).toBe(guardianReceipt(job, 'work'));
  const source = queue.replaceAll(job, alias).replace('typecheck', 'coverage');
  const evidence = initial.replaceAll(job, alias);
  const receipts = new Set([guardianReceipt(job, 'work')]);
  for (let scan = 0; scan < 3; scan++) expect(plan(source, evidence, receipts).lines).toEqual([]);
  const legacy = createHash('sha256').update(`${job}:work`).digest('hex');
  expect(plan(queue, initial, new Set([legacy])).lines).toEqual([]);
  expect(plan(source, evidence, new Set([legacy])).lines).toEqual([]);
  expect(plan(source, evidence + '\n' + ledger({ job, state: 'CLOSED', closedAt: finish.ts }), new Set([legacy])).lines).toEqual([]);
  const numbered = 'RQ-FIX-MAIN-phantom-abc1234-r1';
  const numberedReceipt = createHash('sha256').update(`${numbered}:work`).digest('hex');
  expect(plan(source, evidence + '\n' + ledger({ job: numbered, state: 'CLOSED', closedAt: finish.ts }), new Set([numberedReceipt])).lines).toEqual([]);
  expect(plan(queue.replaceAll('abc1234', 'def5678'), initial.replaceAll('abc1234', 'def5678'), receipts).lines).toHaveLength(1);
});

it('counts failed launches once and escalates after two attempts, even under one job ID', () => {
  const second = { ...launch, ts: '2026-11-23T12:10:00Z' };
  const done = { ...finish, ts: '2026-11-23T12:15:00Z' };
  expect(plan(queue, ledger(launch, finish, { ...finish, ts: '2026-11-23T12:06:00Z' }), new Set()).lines).toHaveLength(1);
  for (const id of [job, 'FIXUP-MAIN-phantom-abc1234-r2']) {
    const source = id === job ? queue : queue + queue.replaceAll(job, id);
    const evidence = ledger(launch, finish, { ...second, job: id }, { ...done, job: id }, { ...done, job: id });
    for (let scan = 0; scan < 3; scan++) {
      const result = plan(source, evidence, new Set());
      expect(result.lines).toEqual([]);
      expect(result.escalations).toEqual([expect.objectContaining({ job: id, exitCode: 124 })]);
      expect(plan(queue, evidence, new Set()).escalations).toEqual([expect.objectContaining({ job: id })]);
    }
    const corrected = { ...done, job: id, ts: '2026-11-23T12:16:00Z', empty: false, exit_code: 0 };
    expect(plan(source, evidence + '\n' + ledger(corrected), new Set()).escalations).toEqual([]);
  }
});

it('defers exhausted recovery while a sibling repair or merge-queue PR is active', () => {
  const alias = 'FIXUP-MAIN-phantom-abc1234-r2', child = `${job}-EMPTYRETRY-work`;
  const source = queue + retry().replace('- READY', '- DONE') + '\n';
  const failed = [launch, finish, { ...launch, job: child }, { ...finish, job: child }];
  for (const active of [
    { ...launch, job: alias },
    { event: 'published', job: alias, ts: finish.ts, url: 'https://github.com/ashlrai/phantom/pull/42' },
  ]) expect(plan(source, ledger(...failed, active), new Set())).toEqual({ lines: [], escalations: [] });
  expect(plan(source + queue.replaceAll(job, alias).replace('- DONE', '- READY'), ledger(...failed), new Set())).toEqual({ lines: [], escalations: [] });
});

it.each([true, false])('suppresses resolved sibling failures with eventful=%s merge evidence', eventful => {
  const alias = 'FIXUP-MAIN-phantom-abc1234-r2';
  const merged = { job: alias, state: 'MERGED', mergedAt: '2026-11-23T12:20:00Z', ...(eventful ? { event: 'outcome' } : {}) };
  expect(plan(queue, ledger(launch, finish, merged), new Set())).toEqual({ lines: [], escalations: [] });
  expect(plan(queue, ledger(launch, finish, { ...merged, state: 'CLOSED' }), new Set()).lines).toHaveLength(1);
  const published = { event: 'publish', job: alias, ts: finish.ts, url: 'https://github.com/ashlrai/phantom/pull/42' };
  expect(plan(queue, ledger(launch, finish, published, { job: alias, state: 'CLOSED', closedAt: merged.mergedAt }), new Set()).lines).toHaveLength(1);
  expect(plan(queue, ledger(launch, finish, { ...merged, job: alias.replace('abc1234', 'def5678') }), new Set()).lines).toHaveLength(1);
});

it('CLI previews then applies once, preserving the original ledger, log and queue bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-empty-'));
  try {
    vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_WT_DIR', join(dir, 'wt'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
    const file = join(dir, 'queue/router-queue.md'), jobs = join(dir, 'metrics/jobs.jsonl'), log = join(dir, `${job}.log`);
    await writeFile(file, queue); await writeFile(jobs, initial); await writeFile(log, 'worker failed');
    expect(await cmdJobsRetryEmpty(['--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).lines).toEqual([retry()]);
    expect(await readFile(file, 'utf8')).toBe(queue);
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(queue + retry() + '\n');
    expect(await readdir(join(dir, 'queue/empty-retry-receipts'))).toEqual([guardianReceipt(job, 'work')]);
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).lines).toEqual([]);
    expect(await readFile(jobs, 'utf8')).toBe(initial); expect(await readFile(log, 'utf8')).toBe('worker failed');
    // A later scan may replace all original rows; the persisted identity still holds.
    const alias = 'FIXUP-MAIN-phantom-abc1234-r2';
    await writeFile(file, queue.replaceAll(job, alias)); await writeFile(jobs, initial.replaceAll(job, alias));
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).lines).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(queue.replaceAll(job, alias));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
