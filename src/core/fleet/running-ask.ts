/** Exact, short owner "running" asks: answered in-thread with the claim-
 * execution evidence reply (claim-execution-reply.ts) — which live claims a
 * worker is actually RUNNING, which are CLAIMED with no live worker, and
 * which are UNKNOWN. Anything longer, such as "what is running on PR #12",
 * stays a request for the Leader, and "what's running" stays a status ask
 * (status-ask.ts) — it is deliberately not matched here. Normalization
 * matches owners-ask.ts: trim, ≤40 chars, case-insensitive, curly
 * apostrophes folded, trailing ?.! dropped. */
export function isRunningAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:running|claims|who(?:'s| is) running|claims running|execution)$/.test(ask);
}
