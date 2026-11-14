/** Maps durable bus work claims onto WorkItemEvidence so `classifyWorkItem`
 * can report on real claims. Pure: no I/O, no clock (caller passes `nowMs`).
 * The fencing token never reaches this module; the receipt names id@cursor only. */
import type { BusWorkClaimView } from '../fleet/bus-work-claims.js';
import type { WorkItemEvidence } from './work-item-state.js';

/**
 * One evidence item per claim id (highest cursor wins when an id was
 * re-acquired). A live, uncompleted lease is running evidence; an expired
 * lease leaves the item ASSIGNED (owned, not proven running).
 *
 * A completed claim is deliberately NOT emitted as `verified`: completion is
 * the claimant's word, not a PR/head/tests artifact, so it stays ASSIGNED and
 * no evidence is invented for it.
 */
export function workItemEvidenceFromClaims(claims: BusWorkClaimView[], nowMs: number): WorkItemEvidence[] {
  const latest = new Map<string, BusWorkClaimView>();
  for (const c of claims) {
    const prev = latest.get(c.id);
    if (!prev || c.cursor > prev.cursor) latest.set(c.id, c);
  }
  return [...latest.values()]
    .sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(c => {
      const e: WorkItemEvidence = {
        id: c.id,
        receivedAt: new Date(c.receivedAt).toISOString(),
        owner: c.owner,
        claimReceipt: `bus-claim:${c.id}@${c.cursor}`,
      };
      if (c.completedAt === null && c.leaseUntil > nowMs) {
        e.runningEvidence = { source: 'bus-claim-lease', at: new Date(nowMs).toISOString() };
      }
      return e;
    });
}
