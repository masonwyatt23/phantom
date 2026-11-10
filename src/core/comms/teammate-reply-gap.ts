/**
 * RQ-PHX-DOTREPLYGAP09: how long has a teammate text (Dot / "Ashlr.") waited
 * for a reply? Metadata only: no bodies, no handles or sender ids, only a
 * display label and timestamps. Reads nothing and sends nothing.
 */
import { readRows } from './imessage-teammate-inbox.js';

export interface ReplyGapEvent { teammate: string; direction: 'inbound' | 'outbound'; at: number }
export interface TeammateReplyGap {
  teammate: string;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  unansweredCount: number;
  oldestUnansweredMs: number;
  state: 'ok' | 'late' | 'unknown';
}

/** `events` is null when there is no evidence source: the answer is then `unknown`, never `ok`. */
export function teammateReplyGap(events: readonly ReplyGapEvent[] | null, now: number, opts: { warnAfterMs?: number } = {}): TeammateReplyGap[] {
  const warnAfterMs = opts.warnAfterMs ?? 5 * 60_000;
  if (events === null) return [{ teammate: 'Teammates', lastInboundAt: null, lastOutboundAt: null, unansweredCount: 0, oldestUnansweredMs: 0, state: 'unknown' }];
  const byTeammate = new Map<string, ReplyGapEvent[]>();
  for (const event of events) {
    if (!Number.isFinite(event.at)) continue;
    byTeammate.set(event.teammate, [...(byTeammate.get(event.teammate) ?? []), event]);
  }
  return [...byTeammate].map(([teammate, rows]) => {
    const at = (direction: ReplyGapEvent['direction']) => rows.filter(row => row.direction === direction).map(row => row.at);
    const inbound = at('inbound');
    const lastInboundAt = inbound.length ? Math.max(...inbound) : null;
    const outbound = at('outbound');
    const lastOutboundAt = outbound.length ? Math.max(...outbound) : null;
    const waiting = inbound.filter(time => lastOutboundAt === null || time > lastOutboundAt);
    const oldestUnansweredMs = waiting.length ? Math.max(0, now - Math.min(...waiting)) : 0;
    return { teammate, lastInboundAt, lastOutboundAt, unansweredCount: waiting.length, oldestUnansweredMs,
      state: waiting.length && oldestUnansweredMs >= warnAfterMs ? 'late' as const : 'ok' as const };
  }).sort((a, b) => a.teammate.localeCompare(b.teammate));
}

/** Read one inbox snapshot. Labels are anonymous; marker scope is a single row. */
export function teammateReplyGapFromInbox(now: number, runsDir?: string, _labels: Readonly<Record<string, string>> = {}): TeammateReplyGap[] {
  const { rows, state } = readRows(runsDir);
  if (state === 'missing') return teammateReplyGap(null, now);
  const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const answered = new Map<number, number | null>();
  let degraded = state !== 'healthy';
  for (const row of rows) {
    if (validId(row.answered)) {
      const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
      if (!answered.has(row.answered)) answered.set(row.answered, Number.isFinite(at) ? at : null);
    } else if (!validId(row.rowid) || typeof row.senderId !== 'string' || !row.senderId ||
      typeof row.text !== 'string' || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) {
      degraded = true;
    }
  }
  const groups = new Map<string, { inbound: number[]; open: number[]; outbound: number[] }>();
  const seen = new Set<number>();
  for (const row of rows) {
    if (!validId(row.rowid) || typeof row.senderId !== 'string' || !row.senderId ||
      typeof row.text !== 'string' || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) continue;
    if (seen.has(row.rowid)) { degraded = true; continue; }
    seen.add(row.rowid);
    const group = groups.get(row.senderId) ?? { inbound: [], open: [], outbound: [] };
    const at = Date.parse(row.at);
    group.inbound.push(at);
    if (answered.has(row.rowid)) group.outbound.push(answered.get(row.rowid) ?? at);
    else group.open.push(at);
    groups.set(row.senderId, group);
  }
  const result: TeammateReplyGap[] = [...groups.values()].map((group, index) => {
    const age = group.open.length ? Math.max(0, now - Math.min(...group.open)) : 0;
    return {
      teammate: `Teammate ${index + 1}`,
      lastInboundAt: Math.max(...group.inbound),
      lastOutboundAt: group.outbound.length ? Math.max(...group.outbound) : null,
      unansweredCount: group.open.length,
      oldestUnansweredMs: age,
      state: degraded ? 'unknown' : group.open.length && age >= 5 * 60_000 ? 'late' : 'ok',
    };
  });
  if (degraded && !result.length) return teammateReplyGap(null, now);
  return result;
}
