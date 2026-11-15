import { apiGet, ApiError, readFailureReason } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Local HTTP contract; the route lands independently of this card. */
export interface SurfaceOwnersResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  surfaces: Array<{
    surface: string;
    owner: string;
    ownerSource: 'advisory-claim' | 'none';
    liveClaims: Array<{ id: string; agent: string; expiresInSeconds: number }>;
    lastLanded: { jobId: string; pr: number | null; date: string; path: string } | null;
    asOf: string;
    reasons: string[];
  }>;
}

export const surfaceOwnersQuery: QueryDef<SurfaceOwnersResponse> = {
  key: 'verse-fleet-surface-owners',
  fetch: (signal) => apiGet<SurfaceOwnersResponse>('/api/verse/fleet/runtime-identity/surface-owner', signal),
};

interface SurfaceOwnerRow {
  surface: string;
  ownerText: string;
  tone: 'ok' | 'unknown' | 'warn';
  landedText: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Invalid or absent evidence stays unknown, including an unsuccessful refresh. */
export function surfaceOwnerRows(resp: unknown, error?: unknown): { rows: SurfaceOwnerRow[]; note?: string } {
  if (error instanceof ApiError && error.status === 404) return { rows: [], note: 'Owners: not served by this build' };
  if (error !== undefined) return { rows: [], note: `Owners: read failed (${readFailureReason(error)})` };
  if (resp === undefined) return { rows: [], note: 'Owners: reading…' };
  if (!object(resp) || !Array.isArray(resp.surfaces)) return { rows: [], note: 'Owners: unknown' };
  return { rows: resp.surfaces.map((entry: unknown): SurfaceOwnerRow => {
    const item = object(entry) ? entry : {};
    const row: SurfaceOwnerRow = {
      surface: text(item.surface) ? item.surface : 'unknown surface',
      ownerText: 'unknown', tone: 'unknown', landedText: 'no landed history',
    };
    const landed = item.lastLanded;
    if (object(landed) && text(landed.jobId) && text(landed.date)
      && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(landed.date) && Number.isFinite(Date.parse(landed.date))
      && (landed.pr === null || (count(landed.pr) && Number.isInteger(landed.pr) && landed.pr > 0))) {
      row.landedText = `last landed ${landed.jobId}${landed.pr === null ? '' : ` #${landed.pr}`} ${landed.date.slice(0, 10)}`;
    } else if (landed !== null) row.landedText = 'last landed unknown';
    const claims = item.liveClaims;
    if (!text(item.owner) || !Array.isArray(claims)
      || !claims.every((claim: unknown) => object(claim) && text(claim.id) && text(claim.agent) && count(claim.expiresInSeconds))) return row;
    if (claims.length === 0) {
      const reason = Array.isArray(item.reasons) ? item.reasons.find(text) : undefined;
      row.ownerText = `no live owner${reason ? ` (${reason})` : ''}`;
    } else if (claims.length > 1) {
      row.ownerText = `${claims.length} live claims (contested)`;
      row.tone = 'warn';
    } else if (item.ownerSource === 'advisory-claim') {
      const claim = claims[0];
      const seconds = claim.expiresInSeconds;
      row.ownerText = `${claim.agent} · expires in ${seconds < 3600 ? `${Math.ceil(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`}`;
      row.tone = 'ok';
    }
    return row;
  }) };
}
