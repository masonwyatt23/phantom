import { formatRelative } from './autonomy/format.js';
import type { CoordLastVerified } from './fleet-board/coord-answer-model.js';

export interface CoordClaimsPayload {
  state?: string;
  reason?: string;
  generatedAt?: string;
  claims?: {
    id?: string;
    agent?: string;
    repo?: string;
    task?: string;
    claimedAt?: string;
    expiresAt?: string;
    expiresInSeconds?: number | null;
  }[];
}

/** Read-only evidence. Missing or failed reads never imply an empty ledger. */
export function CoordClaimsSegment({ payload, now, lastVerified = null }: {
  payload: CoordClaimsPayload | null | undefined;
  now: number;
  lastVerified?: CoordLastVerified | null;
}) {
  const known = payload?.state === 'known' && Array.isArray(payload.claims);
  const claims = known ? payload.claims! : [];
  const reason = payload?.reason || (payload === undefined ? 'Claims loading'
    : payload === null ? 'Claims not available on this build' : 'Claims ledger unreadable');
  const rank = (at?: string) => Date.parse(at ?? '') || 0;

  return (
    <div aria-label="Coordination claims" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <span title={known ? undefined : reason}>Claims {known ? claims.length : '?'}</span>
      {[...claims].sort((a, b) => rank(b.claimedAt) - rank(a.claimedAt)).slice(0, 3).map((claim, i) => {
        const expiry = Date.parse(claim.expiresAt ?? '');
        const observed = Date.parse(payload?.generatedAt ?? '');
        const stale = Number.isFinite(expiry) ? expiry <= now
          : typeof claim.expiresInSeconds === 'number' && Number.isFinite(observed)
            && observed + claim.expiresInSeconds * 1000 <= now;
        // The ledger has a task label, not a separate PR field. Only an
        // explicit PR reference in that label may be displayed as repo#pr.
        const pr = claim.task?.match(/(?:\bPR\s*|^)#([1-9]\d*)\b/i)?.[1];
        const target = pr ? `${claim.repo ?? '?'}#${pr}`
          : `${claim.repo ?? '?'} · ${claim.task || 'task unknown'}`;
        return (
          <span key={claim.id ?? i} title={claim.task} data-stale={stale}
            style={{ opacity: stale ? 0.55 : 1, border: '1px solid currentColor', borderRadius: '0.25rem', padding: '0 0.25rem' }}>
            {claim.agent || 'owner unknown'} → {target} · {stale ? 'stale' : `claimed ${formatRelative(claim.claimedAt, now)}`}
          </span>
        );
      })}
      <span>{lastVerified
        ? `Last VERIFIED ${lastVerified.owner} → ${lastVerified.id} · ${formatRelative(lastVerified.asOf, now)}`
        : 'Last VERIFIED ?'}</span>
    </div>
  );
}
