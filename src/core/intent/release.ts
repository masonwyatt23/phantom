/**
 * Persistent release evidence for intent directives, recovered from PR #4235's
 * noteShippedRelease against the current store and pure matcher. It records
 * caller-supplied release evidence only; it never proves publication or
 * verification.
 *
 * The read-match-write runs inside transactIntentLedger so a release note
 * cannot be lost against a concurrent addIntent/updateIntent/import on the
 * same ledger. When nothing matches, the transaction is aborted before its
 * write: no ledger file is created for a missing store and persisted bytes
 * stay untouched, matching the pre-transaction contract.
 */
import { markShipped, type EvidenceStatus, type ShippedReleaseNote } from './evidence.js';
import { transactIntentLedger } from './store.js';

export interface NoteShippedReleaseOptions {
  /** Runs directory override, as accepted by the intent store. */
  root?: string;
  /** Evidence timestamp; wins over `release.at`, which wins over the current time. */
  now?: string;
}

export interface NoteShippedReleaseResult {
  updated: number;
  matches: { id: string; status: EvidenceStatus }[];
}

/** Thrown inside the transaction to skip writeLedger when no directive matched. */
const NO_MATCH = new Error('intent release matched no directives');

/** Record the release on matching directives inside the ledger transaction. */
export async function noteShippedRelease(release: ShippedReleaseNote, opts: NoteShippedReleaseOptions = {}): Promise<NoteShippedReleaseResult> {
  try {
    return await transactIntentLedger(opts.root, (ledger) => {
      const matched = markShipped(ledger, release, opts.now ?? release.at ?? new Date().toISOString());
      if (matched.length === 0) throw NO_MATCH;
      return { updated: matched.length, matches: matched.map(({ id, status }) => ({ id, status })) };
    });
  } catch (error) {
    if (error === NO_MATCH) return { updated: 0, matches: [] };
    throw error;
  }
}
