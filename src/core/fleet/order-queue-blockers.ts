/** Parked-queue evidence for the BLOCKED state of `fleet order-state`
 * (RQ-PHX-ORDERBLOCKEDQUEUE362). `readFleetQueue()` already knows which
 * waiting jobs are parked and, for DEPENDENCY GATE parks, which gate ids are
 * not yet MERGED. This maps that snapshot to job id -> blocker text.
 *
 * Pure: no I/O, no clock. Honesty bounds:
 * - only a healthy ready.tsv proves anything; degraded or missing -> null;
 * - `groups[].jobs` is capped at 8 per group and `unmetDeps` at 50 rows, so
 *   absence from `byJob` means "not known blocked", never "unblocked";
 * - the text is built only from job ids and parked reason/lane tokens that
 *   pass the same shapes the queue reader enforces, never from prompt prose. */
import type { FleetQueueV1 } from './runs-parked-queue.js';

export interface QueueBlockers { at: string; byJob: ReadonlyMap<string, string> }

/** Same shapes the queue reader accepts (runs-parked-queue.ts JOB_ID / PARKED). */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REASON = /^[A-Za-z0-9_-]{1,64}$/;
const LANE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const DEP_REASON = /^(?:DEP|DEPENDENCY)$/i;
const MAX_IDS = 5;

function unmergedText(ids: readonly string[]): string | null {
  const safe = [...new Set(ids.filter((id) => JOB_ID.test(id)))];
  if (safe.length === 0) return null;
  const shown = safe.slice(0, MAX_IDS).join(', ');
  const more = safe.length > MAX_IDS ? ` +${safe.length - MAX_IDS} more` : '';
  return `unmerged dependency: ${shown}${more}`;
}

export function queueBlockers(queue: FleetQueueV1): QueueBlockers | null {
  if (queue.sources.ready !== 'healthy') return null;
  const byJob = new Map<string, string>();
  for (const row of queue.unmetDeps ?? []) {
    if (!JOB_ID.test(row.job) || byJob.has(row.job)) continue;
    const text = unmergedText(row.unmet);
    if (text !== null) byJob.set(row.job, text);
  }
  for (const group of queue.groups) {
    if (DEP_REASON.test(group.reason) || !REASON.test(group.reason)) continue;
    const lane = group.lane !== null && LANE.test(group.lane) ? ` (lane ${group.lane})` : '';
    const text = `parked: ${group.reason.toUpperCase()}${lane}`;
    for (const job of group.jobs) if (JOB_ID.test(job) && !byJob.has(job)) byJob.set(job, text);
  }
  return { at: queue.generatedAt, byJob };
}
