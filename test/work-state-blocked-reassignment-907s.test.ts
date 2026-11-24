import { describe, expect, it } from 'vitest';
import { classifyWorkState, type WorkEvidence } from '../src/core/comms/work-state-contract.js';
import { decideWorkStatePublish } from '../src/core/comms/work-state-publish.js';

const now = new Date('2026-11-24T12:00:00Z');
const base: WorkEvidence = {
  receivedAt: '2026-11-24T11:00:00Z', source: 'test', blocker: 'waiting on fake dependency',
  owner: 'fake-owner-a', claimReceipt: 'fake-claim-a',
};
const classify = (changes: Partial<WorkEvidence> = {}, at = now) => classifyWorkState({ ...base, ...changes }, at);
// The classifier omits assignments for BLOCKED. Model a caller explicitly retaining
// the classifier's existing assignment reason; this is not an end-to-end caller.
function enriched(changes: Partial<WorkEvidence> = {}, at = now) {
  const evidence = { ...base, ...changes };
  const blocked = classifyWorkState(evidence, at);
  const assigned = classifyWorkState({ ...evidence, blocker: undefined }, at);
  const reason = assigned.reasons.find((entry) => entry.startsWith('owner ') && entry.includes(', claim '));
  return { ...blocked, reasons: reason ? [...blocked.reasons, reason] : blocked.reasons };
}

describe('blocked assignment publication', () => {
  it.each([
    { owner: 'fake-owner-b' }, { claimReceipt: 'fake-claim-b' },
    { owner: 'fake-owner-b', claimReceipt: 'fake-claim-b' },
  ])('publishes a changed known assignment: %o', (changes) => {
    const previous = enriched();
    const next = enriched(changes);
    const copies = structuredClone([previous, next]);
    expect(decideWorkStatePublish(previous, next)).toEqual({ publish: true, reason: 'assignment changed' });
    expect([previous, next]).toEqual(copies);
  });

  it('ignores identical assignments, heartbeat, asOf and reason order drift', () => {
    const previous = enriched({ liveEvidenceAt: '2026-11-24T11:58:00Z', artifact: { pr: 1 } });
    const next = enriched({ owner: ' fake-owner-a ', claimReceipt: ' fake-claim-a ', liveEvidenceAt: '2026-11-24T11:59:00Z', artifact: { pr: 1 } }, new Date('2026-11-24T12:01:00Z'));
    next.reasons.reverse();
    expect(decideWorkStatePublish(previous, next)).toEqual({ publish: false, reason: 'no meaningful change (BLOCKED)' });
  });

  it('does not infer reassignment from missing, incomplete or ambiguous reasons on either side', () => {
    const known = enriched({ owner: 'fake-owner-b' });
    const bare = classify();
    const incomplete = { ...bare, reasons: [...bare.reasons, 'owner fake-owner-a, claim  '] };
    const ambiguous = { ...enriched(), reasons: [...enriched().reasons, 'owner fake-owner-c, claim fake-claim-c'] };
    for (const unknown of [bare, incomplete, ambiguous]) {
      for (const [before, after] of [[unknown, known], [known, unknown]]) {
        expect(decideWorkStatePublish(before, after)).toEqual({ publish: false, reason: 'no meaningful change (BLOCKED)' });
      }
    }
    expect(classify().reasons).toEqual(['blocked: waiting on fake dependency']);
    expect(decideWorkStatePublish(classify(), classify({ owner: 'fake-owner-b' })).publish).toBe(false);
  });

  it('prioritizes blocker changes over reassignment', () => {
    expect(decideWorkStatePublish(enriched(), enriched({ blocker: 'another fake dependency', owner: 'fake-owner-b' })))
      .toEqual({ publish: true, reason: 'blocker changed' });
  });

  it('retains VERIFIED artifact behavior', () => {
    const verified = (pr: number) => classify({ artifact: { pr, head: 'fake-head', testsPassed: true } });
    expect(decideWorkStatePublish(verified(1), verified(1))).toEqual({ publish: false, reason: 'no meaningful change (VERIFIED)' });
    expect(decideWorkStatePublish(verified(1), verified(2))).toEqual({ publish: true, reason: 'artifact changed' });
  });
});
