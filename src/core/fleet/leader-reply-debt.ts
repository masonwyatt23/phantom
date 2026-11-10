import { createHash } from 'node:crypto';
import type { InboxEntry } from './mason-inbox.js';
import { replyTime, type OutboxEntry } from './mason-outbox.js';

type Match = 'id' | 'time' | 'none';

/** Explicit references are `id:VALUE`, `request-hash:VALUE`, or `request_hash:VALUE`. */
function references(text: string): string[] {
  return [...text.matchAll(/\b(?:id|request[-_]hash)\s*[:=]\s*([A-Za-z0-9._:-]+)/gi)].map(m => m[1]!);
}

/** Compute debt from the available journal tails, without changing either journal. */
export function computeReplyDebt(inbox: InboxEntry[], outbox: OutboxEntry[], now: Date, opts: { graceMinutes?: number } = {}) {
  const grace = opts.graceMinutes ?? 30;
  const replies = outbox.map(entry => ({ at: replyTime(entry.at), refs: references(`${entry.heading ?? ''}\n${entry.text}`) }));
  const rows = inbox.flatMap(entry => {
    const text = entry.text.trim();
    // Exclude only sources explicitly identifying agents or handoffs; unknown sources remain visible.
    if (!text || /^--?[\w-]+$/.test(text) || /(?:^|[\s._-])(?:agent|handoff)(?:$|[\s._(-])/i.test(entry.channel ?? entry.source)) return [];
    const at = replyTime(entry.at);
    if (!Number.isFinite(at) || at > now.getTime()) return [];
    const hash = createHash('sha256').update(text).digest('hex');
    const ids = [entry.id, hash, ...references(text)].filter((id): id is string => Boolean(id));
    const later = replies.filter(reply => Number.isFinite(reply.at) && reply.at > at && reply.at <= now.getTime());
    const matchedBy: Match = later.some(reply => reply.refs.some(ref => ids.includes(ref))) ? 'id'
      : later.some(reply => reply.refs.length === 0) ? 'time' : 'none';
    return [{ entryId: entry.id ?? hash, at: entry.at, ageMinutes: Math.floor((now.getTime() - at) / 60000), source: entry.source, preview: text.slice(0, 120), matchedBy }];
  }).sort ( (a, b) => replyTime(a.at) - replyTime(b.at));
  const owed = rows.filter(row => row.matchedBy === 'none' && row.ageMinutes >= grace);
  return { owed, oldestAgeMinutes: owed[0]?.ageMinutes ?? null, sources: [...new Set(owed.map(row => row.source))], matches: rows.map(({ entryId, matchedBy }) => ({ entryId, matchedBy })) };
}
