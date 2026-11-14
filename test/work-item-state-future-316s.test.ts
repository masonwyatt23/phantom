import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { classifyWorkItem, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';
import { cmdFleetWorkState } from '../src/cli/fleet-work-state.js';

const NOW = '2026-11-13T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const SKEW_MS = 5 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW_MS + offsetMs).toISOString();
const ago = (min: number) => at(-min * 60_000);
const base: WorkItemEvidence = { id: 'RQ-FAKE-316S', receivedAt: ago(120) };
const assigned: WorkItemEvidence = { ...base, owner: 'owner-a', claimReceipt: 'claim-1' };
const verified = (atIso: string): WorkItemEvidence['verified'] => ({ tests: '3 passed', source: 'vitest', at: atIso });
const blocker = (atIso: string): WorkItemEvidence['blocker'] => ({ dependency: 'dep-x', source: 'ledger', at: atIso });

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('VERIFIED and BLOCKED at exactly the future-skew boundary stay eligible', () => {
  expect(classifyWorkItem({ ...base, verified: verified(at(SKEW_MS)) }, NOW).state).toBe('VERIFIED');
  expect(classifyWorkItem({ ...base, blocker: blocker(at(SKEW_MS)) }, NOW).state).toBe('BLOCKED');
});

it('VERIFIED and BLOCKED one millisecond past the skew are ineligible', () => {
  expect(classifyWorkItem({ ...base, verified: verified(at(SKEW_MS + 1)) }, NOW).state).toBe('RECEIVED');
  expect(classifyWorkItem({ ...base, blocker: blocker(at(SKEW_MS + 1)) }, NOW).state).toBe('RECEIVED');
});

it('far-future evidence falls through to the next eligible branch', () => {
  const futureVerified = classifyWorkItem({ ...assigned, verified: verified(at(365 * 24 * 60 * 60_000)) }, NOW);
  expect(futureVerified).toMatchObject({ state: 'ASSIGNED', source: 'claim:claim-1' });
  const futureBlocker = classifyWorkItem({ ...assigned, blocker: blocker(at(365 * 24 * 60 * 60_000)) }, NOW);
  expect(futureBlocker.state).toBe('ASSIGNED');
  // A future BLOCKED cannot mask an eligible lower branch either: fresh running wins over nothing.
  const runningThenBlocked = classifyWorkItem(
    { ...assigned, runningEvidence: { source: 'heartbeat', at: ago(5) }, blocker: blocker(at(SKEW_MS + 1)) },
    NOW,
  );
  expect(runningThenBlocked.state).toBe('RUNNING');
});

it('old genuine completion remains VERIFIED regardless of age', () => {
  const old = verified(at(-400 * 24 * 60 * 60_000));
  expect(classifyWorkItem({ ...base, verified: old }, NOW)).toEqual({ state: 'VERIFIED', asOf: old.at, source: 'vitest', missing: [] });
  const oldBlocked = blocker(at(-400 * 24 * 60 * 60_000));
  expect(classifyWorkItem({ ...base, blocker: oldBlocked }, NOW).state).toBe('BLOCKED');
});

it('invalid timestamps never promote a branch', () => {
  expect(classifyWorkItem({ ...base, verified: verified('not a date') }, NOW).state).toBe('RECEIVED');
  expect(classifyWorkItem({ ...base, blocker: blocker('') }, NOW).state).toBe('RECEIVED');
});

it('an invalid reference clock cannot promote future evidence', () => {
  const badNow = 'not a clock';
  expect(classifyWorkItem({ ...base, verified: verified(at(SKEW_MS + 1)) }, badNow).state).toBe('RECEIVED');
  expect(classifyWorkItem({ ...base, blocker: blocker(at(SKEW_MS + 1)) }, badNow).state).toBe('RECEIVED');
  // Conservative and deterministic: with no valid clock, even old evidence cannot prove its branch.
  expect(classifyWorkItem({ ...base, verified: verified(ago(60)) }, badNow).state).toBe('RECEIVED');
  expect(classifyWorkItem({ ...assigned, runningEvidence: { source: 'heartbeat', at: ago(5) } }, badNow).state).toBe('ASSIGNED');
});

it('cmdFleetWorkState --json no longer labels far-future evidence VERIFIED', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const root = await mkdtemp(join(tmpdir(), 'work-state-future-'));
  roots.push(root);
  const file = join(root, 'evidence.json');
  const item = {
    id: 'RQ-FAKE-316S-CLI',
    receivedAt: ago(120),
    owner: 'owner-a',
    claimReceipt: 'claim-1',
    verified: { tests: '3 passed', source: 'vitest', at: at(60 * 60_000) },
  };
  await writeFile(file, JSON.stringify(item));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetWorkState(['--evidence', file, '--json']);
  expect(code).toBe(0);
  const [result] = JSON.parse(log.mock.calls[0]![0] as string) as { state: string }[];
  expect(result!.state).toBe('ASSIGNED');
});
