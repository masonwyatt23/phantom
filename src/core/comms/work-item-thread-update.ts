/** Thread-update decision for the Nov12 22:30 ET acceptance contract: publish
 * only meaningful assignment/blocker/verification changes in the task thread,
 * using RECEIVED/ASSIGNED/RUNNING/BLOCKED/VERIFIED accurately. Pure: no I/O
 * and no clock. `postedAt` is taken from `next.asOf` (the evidence time, not
 * the send time), so the same inputs always yield the same record. */
import { scrubSecrets } from '../util/scrub.js';
import type { WorkItemClassification, WorkItemState } from './work-item-state.js';

/** Last state published to a thread (Nov12 22:30 ET contract). The caller
 * persists it and passes it back as `prev`. */
export interface PostedThreadState { id: string; state: WorkItemState; source: string; postedAt: string }

/** Hard cap on a thread line, in characters. */
export const THREAD_LINE_MAX = 280;

const STALE_RUNNING = 'fresh running evidence';

/** One-line ASCII text for a thread post (Nov12 22:30 ET contract). */
function formatLine(id: string, c: WorkItemClassification, stale: boolean): string {
  const missing = stale && !c.missing.includes(STALE_RUNNING) ? [...c.missing, STALE_RUNNING] : c.missing;
  const raw = `[${c.state}] ${id} as-of ${c.asOf} via ${c.source}${missing.length ? ` missing: ${missing.join(', ')}` : ''}`;
  const ascii = raw.replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '?');
  return scrubSecrets(ascii).slice(0, THREAD_LINE_MAX);
}

/** Decide whether a thread update is warranted (Nov12 22:30 ET contract).
 * Throws TypeError when `prev.id` differs from `next.id`. */
export function decideThreadUpdate(
  prev: PostedThreadState | undefined,
  next: { id: string } & WorkItemClassification,
): { post: false; reason: string } | { post: true; line: string; record: PostedThreadState } {
  if (prev && prev.id !== next.id) {
    throw new TypeError(`thread state id mismatch: prev=${prev.id} next=${next.id}`);
  }
  const go = (stale: boolean) => ({
    post: true as const,
    line: formatLine(next.id, next, stale),
    record: { id: next.id, state: next.state, source: next.source, postedAt: next.asOf },
  });
  if (!prev) return go(false);
  if (prev.state === 'VERIFIED') return { post: false, reason: 'already-verified' };
  if (prev.state === next.state) {
    if (prev.source === next.source) return { post: false, reason: 'unchanged' };
    if (next.state === 'RUNNING') return { post: false, reason: 'heartbeat' };
    if (next.state === 'RECEIVED') return { post: false, reason: 'unchanged' };
    return go(false); // new claim receipt or new blocker evidence
  }
  if (next.state === 'RECEIVED') return { post: false, reason: 'regression' };
  return go(prev.state === 'RUNNING' && next.state === 'ASSIGNED');
}
