import { afterEach, expect, it, vi } from 'vitest';
import { readReviewPick, type ReviewPickReadOptions } from '../src/core/fleet/review-pick.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

const workers: LiveWorkersSnapshot = {
  v: 1, generatedAt: '2026-11-14T16:00:00.000Z', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0,
};
const row = (sha: string) => ({
  number: 1, title: 'bridge: RQ-PARALLEL', headRefName: 'bridge/RQ-PARALLEL', headRefOid: sha,
  isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-14T10:00:00Z',
});
const ghResult = (sha: string) => ({ ok: true, stdout: JSON.stringify([row(sha)]), stderr: '' });
const defaults: ReviewPickReadOptions = {
  repo: 'ashlrai/phantom', readTimeoutMs: 1000, now: () => Date.parse('2026-11-14T16:00:00Z'),
  readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
  inspectBusWork: () => ({ source: 'available', claims: [] }),
  readBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
  listWorkers: async () => workers,
  gh: async () => ghResult('b'.repeat(40)),
};

afterEach(() => vi.useRealTimers());

it('starts gh alongside delayed ownership and bounds concurrent hangs to one deadline', async () => {
  vi.useFakeTimers();
  const claimed = deferred<{ state: 'healthy'; text: string }>();
  const live = deferred<LiveWorkersSnapshot>();
  const gh = deferred<ReturnType<typeof ghResult>>();
  const ghRead = vi.fn(() => gh.promise);
  const first = readReviewPick({ ...defaults, readClaimedTsv: () => claimed.promise, listWorkers: () => live.promise, gh: ghRead });
  expect(ghRead).toHaveBeenCalledOnce();
  let done = false;
  void first.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const report = await first;
  expect(report.picked).toBeNull();
  expect(report.reason).toBe('pr and ownership sources unavailable');
  expect(report.source).toEqual({ prs: 'unavailable', claims: {
    'claimed-tsv': 'unavailable', 'bus-work-claims': 'read', coordination: 'read', 'live-workers': 'unavailable',
  }, unavailable: ['claimed-tsv', 'live-workers'] });
  expect(vi.getTimerCount()).toBe(0);

  const second = await readReviewPick(defaults);
  expect(second.picked).toMatchObject({ pr: 1, head_sha: 'b'.repeat(40), owner: 'none' });
  const snapshot = JSON.stringify([report, second]);
  claimed.resolve({ state: 'healthy', text: '' });
  live.resolve(workers);
  gh.resolve(ghResult('a'.repeat(40)));
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify([report, second])).toBe(snapshot);
});
