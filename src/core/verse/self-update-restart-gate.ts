/**
 * core/verse/self-update-restart-gate.ts — the QUIET-TURN gate for Hub
 * self-update restarts.
 *
 * A supervised desktop self-update ends with `scheduleRestart` SIGTERMing
 * this sidecar. Fired the moment the apply route answers, that signal
 * lands in the middle of any chat turn still streaming — the operator's
 * reply is cut off. `waitForQuietTurns` defers the SIGTERM until no verse
 * turn is in flight, bounded by a hard ceiling so an update can never be
 * held hostage by a stuck turn.
 *
 * The count is process-local and advisory: session-engine.ts marks a turn
 * in flight where it marks the chat busy (`turnStatuses`), and releases it
 * at the same terminal markers — a turn that ends while the apply route is
 * still running simply shortens the wait. Engine instances share the one
 * counter because the restart kills the one process.
 *
 * WHY THE RE-EXPORT. `beginVerseTurn`/`activeVerseTurns` are defined in
 * session-engine.ts: the engine is a member of the Tier-1 authority import
 * closure, so its runtime imports may only name modules already inside that
 * closure — a static import of THIS file would grow it, and the protected
 * snapshot (test/fixtures/authority/tier1-closure.json) accepts new members
 * only on a reviewed regeneration. ops-api.ts sits outside the closure and
 * imports this module freely, so the documented surface stays whole here.
 *
 * STABLE SURFACE (bridge contract): beginVerseTurn, activeVerseTurns,
 * waitForQuietTurns.
 */
import { activeVerseTurns } from './session-engine.js';

export { activeVerseTurns, beginVerseTurn } from './session-engine.js';

export interface WaitForQuietTurnsOptions {
  /** In-flight reader; defaults to the real counter. A throwing reader counts as 0. */
  active?: () => number;
  /** Hard ceiling on the defer. Default 120 s — long enough for a reply, short enough to never strand an update. */
  maxWaitMs?: number;
  /** Poll interval. Default 1 s. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface QuietTurnsResult {
  waitedMs: number;
  activeAtEnd: number;
  /** True when the ceiling was reached with turns still in flight. */
  timedOut: boolean;
}

/**
 * Resolve as soon as `active()` reads 0 — at once when nothing is running —
 * or when `maxWaitMs` has elapsed, whichever comes first. Never throws and
 * never rejects: a throwing `active` reads as 0, and the final sleep is
 * capped at the remaining budget so the resolve lands on the ceiling.
 */
export async function waitForQuietTurns(opts: WaitForQuietTurnsOptions = {}): Promise<QuietTurnsResult> {
  const read = opts.active ?? activeVerseTurns;
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const count = (): number => {
    try {
      const n = read();
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  const started = now();
  let inFlight = count();
  let remaining = maxWaitMs - (now() - started);
  while (inFlight > 0 && remaining > 0) {
    await sleep(Math.min(pollMs, remaining));
    inFlight = count();
    remaining = maxWaitMs - (now() - started);
  }
  return { waitedMs: Math.max(0, now() - started), activeAtEnd: count(), timedOut: inFlight > 0 };
}
