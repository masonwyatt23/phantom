/** One-glance owner view of the work board: counts per state plus the items
 * that need attention. Pure and bounded; the board carries no message body
 * text, so none can appear here. */
import type { WorkBoardItem, WorkBoardResult } from './work-board.js';
import type { WorkItemState } from './work-item-state.js';

const ORDER: WorkItemState[] = ['BLOCKED', 'RUNNING', 'ASSIGNED', 'RECEIVED', 'VERIFIED'];
const MAX_ATTENTION_LINES = 3;
export const WORK_BOARD_UNKNOWN_LINE = 'Work items: unknown (bus inbox unreadable)';

function clock(now: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** Labels are untrusted: keep a short printable token. */
const label = (value: string, max: number): string => value.replace(/[^\w .:/@-]/g, '?').slice(0, max);

export const NO_OWNED_WORK_LINE = 'Owned work: none with claim + execution evidence';

/** Newest executing item (RUNNING/VERIFIED) bound to a named owner and claim
 * receipt; ties on asOf go to the newest receivedAt. Never invents an owner. */
function evidenceLine(items: WorkBoardItem[]): string {
  const time = (iso: string): number => Date.parse(iso) || 0;
  const best = items
    .filter(item => (item.state === 'RUNNING' || item.state === 'VERIFIED') && item.owner && item.claimReceipt)
    .sort((a, b) => time(b.asOf) - time(a.asOf) || time(b.receivedAt) - time(a.receivedAt))[0];
  if (!best) return NO_OWNED_WORK_LINE;
  const asOf = new Date(best.asOf);
  const at = Number.isNaN(asOf.getTime()) ? 'unknown' : `${clock(asOf)} ET`;
  return `${best.state} ${label(best.id, 12)} owner=${label(best.owner ?? '', 40)} claim=${label(best.claimReceipt ?? '', 80)}`
    + ` evidence=${label(best.source, 60)} as-of=${at}`;
}

export function summarizeWorkBoard(board: WorkBoardResult, now: Date): string[] {
  if (board.inbox !== 'ok') return [WORK_BOARD_UNKNOWN_LINE];
  const counts = Object.fromEntries(ORDER.map(state => [state, 0])) as Record<WorkItemState, number>;
  for (const item of board.items) counts[item.state]++;
  const head = `Work items as of ${clock(now)} ET: ${ORDER.map(state => `${counts[state]} ${state}`).join(', ')}`
    + (board.truncated ? ' (latest only)' : '');
  const attention = [
    ...board.items.filter(item => item.state === 'BLOCKED'),
    ...board.items.filter(item => item.state === 'RECEIVED' && item.missing.includes('named owner')),
  ].slice(0, MAX_ATTENTION_LINES).map(item => {
    const missing = item.missing.map(entry => label(entry, 40)).join(', ');
    return `${item.state} ${label(item.id, 12)} (${label(item.channel, 24)})${missing ? `: missing ${missing}` : ''}`;
  });
  return [head, evidenceLine(board.items), ...attention];
}
