import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { claimFleetWork, handoffFleetClaim, postFleetMessage, readFleetBoard,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const T = Date.parse('2026-11-16T00:00:00Z');
const THREAD = 'TFAKE/CFAKE/1700000000.000001';
const REPO = 'synthetic/repo';
const HEAD = 'abcdef1234567';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'notice-clock-487s-'));
  chmodSync(dir, 0o700); dirs.push(dir);
  const path = join(dir, 'coordination.jsonl');
  const root = join(dir, 'runs');
  const paths = claimNoticePaths(root);
  let now = T;
  let fail = false;
  const calls: { thread: string; text: string; key: string }[] = [];
  const options = () => ({ path, now, reap: false });
  const pass = () => runClaimNoticePass({
    readBoard: () => readFleetBoard(options()), ...claimNoticeFileDeps(root), now: () => now,
    send: (thread, text, key) => {
      calls.push({ thread, text, key });
      return fail ? { ok: false, reason: 'synthetic failure' } : { ok: true, receipt: 'synthetic receipt' };
    },
  });
  const snapshot = () => JSON.parse(readFileSync(paths.prev, 'utf8')) as {
    asOf: number; state: string; claims: { agent: string; claimedAt: number }[];
  };
  const rows = () => existsSync(paths.sent) ? readFileSync(paths.sent, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { v: number; at: number; key: string }) : [];
  return { options, pass, snapshot, rows, paths, calls,
    clock: (value: number) => { now = value; }, failure: (value: boolean) => { fail = value; } };
}
async function assigned() {
  const f = fixture();
  must(postFleetMessage({ from: 'seed', to: 'all', body: 'synthetic marker', ttlMs: 1 }, f.options()));
  f.clock(T + 1000);
  expect(await f.pass()).toMatchObject({ baselined: true, planned: 0 });
  expect(f.snapshot()).toMatchObject({ asOf: T + 1000, claims: [] });
  f.clock(T + 2000);
  const claim = must(claimFleetWork({ repo: REPO, task: 'synthetic task', agent: 'agent-a' }, f.options()));
  expect(appendClaimThreadBinding(f.paths.bindings,
    { claimId: claim.claim.id, repo: REPO, threadKey: THREAD, pr: 7, head: HEAD }, T + 2000).ok).toBe(true);
  f.clock(T + 3000);
  expect(await f.pass()).toMatchObject({ planned: 1, sent: 1, failed: 0 });
  const key = JSON.stringify(['ASSIGNED', claim.claim.id, HEAD]);
  expect(f.calls).toMatchObject([{ thread: THREAD, key }]);
  expect(f.rows()).toEqual([{ v: 1, at: T + 3000, key }]);
  expect(f.snapshot()).toMatchObject({ asOf: T + 3000, claims: [{ agent: 'agent-a' }] });
  return { f, claim, key };
}

describe('durable notice clock regression across restarts', () => {
  it('stays quiet on rollback and delivers a later legitimate handoff once', async () => {
    const { f, claim, key } = await assigned();
    f.clock(T + 2500);
    expect(await f.pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0, deliveries: [] });
    // The sender advances the snapshot backwards despite the planner refusing the diff.
    expect(f.snapshot()).toMatchObject({ asOf: T + 2500, claims: [{ agent: 'agent-a' }] });
    expect(f.rows()).toEqual([{ v: 1, at: T + 3000, key }]);
    expect(f.calls).toHaveLength(1);
    f.clock(T + 4000);
    const handoff = must(handoffFleetClaim({ id: claim.claim.id, agent: 'agent-a', lease: claim.lease, to: 'agent-b' }, f.options()));
    const nextKey = JSON.stringify(['ASSIGNED', REPO, claim.claim.id, 'agent-b', handoff.claim.claimedAt, HEAD]);
    f.clock(T + 5000);
    expect(await f.pass()).toMatchObject({ planned: 1, sent: 1, failed: 0,
      deliveries: [{ state: 'ASSIGNED', threadKey: THREAD, dedupeKey: nextKey, result: 'sent' }] });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toMatchObject({ thread: THREAD, key: nextKey });
    expect(f.calls[1]!.text).toContain('agent-b');
    expect(f.rows()).toEqual([{ v: 1, at: T + 3000, key }, { v: 1, at: T + 5000, key: nextKey }]);
    expect(f.snapshot()).toMatchObject({ asOf: T + 5000, claims: [{ agent: 'agent-b' }] });
    f.clock(T + 6000);
    expect(await f.pass()).toMatchObject({ planned: 0, sent: 0, deliveries: [] });
    expect(f.calls).toHaveLength(2);
    expect(f.snapshot()).toMatchObject({ asOf: T + 6000, claims: [{ agent: 'agent-b' }] });
    expect(f.rows()).toHaveLength(2);
  });

  it('retains a failed handoff through rollback and retries it on recovery', async () => {
    const { f, claim, key } = await assigned();
    f.clock(T + 4000);
    const handoff = must(handoffFleetClaim({ id: claim.claim.id, agent: 'agent-a', lease: claim.lease, to: 'agent-b' }, f.options()));
    const nextKey = JSON.stringify(['ASSIGNED', REPO, claim.claim.id, 'agent-b', handoff.claim.claimedAt, HEAD]);
    f.failure(true); f.clock(T + 5000);
    expect(await f.pass()).toMatchObject({ planned: 1, sent: 0, failed: 1,
      deliveries: [{ state: 'ASSIGNED', threadKey: THREAD, dedupeKey: nextKey, result: 'failed' }] });
    expect(f.snapshot()).toMatchObject({ asOf: T + 3000, claims: [{ agent: 'agent-a' }] });
    expect(f.rows()).toEqual([{ v: 1, at: T + 3000, key }]);
    f.failure(false); f.clock(T + 2500);
    expect(await f.pass()).toMatchObject({ planned: 0, sent: 0, deliveries: [] });
    // The regressed snapshot has already absorbed the new owner, even though
    // its acquisition time is in the future relative to this snapshot.
    expect(f.snapshot()).toMatchObject({ asOf: T + 2500, claims: [{ agent: 'agent-b', claimedAt: T + 4000 }] });
    expect(f.rows()).toEqual([{ v: 1, at: T + 3000, key }]);
    expect(f.calls).toHaveLength(2);
    f.clock(T + 6000);
    const recovered = await f.pass();
    expect(recovered).toMatchObject({ planned: 1, sent: 1, failed: 0,
      deliveries: [{ state: 'ASSIGNED', threadKey: THREAD, dedupeKey: nextKey, result: 'sent' }] });
    expect(f.calls[2]).toMatchObject({ thread: THREAD, key: nextKey });
    expect(f.rows()).toEqual([{ v: 1, at: T + 3000, key }, { v: 1, at: T + 6000, key: nextKey }]);
    expect(f.snapshot()).toMatchObject({ asOf: T + 6000, claims: [{ agent: 'agent-b' }] });
    f.clock(T + 7000);
    expect(await f.pass()).toMatchObject({ planned: 0, sent: 0 });
    expect(f.calls).toHaveLength(3);
  });
});
