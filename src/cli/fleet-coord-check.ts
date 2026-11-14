/** `ashlr fleet coord-check` — one bounded read answering the Nov13 13:13 ET
 * owner order: sanitized runtime identity, channel health, the shared claims
 * board totals, the named owner of the Dot bridge item, one already-claimed
 * task with execution evidence, and a REACHABLE/BLOCKED verdict naming the
 * missing piece. Read-only: sends nothing, writes nothing. Exit 0 when
 * REACHABLE, 3 when BLOCKED, 2 on bad args. */
import { buildCoordCheck, defaultCoordCheckDeps, type CoordCheckDeps, type CoordCheckReport } from '../core/fleet/coord-check.js';

const usage = 'Usage: ashlr fleet coord-check [--json]';

function line(label: string, value: string): string {
  return `  ${label}: ${value}`;
}

function textReport(r: CoordCheckReport): string[] {
  const out: string[] = [`coord-check as of ${r.asOf}`];
  out.push('runtime:');
  if (r.runtime.value) {
    const rt = r.runtime.value;
    out.push(
      line('host', rt.host), line('platform', rt.platform),
      line('installedVersion', rt.installedVersion), line('sourceVersion', rt.sourceVersion),
      line('fleetState.ageSeconds', String(rt.fleetState.ageSeconds)),
      line('fleetState.stale', String(rt.fleetState.stale)),
      line('tailnetName', rt.tailnetName),
    );
    for (const reason of rt.reasons) out.push(line('reason', reason));
  } else out.push(line('unavailable', r.runtime.reason ?? 'unknown'));
  out.push('channels:');
  if (r.channels.value) {
    for (const c of r.channels.value.channels) {
      out.push(`  ${c.channel}: ${c.state} configured=${c.configured} process=${c.processAlive} unanswered=${c.unansweredCount}`);
      for (const m of c.missing) out.push(line('missing', m));
    }
  } else out.push(line('unavailable', r.channels.reason ?? 'unknown'));
  out.push('claims:');
  if (r.claims.value) {
    const c = r.claims.value;
    out.push(line('asOf', c.asOf), line('total', String(c.total)),
      line('byState', (Object.keys(c.byState) as (keyof typeof c.byState)[]).map(s => `${s}=${c.byState[s]}`).join(' ')));
  } else out.push(line('unavailable', r.claims.reason ?? 'unknown'));
  out.push('bridgeOwner:');
  if (r.bridgeOwner.value) {
    const b = r.bridgeOwner.value;
    out.push(line('id', b.id), line('owner', b.owner), line('state', b.state), line('receivedAt', b.receivedAt));
  } else out.push(line('none', r.bridgeOwner.reason ?? 'unknown'));
  out.push('oneTask:');
  if (r.oneTask.value) {
    const t = r.oneTask.value;
    out.push(line('id', t.id), line('owner', t.owner), line('state', t.state),
      line('claimReceipt', t.claimReceipt), line('evidence', t.evidence), line('at', t.at));
  } else out.push(line('none', r.oneTask.reason ?? 'unknown'));
  out.push(`verdict: ${r.verdict}`);
  for (const m of r.missing) out.push(`missing: ${m}`);
  return out;
}

/** Print the composed check; exit 0 REACHABLE, 3 BLOCKED, 2 bad args. */
export async function cmdFleetCoordCheck(args: string[], deps: CoordCheckDeps = defaultCoordCheckDeps()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nOne read of runtime identity, channel health and the work board; answers who owns the Dot bridge and one claimed task.`);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(usage);
    return 2;
  }
  const report = await buildCoordCheck(deps);
  if (args[0] === '--json') console.log(JSON.stringify(report, null, 2));
  else console.log(textReport(report).join('\n'));
  return report.verdict === 'REACHABLE' ? 0 : 3;
}
