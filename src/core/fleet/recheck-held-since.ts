/**
 * core/fleet/recheck-held-since.ts: how long the retained recheck log has held
 * the live verdict — the "Held: BLOCKED since <iso>" evidence behind
 * `ashlr fleet recheck --reply`, so a fresh gap can be told from one that has
 * persisted for a day. Pure projection over the newest-first RecheckRecord
 * rows readRecheckRecords already returns: no I/O, no clock reads.
 *
 * Walking newest-first, the consecutive run of rows whose overall state equals
 * the live verdict is the recorded hold; the oldest row's asOf is the since
 * bound, and a run that consumes the whole retained window is marked truncated
 * because the state may be older than what was read. A row with an
 * unparseable asOf ends the run without joining it — a bad timestamp is not
 * hold evidence.
 */
import type { RecheckRecord } from './recheck-record.js';

export interface RecheckHeld {
  /** The held verdict — the `current` state the run was counted against. */
  state: string;
  /** asOf of the oldest row in the run: the earliest recorded hold bound. */
  since: string;
  /** Consecutive recorded checks holding `state`, counting newest-first. */
  consecutive: number;
  /** True when the run reached the end of the retained window. */
  truncated: boolean;
}

/**
 * Count the newest-first run of rows with `overall === current`. Returns null
 * when there is no recorded evidence for the live verdict: an empty window,
 * the newest row already differing from `current`, or the run's first row
 * carrying an unparseable asOf.
 */
export function recheckHeldSince(rows: RecheckRecord[], current: string): RecheckHeld | null {
  let consecutive = 0;
  let since: string | null = null;
  for (const row of rows) {
    if (row.overall !== current || !Number.isFinite(Date.parse(row.asOf))) break;
    consecutive += 1;
    since = row.asOf;
  }
  if (consecutive === 0 || since === null) return null;
  return { state: current, since, consecutive, truncated: consecutive === rows.length };
}
