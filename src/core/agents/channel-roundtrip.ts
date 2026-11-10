/**
 * Channel test-send round-trip state (RQ-PHX-CHANNELTESTSEND97).
 *
 * Pure projection for the Channels pane's "Test round trip" action: given the
 * recorded send time and the inbound timestamps the existing owner-channel
 * intake already logs, decide what the row says — still waiting, answered
 * (and in how long), or unanswered past the window. No I/O, no clock reads:
 * callers pass `now` so the same inputs always give the same answer.
 */

/** Once a send is this old with no inbound owner message, waiting is over. */
export const CHANNEL_ROUNDTRIP_TIMEOUT_MS = 30 * 60 * 1000;

export type ChannelRoundTrip =
  /** No send has been recorded, or the send time is unusable. */
  | { state: 'idle' }
  /** Sent and inside the reply window with no inbound yet. `ageMs` is now - sentAt, clamped at 0. */
  | { state: 'waiting'; sentAt: number; ageMs: number }
  /** An inbound owner message landed after the send. `latencyMs` is its delay. */
  | { state: 'ok'; sentAt: number; latencyMs: number }
  /** The reply window elapsed with no inbound owner message. */
  | { state: 'silent'; sentAt: number; ageMs: number };

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Project the row's round-trip line.
 *
 * `sentAt` is the epoch-ms the test send was recorded at; anything that is not
 * a usable epoch-ms (absent, non-integer, negative) means "no pending send"
 * and projects idle. `inbound` is the channel's inbound owner-message times in
 * epoch-ms, any order, and may carry unusable entries — they are ignored. The
 * first usable inbound STRICTLY after `sentAt` completes the trip; a reply
 * cannot precede its send, and a same-timestamp entry is ambiguous, so it is
 * not a reply. Completion is permanent: once answered, the state stays `ok`
 * and its fixed latency no matter how old the trip gets.
 */
export function channelRoundTrip(sentAt: unknown, inbound: readonly unknown[], now: number): ChannelRoundTrip {
  if (!usable(sentAt)) return { state: 'idle' };
  let first: number | undefined;
  for (const entry of inbound) {
    if (usable(entry) && entry > sentAt && (first === undefined || entry < first)) first = entry;
  }
  if (first !== undefined) return { state: 'ok', sentAt, latencyMs: first - sentAt };
  const ageMs = Math.max(0, now - sentAt);
  return ageMs >= CHANNEL_ROUNDTRIP_TIMEOUT_MS
    ? { state: 'silent', sentAt, ageMs }
    : { state: 'waiting', sentAt, ageMs };
}
