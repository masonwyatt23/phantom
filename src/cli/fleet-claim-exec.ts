/** Read-only execution evidence for live advisory coordination claims. */
import { readClaimExecution, type ClaimExecutionDeps } from '../core/fleet/claim-execution-evidence.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet claim-exec [--json]';

export async function cmdFleetClaimExec(args: string[], deps: ClaimExecutionDeps = {}): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json' && !json) { json = true; continue; }
    console.error(usage);
    return 2;
  }

  const report = await readClaimExecution(deps);
  const safe = sanitizePublicJson(report) as typeof report;
  if (json) {
    console.log(JSON.stringify(safe, null, 2));
  } else {
    const lines = safe.rows.slice(0, 50).map(row => {
      const worker = row.state === 'RUNNING' && row.worker !== null
        ? ` pid ${row.worker.pid} lane ${row.worker.lane}/${row.worker.tier} age ${row.worker.ageSeconds ?? '?'}s`
        : '';
      return `${row.state} ${row.jobId ?? '-'} claim ${row.claimId} by ${row.agent} repo ${row.repo}${worker} expires in ${row.expiresInSeconds}s`;
    });
    if (!lines.length) lines.push('no live claims');
    lines.push(`running ${safe.counts.running}, claimed-no-worker ${safe.counts.claimedNoWorker}, unknown ${safe.counts.unknown}; ledger ${safe.ledger}; processes ${safe.processes}; asOf ${safe.asOf}`);
    if (safe.reasons.length) lines.push(`reasons: ${safe.reasons.join('; ')}`);
    console.log(lines.join('\n'));
  }
  return 0;
}
