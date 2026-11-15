import type { projectCoordinationReturns } from './coordination-returns-view.js';

const FOOTER = "VERIFIED is the returning agent's evidence; Phantom has not checked the PR.";
const REPLY_MAX = 1500;

/** Pure retained-receipt reply. Counts cover all retained rows, including
 * those omitted to keep the newest eight rows within the reply budget. */
export function formatResultsReply(projection: ReturnType<typeof projectCoordinationReturns>): string {
  const heading = `Phantom results, as of ${projection.asOf}`;
  const verified = projection.returns.filter(row => row.result === 'VERIFIED').length;
  const blocked = projection.returns.filter(row => row.result === 'BLOCKED').length;
  const counts = `${verified} VERIFIED, ${blocked} BLOCKED, ${projection.unparsed} unparsed`;
  const rows = [...projection.returns].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8).map(row => {
    const prefix = `${row.evidenceKind} `;
    const evidence = row.evidence.startsWith(prefix) ? row.evidence.slice(prefix.length) : row.evidence;
    const detail = row.evidenceKind === 'pr'
      ? `PR #${row.pr} head ${row.head?.slice(0, 7)}`
      : `${row.evidenceKind} ${evidence.slice(0, 80)}`;
    return `${row.result} ${row.repo} claim ${row.claimId}: ${detail} — from ${row.from}, ${row.at}`;
  });
  if (projection.state === 'unknown') rows.splice(0, rows.length, 'Results: UNKNOWN (coordination ledger: reader failed)');
  else if (rows.length === 0) rows.push('Results: none retained');
  const assemble = (): string => [heading, counts, ...rows, FOOTER].join('\n');
  while (rows.length > 0 && assemble().length > REPLY_MAX) rows.pop();
  return assemble();
}
