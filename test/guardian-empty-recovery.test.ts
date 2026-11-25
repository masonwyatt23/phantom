import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardianReceipt, planGuardianEmptyRecovery } from '../src/core/fleet/guardian-empty-recovery.js';
import { parseMainGuardianStatus, type FleetMainHealthV1 } from '../src/core/fleet/main-health.js';
import { cmdJobsRetryEmpty } from '../src/cli/jobs-retry-empty.js';

const job = 'RQ-FIX-MAIN-phantom-abc1234';
const queue = `- DONE ${job} (P0, pool=codex-personal, tier=work, repo=phantom, size<=80): Fix failing typecheck.\n`;
const launch = { event: 'launch', job, repo: 'phantom', tier: 'work', ts: '2026-11-23T12:00:00Z' };
const finish = { event: 'finish', job, empty: true, exit_code: 124, failure_reason: 'launch_timeout', ts: '2026-11-23T12:05:00Z' };
const ledger = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');
const initial = ledger(launch, finish);
const status = () => `# Main guardian status (${new Date().toLocaleString('sv-SE')})\n| phantom | master | abc1234 | red | | typecheck | ${job} | |\n`;
const health = (): FleetMainHealthV1 => ({ ...parseMainGuardianStatus(status(), Date.now()), source: 'ok', guardianOff: false });
const plan = (queue: string, ledger: string, receipts: Set<string>, observation = health()) => planGuardianEmptyRecovery(queue, ledger, receipts, observation);
const retry = () => plan(queue, initial, new Set()).lines[0]!;
const child = () => /^- READY ([\w.-]+)/.exec(retry())![1]!;
const key = () => /guardian-retry-key=([a-f0-9]{64})/.exec(retry())![1]!;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('preserves failure references, source constraints and measured tier with one deterministic retry', () => {
  const line = retry();
  expect(line).toMatch(new RegExp(`^- READY ${job}-EMPTYRETRY-work-[a-f0-9]{12} `));
  expect(line).toContain(`${child()} (P0, pool=codex-personal, tier=work, repo=phantom, size<=80)`);
  expect(line).toContain(`${job}.log`); expect(line).toContain('exit 124');
  expect(plan(queue, initial, new Set()).lines).toEqual([line]);
  expect(plan(queue.replace('tier=work', 'tier=fast'), initial, new Set()).lines[0]).toContain('tier=work');
  expect(plan(queue, ledger(launch, { ...finish, exit_code: 0 }), new Set()).lines).toHaveLength(1);
  expect(plan(queue, ledger(launch, { ...finish, exit_code: null }), new Set()).lines).toHaveLength(1);
  expect(plan(queue, ledger(launch, { ...finish, exit_code: 0, pool_error: 'rate_limit' }), new Set()).lines).toHaveLength(1);
});

it('deduplicates queued and live jobs, duplicate finishes, pending PRs and torn evidence', () => {
  expect(plan(queue, ledger(launch, finish, finish), new Set()).lines).toEqual([retry()]);
  const retryJob = child();
  for (const state of ['READY', 'CLAIMED codex-personal now']) {
    expect(plan(queue + retry().replace('- READY', `- ${state}`), initial, new Set()).lines).toEqual([]);
  }
  for (const extra of [{ ...launch, job: retryJob }, { event: 'publish', job, ts: finish.ts, url: 'https://github.com/ashlrai/phantom/pull/42' }]) {
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

it('exhausts one retry per failure without retry chains and retains the failed child context', () => {
  const retryJob = child(), receipt = new Set([key()]);
  const pending = queue + retry();
  expect(plan(pending, initial, receipt)).toEqual({ lines: [], escalations: [] });
  const done = ledger(launch, finish, { ...launch, job: retryJob }, { ...finish, job: retryJob, exit_code: 2 });
  const exhausted = plan(pending, done, receipt);
  expect(exhausted.lines).toEqual([]);
  expect(exhausted.escalations).toEqual([{ job: retryJob, root: job, tier: 'work', exitCode: 2, reason: 'The run failed without a publishable change.' }]);
  const held = health(); held.repos[0]!.retryHold = true;
  expect(plan(pending, done, receipt, held)).toEqual(exhausted);
  expect(plan(queue, initial, receipt).lines).toEqual([]); // Receipt survives queue removal.
  expect(plan(queue.replace('tier=work', 'tier=mid'), ledger({ ...launch, tier: 'mid' }, finish), receipt).lines).toEqual([]);
  expect(plan(queue, initial, new Set([guardianReceipt(job, 'work')])).lines).toEqual([]); // Legacy receipts remain effective.
  expect(plan(queue.replace('tier=work', 'tier=mid'), ledger({ ...launch, tier: 'mid' }, finish), new Set([guardianReceipt(job, 'work')])).lines).toEqual([]);
});

it('retries failed non-empty attempts and empty exits, requiring a launch and no published repair', () => {
  for (const extra of [{ empty: false, exit_code: 1 }, { empty: true, exit_code: 0 }]) {
    expect(plan(queue, ledger(launch, { ...finish, ...extra }), new Set()).lines).toHaveLength(1);
  }
  expect(plan(queue, ledger(launch, { ...finish, empty: false, exit_code: 0 }), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(finish), new Set()).lines).toEqual([]);
  const published = { event: 'published', job, ts: '2026-11-23T12:02:00Z', pr: 42 };
  expect(plan(queue, ledger(launch, published, finish), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, { ...published, state: 'MERGED' }, finish), new Set()).lines).toEqual([]);
});

it('shares the retry budget across job IDs and tiers, including repeated scans after queue pruning', () => {
  const alias = 'FIXUP-MAIN-phantom-abc1234';
  const aliasQueue = queue.replaceAll(job, alias).replace('tier=work', 'tier=mid');
  const evidence = ledger(launch, finish, { ...launch, job: alias }, { ...finish, job: alias });
  expect(plan(queue + aliasQueue, evidence, new Set()).lines).toHaveLength(1);
  expect(plan(aliasQueue + retry(), evidence, new Set()).lines).toEqual([]);
  for (let scan = 0; scan < 3; scan++) {
    const result = plan(queue + aliasQueue, evidence, new Set([key()]));
    expect(result.lines).toEqual([]); expect(result.escalations).toHaveLength(1);
  }
});

it('uses current CI evidence for recovery, SHA changes, check changes and guardian holds', () => {
  for (const state of ['green', 'unknown'] as const) {
    const report = health(); report.repos[0]!.state = state;
    expect(plan(queue, initial, new Set(), report)).toEqual({ lines: [], escalations: [] });
  }
  for (const overrides of [{ stale: true }, { guardianOff: true }, { source: 'unavailable' as const }]) {
    expect(plan(queue, initial, new Set(), { ...health(), ...overrides }).lines).toEqual([]);
  }
  const report = health(); report.repos[0]!.sha = 'def5678';
  expect(plan(queue, initial, new Set(), report).lines).toEqual([]); // Old failures cannot retry a new head.
  expect(plan(queue.replaceAll('abc1234', 'def5678'), initial.replaceAll('abc1234', 'def5678'), new Set([key()]), report).lines).toHaveLength(1);
  const changedCheck = health(); changedCheck.repos[0]!.failingCheck = 'lint';
  expect(plan(queue, initial, new Set([key()]), changedCheck).lines).toHaveLength(1);
  const held = health(); held.repos[0]!.retryHold = true;
  expect(plan(queue, initial, new Set(), held)).toMatchObject({ lines: [], escalations: [{ job }] });
});

it('CLI previews then applies once, preserving the original ledger, log and queue bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-empty-'));
  try {
    vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_WT_DIR', join(dir, 'wt'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
    await mkdir(join(dir, 'supervisor')); await writeFile(join(dir, 'supervisor/status-main-guardian.md'), status());
    const file = join(dir, 'queue/router-queue.md'), jobs = join(dir, 'metrics/jobs.jsonl'), log = join(dir, `${job}.log`);
    await writeFile(file, queue); await writeFile(jobs, initial); await writeFile(log, 'worker failed');
    expect(await cmdJobsRetryEmpty(['--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).lines).toEqual([retry()]);
    expect(await readFile(file, 'utf8')).toBe(queue);
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(queue + retry() + '\n');
    expect(await readdir(join(dir, 'queue/empty-retry-receipts'))).toEqual([key()]);
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).lines).toEqual([]);
    await writeFile(file, queue); // Durable budget survives pruning and another apply.
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(queue);
    await writeFile(join(dir, 'supervisor/status-main-guardian.md'), status().replace('| red |', '| green |'));
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).escalations).toEqual([]);
    expect(await readFile(jobs, 'utf8')).toBe(initial); expect(await readFile(log, 'utf8')).toBe('worker failed');
    await writeFile(join(dir, 'supervisor/status-main-guardian.md'), status().replaceAll('abc1234', 'def5678'));
    await writeFile(file, queue.replaceAll('abc1234', 'def5678'));
    await writeFile(jobs, initial.replaceAll('abc1234', 'def5678'));
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).lines).toHaveLength(1);
    expect(await readdir(join(dir, 'queue/empty-retry-receipts'))).toHaveLength(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
