/**
 * Link MASON-INBOX correction entries to the entries they supersede, so the
 * planner brief marks a corrected order instead of letting passes act on the
 * stale text (Mason's t1632u/t1634u corrections went out as separate inbox
 * entries that read as unrelated orders). Pure: no I/O, no fleet imports.
 */

/** Entry ids appendInboxEntry assigns: `<channel slug or 'desk'>-<16 hex>`. */
export const INBOX_ENTRY_ID = /^[a-z0-9]{1,16}-[0-9a-f]{16}$/;
/** Id form: `CORRECTION to desk-0123456789abcdef: use the other phrasing`. */
export const CORRECTION_TO_ID = /^CORRECTION to ([a-z0-9]{1,16}-[0-9a-f]{16}):(?: |$)/;
/** Bare form: `CORRECTION:` / `CORRECTION to the t1632u note` / `CORRECTION 2`. */
export const CORRECTION_BARE = /^CORRECTION(?::| to| 2| )/;
/** A bare correction reaches at most this far back for its target. */
export const CORRECTION_WINDOW_MS = 30 * 60 * 1000;

export interface InboxCorrectionInput {
  /** Caller-chosen identity; the returned map keys and links use it. */
  key: string;
  /** The `[src:<channel>]` slug; absent on `## ET` heading entries. */
  channel?: string;
  atMs: number;
  /** The `id:<entryId>` tag when the entry carries one. */
  id?: string;
  /** Entry text after its channel-line prefix or heading. */
  text: string;
}

export interface InboxCorrectionLink {
  /** On a correction entry: key of the entry it supersedes. */
  corrects?: string;
  /** On a corrected entry: key of the newest correction targeting it. */
  correctedBy?: string;
}

/**
 * Resolve each correction entry to its target. Id-form corrections target the
 * entry carrying that id (unknown id: unresolved); bare corrections target the
 * nearest earlier entry on the same `src:` channel inside the window. Nothing
 * else matches — a mid-sentence "correction" or a non-anchor `CORRECTIONS` is
 * an ordinary entry. Corrections are themselves valid targets, so chains link.
 */
export function linkCorrections(entries: InboxCorrectionInput[]): Map<string, InboxCorrectionLink> {
  const links = new Map<string, InboxCorrectionLink>();
  const byId = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.id !== undefined && !byId.has(entry.id)) byId.set(entry.id, index);
  });
  const link = (key: string): InboxCorrectionLink => {
    const existing = links.get(key);
    if (existing) return existing;
    const created: InboxCorrectionLink = {};
    links.set(key, created);
    return created;
  };
  entries.forEach((entry, index) => {
    const text = entry.text.trimStart();
    let target: number | undefined;
    const idMatch = CORRECTION_TO_ID.exec(text);
    if (idMatch) {
      const found = byId.get(idMatch[1]!);
      if (found !== undefined && found !== index) target = found;
    } else if (CORRECTION_BARE.test(text) && entry.channel !== undefined) {
      for (let j = index - 1; j >= 0; j--) {
        const candidate = entries[j]!;
        if (candidate.channel !== entry.channel) continue;
        const age = entry.atMs - candidate.atMs;
        if (!Number.isFinite(age) || age < 0 || age > CORRECTION_WINDOW_MS) continue;
        target = j;
        break;
      }
    } else {
      return;
    }
    if (target === undefined) return;
    link(entry.key).corrects = entries[target]!.key;
    link(entries[target]!.key).correctedBy = entry.key;
  });
  return links;
}
