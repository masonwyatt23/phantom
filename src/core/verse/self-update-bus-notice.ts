/** Best-effort notification of Hub self-updates on the shared fleet bus. */
import { appendBusInbox, type BusInboxPost } from '../fleet/bus-inbox.js';
import type { BusEnvelope } from '../fleet/bus-envelope.js';
import { fleetBusEventId } from '../fleet/bus-mirror-dispatch.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import type { SelfUpdateApplyResult } from './self-update-apply.js';

export const SELF_UPDATE_BUS_KIND = 'self-update-applied';

/** `abc1234` for display; never more than a prefix, never a step note. */
function shortCommit(commit: string | null): string {
  return (commit ?? 'unknown').slice(0, 7);
}

export function buildSelfUpdateEnvelope(result: SelfUpdateApplyResult): BusEnvelope {
  const text = `Phantom updated ${shortCommit(result.fromCommit)} -> ${shortCommit(result.toCommit)}; restart ${result.restart.mode}`.slice(0, 200);
  return {
    id: fleetBusEventId(SELF_UPDATE_BUS_KIND, result.finishedAt, result.toCommit ?? 'unknown'),
    from: 'fleet', to: 'all', priority: 'P2', ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: SELF_UPDATE_BUS_KIND, at: result.finishedAt,
      fromCommit: result.fromCommit, toCommit: result.toCommit,
      restartRequired: result.restart.required, restartMode: result.restart.mode,
      text,
    },
  };
}

export type SelfUpdateBusPost = { status: BusInboxPost['status'] | 'skipped' };

/** Only an `updated` apply is news; every transport failure reads `unavailable`. */
export function postSelfUpdateNotice(
  result: SelfUpdateApplyResult,
  post: typeof appendBusInbox = appendBusInbox,
  options?: { root?: string; now?: () => number },
): SelfUpdateBusPost {
  if (result.outcome !== 'updated') return { status: 'skipped' };
  try {
    return { status: post(buildSelfUpdateEnvelope(result), options).status };
  } catch {
    return { status: 'unavailable' };
  }
}
