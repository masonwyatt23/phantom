/**
 * Bounded exponential-backoff retry for `ashlr run`.
 *
 * Fully deterministic — no jitter, no nondeterminism.
 * Bounded by construction: never loops more than policy.maxAttempts times.
 * No runtime deps beyond Node built-ins.
 */

import type { RetryPolicy } from '../types.js';

/** Maximum backoff cap in ms — prevents degenerate waits on high maxAttempts. */
const MAX_DELAY_MS = 30_000;

/** Sleep without side effects. Await-able, resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with bounded exponential backoff.
 *
 * - `fn` receives the 1-based attempt number (1, 2, ..., maxAttempts).
 * - Retries ONLY while `isRetryable(err)` is true AND attempts < policy.maxAttempts.
 * - Backoff delay before retry N+1 = policy.baseDelayMs * 2^(N-1), capped at 30 s.
 *   (attempt 1 failure → 0 ms delay before attempt 2 when baseDelayMs is 0, else baseDelayMs).
 * - Rethrows the last error when attempts are exhausted or the error is non-retryable.
 * - Bounded by construction: NEVER loops more than policy.maxAttempts times.
 * - Snapshots and validates the policy before invoking either callback. Invalid
 *   attempt limits or delays reject with RangeError before work starts.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  isRetryable: (e: unknown) => boolean,
): Promise<T> {
  const { maxAttempts, baseDelayMs } = policy;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive safe integer');
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError('baseDelayMs must be finite and non-negative');
  }
  let delay = Math.min(baseDelayMs, MAX_DELAY_MS);

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt === maxAttempts || !isRetryable(err)) {
        throw err;
      }

      // Wait before the next attempt.
      if (delay > 0) {
        await sleep(delay);
      }
      // Saturating multiplication preserves zero delay even beyond 1,024
      // attempts, where computing 0 * 2 ** exponent would produce NaN.
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}
