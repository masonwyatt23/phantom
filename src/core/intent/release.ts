/**
 * Persistent release evidence for intent directives, recovered from PR #4235's
 * noteShippedRelease against the current store and pure matcher. It records
 * caller-supplied release evidence only; it never proves publication or
 * verification.
 */
import { markShipped, type EvidenceStatus, type ShippedReleaseNote } from './evidence.js';
import { readLedger, writeLedger } from './store.js';

export interface NoteShippedReleaseOptions {
  /** Runs directory override, as accepted by the intent store. */
  root?: string;
  /** Evidence timestamp; wins over `release.at`, which wins over the current time. */
  now?: string;
}

export interface NoteShippedReleaseResult {
  /** Number of matching directives, including those with an existing receipt. */
  updated: number;
  matches: { id: string; status: EvidenceStatus }[];
}

/** Return all matches; persist only directives without this normalized release receipt. */
export async function noteShippedRelease(release: ShippedReleaseNote, opts: NoteShippedReleaseOptions = {}): Promise<NoteShippedReleaseResult> {
  const ledger = await readLedger(opts.root);
  // Run the pure matcher on a copy so validation and matching retain its contract,
  // while existing receipts leave the original directive completely untouched.
  const candidate = structuredClone(ledger);
  const matched = markShipped(candidate, release, opts.now ?? release.at ?? new Date().toISOString());
  const ref = release.release.replace(/[\r\n]+/g, ' ').trim();
  let changed = false;
  for (const item of matched) {
    const index = ledger.items.findIndex((original) => original.id === item.id);
    const original = ledger.items[index]!;
    if (original.evidence.some((row) => row.kind === 'release' && row.ref.replace(/[\r\n]+/g, ' ').trim() === ref)) continue;
    ledger.items[index] = item;
    changed = true;
  }
  if (changed) await writeLedger(ledger, opts.root);
  return { updated: matched.length, matches: matched.map(({ id }) => {
    const item = ledger.items.find((original) => original.id === id)!;
    return { id, status: item.status };
  }) };
}
