/**
 * routes/verse/fleet-board/order-state-model.ts — pure model for the "Your orders"
 * strip: each order Mason typed (desktop, Slack, iMessage) and whether it is
 * RECEIVED, ASSIGNED, RUNNING, BLOCKED or VERIFIED.
 *
 * The body shape of GET /api/verse/fleet/work-board/orders is declared here on
 * purpose (the web bundle must not import src/core). Anything that does not
 * parse is "unavailable", never "no orders".
 */
export const ORDER_STATES = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export interface OrderRow {
  at: string;
  source: string;
  key: string;
  state: OrderState;
  asOf: string;
  evidenceSource: string;
  missing: string[];
  pr: string | null;
}

export interface OrderStateBody {
  v: 1;
  generatedAt?: string;
  asOf: string;
  sources: Record<string, string> | 'unavailable';
  orders: OrderRow[];
}

/**
 * `notes` is present only when non-empty (the 359 suite compares ok bodies with toEqual).
 * It carries source-health notes: degraded sources, and live/queue checks that did not run.
 */
export type OrderStateParse = { kind: 'ok'; asOf: string; rows: OrderRow[]; notes?: string[] } | { kind: 'unavailable' };

export const ORDER_STATE_PATH = '/api/verse/fleet/work-board/orders';
export const MAX_ORDER_ROWS = 20;
export const MAX_EVIDENCE_CHARS = 60;

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const isState = (v: unknown): v is OrderState => typeof v === 'string' && (ORDER_STATES as readonly string[]).includes(v);

function parseRow(raw: unknown): OrderRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== 'string' || typeof r.source !== 'string' || typeof r.key !== 'string') return null;
  if (!isState(r.state) || typeof r.asOf !== 'string') return null;
  if (!Array.isArray(r.missing) || !r.missing.every((m) => typeof m === 'string')) return null;
  if (r.pr !== null && typeof r.pr !== 'string') return null;
  return {
    at: r.at, source: r.source, key: r.key, state: r.state, asOf: r.asOf,
    evidenceSource: typeof r.evidenceSource === 'string' ? r.evidenceSource : '',
    missing: r.missing as string[], pr: r.pr as string | null,
  };
}

/** Validates an untrusted body. Wrong version, missing asOf or non-array orders → unavailable. */
export function parseOrderStateBody(body: unknown): OrderStateParse {
  if (!body || typeof body !== 'object') return { kind: 'unavailable' };
  const b = body as Record<string, unknown>;
  if (b.v !== 1 || typeof b.asOf !== 'string' || !Array.isArray(b.orders)) return { kind: 'unavailable' };
  const rows: OrderRow[] = [];
  for (const raw of b.orders) { const row = parseRow(raw); if (row) rows.push(row); }
  const notes: string[] = [];
  if (b.sources && typeof b.sources === 'object' && !Array.isArray(b.sources)) {
    const bad = Object.entries(b.sources as Record<string, unknown>)
      .filter(([, v]) => v !== 'healthy')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : 'unknown'}`);
    if (bad.length > 0) notes.push(`sources degraded: ${bad.join(' ')}`);
  }
  if (b.live === 'unavailable') notes.push('RUNNING not checked');
  if (b.queue === 'unavailable') notes.push('BLOCKED not checked');
  return notes.length > 0 ? { kind: 'ok', asOf: b.asOf, rows, notes } : { kind: 'ok', asOf: b.asOf, rows };
}

export interface OrderRowView {
  key: string;
  time: string;
  source: string;
  state: OrderState;
  asOfText: string;
  evidenceText: string;
  missingText: string;
  prUrl: string | null;
  prLabel: string | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function clock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function orderRowView(row: OrderRow): OrderRowView {
  const pr = row.pr !== null && PR_URL.test(row.pr) ? row.pr : null;
  return {
    key: row.key,
    time: clock(row.at),
    source: row.source,
    state: row.state,
    asOfText: `as of ${clock(row.asOf)}`,
    evidenceText: row.evidenceSource.trim().slice(0, MAX_EVIDENCE_CHARS) || 'unknown',
    missingText: row.missing.length > 0 ? row.missing.join(', ') : 'none',
    prUrl: pr,
    prLabel: pr === null ? null : `PR #${pr.slice(pr.lastIndexOf('/') + 1)}`,
  };
}
