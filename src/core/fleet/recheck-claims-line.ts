/** Pure ownership summary from the existing coordination ledger snapshot. */
import type { FleetBoard } from './coordination.js';
import { projectCoordinationReturns } from './coordination-returns-view.js';
import { sanitizeIdentityText } from './runtime-identity.js';
import { scrubSecrets } from '../util/scrub.js';

const clean = (value: string): string => sanitizeIdentityText(scrubSecrets(value)
  .replace(/\/(?:Users|home)\/[^/\s;,)]+/g, '~'), '')
  .replace(/[\r\n\u2028\u2029]/g, ' ').replace(/\b(?:routed|dispatched)\b/gi, '[verb]');

function age(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

/** Null/unknown is a failed read, never evidence that there are no claims.
 * Only review-take's recorded repo#PR and @SHA are interpreted; arbitrary
 * task text is never echoed. Generic tasks retain explicit unknown PR/head.
 * VERIFIED is an agent's returned result, not independent PR verification. */
export function buildRecheckClaimsLine(input: FleetBoard | null, now: Date): string {
  const ms = now.getTime();
  if (!Number.isFinite(ms)) return 'Claims: UNKNOWN (invalid clock)';
  if (input === null || input.state !== 'known') return 'Claims: UNKNOWN (coordination ledger unreadable)';
  const claims = input.claims.filter(c => Number.isFinite(c.claimedAt) && c.claimedAt <= ms
    && Number.isFinite(c.expiresAt) && c.expiresAt > ms && c.expiresAt > c.claimedAt)
    .sort((a, b) => b.claimedAt - a.claimedAt);
  const entries = claims.slice(0, 3).map(c => {
    const review = /^review (\S+)#([1-9]\d*) \S+ @([a-fA-F0-9]{7,40})$/.exec(c.task);
    const ref = review?.[1] === c.repo ? `#${review[2]}@${review[3]!.slice(0, 7)}` : '#unknown@unknown';
    return `${clean(c.agent)} ${clean(c.repo)}${ref} lease ${age(c.claimedAt, ms)}`;
  });
  const head = claims.length === 0 ? `Claims: none active (as of ${now.toISOString()})`
    : `Claims: ${claims.length} active · ${entries.join('; ')}${claims.length > 3 ? `; +${claims.length - 3} more` : ''}`;
  const last = projectCoordinationReturns(input, ms).returns.find(r => Date.parse(r.at) <= ms && Date.parse(r.expiresAt) > ms);
  return last === undefined ? head : `${head} · last ${last.result} ${clean(last.repo)}${last.pr === null ? '' : `#${last.pr}`} by ${clean(last.from)} ${age(Date.parse(last.at), ms)} ago`;
}
