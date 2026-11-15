/** Model for the fleet console's "Returned" rows: what agents posted back for
 * their claims (VERIFIED / BLOCKED + evidence), newest first. Wire rows arrive
 * via FleetRunsV1.returns on /api/verse/fleet/runs; evidence is free text
 * posted by an agent, so it is re-scrubbed and truncated for display. */
import { scrubSecrets } from '../../../../core/util/scrub.js';
import { ageText, type FleetRunsReturn } from '../ops/ops-runs-model.js';

const EVIDENCE_MAX = 160;
const ROW_LIMIT = 20;

export interface ReturnedRow {
  /** 'VERIFIED' | 'BLOCKED' (future results pass through as text). */
  state: string;
  /** Agent label that posted the return. */
  who: string;
  /** 'repo#pr@head7'; '?' / 'unknown' when the receipt named neither. */
  target: string;
  /** Scrubbed, truncated evidence text. */
  evidence: string;
  claimId: string;
  at: string;
  ageSeconds: number;
  age: string;
}

export function toReturnedRows(returns: readonly FleetRunsReturn[] | null | undefined, nowMs: number): ReturnedRow[] {
  if (!Array.isArray(returns)) return [];
  return returns.slice(0, ROW_LIMIT).map(row => {
    const at = Date.parse(row.at);
    const ageSeconds = Number.isFinite(at) ? Math.max(0, (nowMs - at) / 1000) : 0;
    return {
      state: row.result,
      who: row.from,
      target: `${row.repo}#${row.pr === null ? '?' : row.pr}@${row.head === null ? 'unknown' : row.head.slice(0, 7)}`,
      evidence: scrubSecrets(row.evidence).slice(0, EVIDENCE_MAX),
      claimId: row.claimId,
      at: row.at,
      ageSeconds,
      age: ageText(ageSeconds),
    };
  }).sort((a, b) => a.ageSeconds - b.ageSeconds);
}
