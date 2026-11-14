import { expect, it } from 'vitest';
import type { BusWorkClaimView } from '../src/core/fleet/bus-work-claims.js';
import { workItemEvidenceFromClaims } from '../src/core/comms/work-item-from-claims.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const claim = (o: Partial<BusWorkClaimView>): BusWorkClaimView =>
  ({ id: 'msg-1', cursor: 1, receivedAt: NOW - 60_000, owner: 'worker-a', leaseUntil: NOW + 60_000, completedAt: null, ...o });
const states = (cs: BusWorkClaimView[]) =>
  workItemEvidenceFromClaims(cs, NOW).map(e => classifyWorkItem(e, new Date(NOW).toISOString()));

it('a live lease is RUNNING', () => {
  const [e] = workItemEvidenceFromClaims([claim({})], NOW);
  expect(e).toMatchObject({ id: 'msg-1', owner: 'worker-a', claimReceipt: 'bus-claim:msg-1@1',
    runningEvidence: { source: 'bus-claim-lease', at: new Date(NOW).toISOString() } });
  expect(states([claim({})])[0]).toMatchObject({ state: 'RUNNING', source: 'bus-claim-lease' });
});

it('an expired lease is ASSIGNED with the claim receipt', () => {
  const [s] = states([claim({ cursor: 7, leaseUntil: NOW - 1 })]);
  expect(s).toMatchObject({ state: 'ASSIGNED', source: 'claim:bus-claim:msg-1@7' });
});

it('a completed claim is ASSIGNED, never VERIFIED', () => {
  const c = claim({ completedAt: NOW - 1000 });
  const [e] = workItemEvidenceFromClaims([c], NOW);
  expect(e!.verified).toBeUndefined();
  expect(e!.runningEvidence).toBeUndefined();
  expect(states([c])[0]!.state).toBe('ASSIGNED');
});

it('duplicate ids keep only the highest cursor', () => {
  const out = workItemEvidenceFromClaims([
    claim({ cursor: 9, owner: 'worker-b' }), claim({ cursor: 3, owner: 'worker-a', leaseUntil: NOW - 1 }),
  ], NOW);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ owner: 'worker-b', claimReceipt: 'bus-claim:msg-1@9' });
});

it('orders by receivedAt then id and never leaks a token', () => {
  const cs = [claim({ id: 'b', receivedAt: 5 }), claim({ id: 'a', receivedAt: 5 }), claim({ id: 'z', receivedAt: 1 })];
  const ids = (x: BusWorkClaimView[]) => workItemEvidenceFromClaims(x, NOW).map(e => e.id);
  expect(ids(cs)).toEqual(['z', 'a', 'b']);
  expect(ids([...cs].reverse())).toEqual(['z', 'a', 'b']);
  expect(JSON.stringify(workItemEvidenceFromClaims(cs, NOW))).not.toMatch(/[a-f0-9]{64}/);
});
