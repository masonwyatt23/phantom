/**
 * core/fleet/claim-execution-reply.ts: format a ClaimExecutionReport as one
 * short thread reply for the owner's exact "running" ask — which live claims
 * a worker is actually RUNNING (pid, lane, age), which are CLAIMED with no
 * live worker, and which are UNKNOWN. Pure: no I/O, no clock. Every line is
 * Slack-escaped like runtime-status-lines.ts and the reply is hard-capped.
 * Evidence only: it never says a claim was assigned or routed — RUNNING is
 * only what the live process table proved.
 */
import type { ClaimExecutionReport, ClaimExecutionRow } from './claim-execution-evidence.js';

const REPLY_MAX = 1500;
const MAX_ROWS = 10;

const escape = (value: string): string =>
  value.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const text = (value: unknown, fallback = 'UNKNOWN'): string => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s === '' ? fallback : s;
};

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const seconds = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(Math.max(0, Math.floor(value))) : '?';

/** RUNNING first, then CLAIMED_NO_WORKER, then UNKNOWN; ledger order within. */
const rank = (state: unknown): number =>
  state === 'RUNNING' ? 0 : state === 'CLAIMED_NO_WORKER' ? 1 : state === 'UNKNOWN' ? 2 : 3;

function line(row: ClaimExecutionRow): string {
  const agent = text(row?.agent);
  if (row?.state === 'RUNNING') {
    const worker = row.worker;
    const pid = worker != null && Number.isSafeInteger(worker.pid) && worker.pid > 0 ? String(worker.pid) : '?';
    return `RUNNING ${text(row.jobId ?? row.claimId)} — ${agent}, pid ${pid}, ${text(worker?.lane)}/${text(worker?.tier)}, ${seconds(worker?.ageSeconds)}s`;
  }
  if (row?.state === 'CLAIMED_NO_WORKER') {
    return `CLAIMED ${text(row.jobId ?? row.claimId)} — ${agent}, no live worker, expires in ${seconds(row.expiresInSeconds)}s`;
  }
  return `UNKNOWN ${text(row?.claimId)} — ${agent}`;
}

export function formatClaimExecutionReply(report: ClaimExecutionReport): string {
  const rows = (Array.isArray(report?.rows) ? report.rows : [])
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row?.state) - rank(b.row?.state) || a.index - b.index)
    .map(entry => entry.row);
  const head = `Phantom running, as of ${text(report?.asOf, 'unknown')}`;
  const totals = `RUNNING ${count(report?.counts?.running)} · CLAIMED (no worker) ${count(report?.counts?.claimedNoWorker)} · UNKNOWN ${count(report?.counts?.unknown)}`;
  const tail: string[] = [];
  if (report?.ledger !== 'known') tail.push('Ledger unavailable');
  if (report?.processes !== 'healthy') tail.push('Process table unavailable — RUNNING unproven');
  if (rows.length === 0) tail.push('No live claims.');
  let shown = Math.min(rows.length, MAX_ROWS);
  const assemble = (): string => {
    const hidden = rows.length - shown;
    return [head, totals, ...rows.slice(0, shown).map(line), ...(hidden > 0 ? [`+${hidden} more`] : []), ...tail]
      .map(escape).join('\n');
  };
  let out = assemble();
  while (out.length > REPLY_MAX && shown > 0) { shown -= 1; out = assemble(); }
  return out.length > REPLY_MAX ? `${out.slice(0, REPLY_MAX - 1)}…` : out;
}
