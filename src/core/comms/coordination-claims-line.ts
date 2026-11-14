/** One sanitized owner-status line for the advisory coordination claims ledger.
 * Pure and bounded: only agent, repo, a short task and an expiry clock are
 * printed. Claim ids, leases, messages and proposals never appear. */
import type { FleetBoard } from '../fleet/coordination.js';

const MAX_SHOWN = 3;
const MAX_TASK = 60;
const MAX_LINE = 300;

function clock(at: number): string {
  return `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at))} ET`;
}

/** Untrusted text: control chars and whitespace runs collapse to one space. */
const flat = (value: string): string => String(value).replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
/** Agent and repo are identifier-shaped; anything else becomes '?'. */
const token = (value: string): string => clip(flat(value).replace(/[^\w.:/@-]/g, '?'), 40);

export function formatCoordinationClaimsLine(board: FleetBoard, now: Date): string {
  const asOf = now.toISOString();
  if (board.state !== 'known') return `Claims: unknown (coordination ledger unreadable) as-of=${asOf}`;
  const tail = `source=coordination-ledger as-of=${asOf}`;
  const claims = [...board.claims].sort((a, b) => b.claimedAt - a.claimedAt);
  if (claims.length === 0) return `Claims: none active (expired=${board.expiredClaims ?? 0}) ${tail}`;
  const shown = claims.slice(0, MAX_SHOWN).map(c => `${token(c.agent)} ${token(c.repo)} "${clip(flat(c.task).replace(/"/g, "'"), MAX_TASK)}" until ${clock(c.expiresAt)}`);
  const more = claims.length > MAX_SHOWN ? `; +${claims.length - MAX_SHOWN} more` : '';
  const line = `Claims: ${claims.length} active — ${shown.join('; ')}${more} ${tail}`;
  if (line.length <= MAX_LINE) return line;
  // Over the cap: shrink the claim detail, never the as-of/source tail.
  const head = `Claims: ${claims.length} active — `;
  const room = MAX_LINE - head.length - tail.length - 2;
  return `${head}${clip(`${shown.join('; ')}${more}`, Math.max(room, 0))} ${tail}`;
}
