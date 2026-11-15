/** Proactive claim notices for `phm channels slack run` (Nov12/13 Slack
 * coordination orders): each loop iteration may run one claim-notice pass,
 * at most once per interval, with no overlapping passes. The pass only appends `kind: 'note'` bus
 * envelopes; the run loop's own `listBusInboxAfter` drain delivers them
 * through `deliverSlackEnvelope`, so audience, confirmedByMason and policy
 * gates stay exactly where they were. KILL halts the pass like every other
 * outward channel. The tick never throws: a failed pass retries next interval. */
import { claimNoticePassDeps } from './fleet-claim-notices.js';
import { runClaimNoticePass, type ClaimNoticePassResult } from '../core/fleet/claim-notice-send.js';
import { killSwitchOn } from '../core/sandbox/policy.js';

export const CLAIM_NOTICE_TICK_INTERVAL_MS = 30_000;

export type ClaimNoticeTickOutcome =
  /** `deduped` is the pass result's `skipped` (notices already fenced by the sent ledger). */
  | { ran: true; sent: number; deduped: number; failed: number }
  | { ran: true; sent: number; deduped: number; failed: number;
      status: 'board-unavailable' | 'ledger-unavailable'; reason: string }
  | { ran: true; sent: number; deduped: number; failed: number; status: 'dry-run' }
  | { ran: false; reason: 'interval' | 'in-flight' | 'kill-switch' | 'pass-error' | 'aborted' };

export interface ClaimNoticeTick {
  /** Runs a pass when the interval has elapsed. An aborted `signal` resolves
   * immediately so a bounded stop never waits on an in-flight pass. */
  maybeRun(signal?: AbortSignal): Promise<ClaimNoticeTickOutcome>;
}

/** Resolves `null` when `signal` aborts before `settled` resolves. The abort
 * listener is removed on either settlement, and the promise derived from
 * `settled` is consumed with a rejection handler, so a late pass failure can
 * never surface as an unhandled rejection after the caller has left. */
function raceAbort<T>(settled: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = (): void => resolve(null);
    const done = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const tracked = settled.then(
      value => { done(); resolve(value); },
      error => { done(); reject(error); },
    );
    // The handlers above never throw and `settled` carries the pass outcome,
    // but consume any surprise rejection so no derived promise floats.
    void tracked.catch(() => {});
  });
}

export function createClaimNoticeTick(opts: {
  intervalMs?: number;
  now?: () => number;
  pass?: () => Promise<ClaimNoticePassResult>;
  killed?: () => boolean;
} = {}): ClaimNoticeTick {
  const intervalMs = opts.intervalMs ?? CLAIM_NOTICE_TICK_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const pass = opts.pass ?? (() => runClaimNoticePass(claimNoticePassDeps()));
  const killed = opts.killed ?? killSwitchOn;
  let lastAt: number | undefined;
  let inFlight = false;
  return {
    async maybeRun(signal) {
      if (signal?.aborted) return { ran: false, reason: 'aborted' };
      if (inFlight) return { ran: false, reason: 'in-flight' };
      const at = now();
      if (lastAt !== undefined && at - lastAt < intervalMs) return { ran: false, reason: 'interval' };
      // The attempt (not its success) starts the interval, so a failing or
      // KILLed pass is retried next interval rather than on every loop turn.
      lastAt = at;
      try {
        if (killed()) return { ran: false, reason: 'kill-switch' };
        // The underlying pass owns this guard, even if its caller aborts.
        // Defer invocation so synchronous throws also release the guard.
        inFlight = true;
        const running = Promise.resolve().then(pass).finally(() => { inFlight = false; });
        // `settled` never rejects: a pass failure becomes an outcome, so a
        // caller that already aborted cannot leave a derived rejection
        // unhandled when the pass fails later.
        const settled = running.then(
          value => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        );
        const outcome = signal === undefined ? await settled : await raceAbort(settled, signal);
        if (outcome === null) return { ran: false, reason: 'aborted' };
        if (!outcome.ok) return { ran: false, reason: 'pass-error' };
        const result = outcome.value;
        const counts = { ran: true as const, sent: result.sent, deduped: result.skipped, failed: result.failed };
        // These fixed codes keep arbitrary dependency errors out of the outcome.
        if (result.status === 'board-unavailable') {
          return { ...counts, status: result.status, reason: 'board-state-unknown' };
        }
        if (result.status === 'ledger-unavailable') {
          return { ...counts, status: result.status, reason: 'sent-ledger-unreadable' };
        }
        if (result.status === 'dry-run') return { ...counts, status: result.status };
        return counts;
      } catch {
        return { ran: false, reason: 'pass-error' };
      }
    },
  };
}
