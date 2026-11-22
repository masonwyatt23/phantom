/** Five plain answers, composed only from existing agent reports. Reads never act. */
import { join } from 'node:path';
import { readFleetMainHealth, type FleetMainHealthV1 } from './main-health.js';
import { readThroughput, durationText, type ThroughputReport } from './throughput.js';
import { readFamilyYield, type FamilyYieldReport } from './family-yield.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { readUsagePace } from '../usage/pace.js';
import type { PoolShareSnapshot } from '../usage/runway.js';
import { readReleaseRepos, type ReleaseRepoStatus } from '../release/release-repos.js';

export interface HealthSources {
  main: FleetMainHealthV1 | null; merges: ThroughputReport | null; pools: PoolShareSnapshot | null;
  families: FamilyYieldReport | null; releases: ReleaseRepoStatus[] | null;
}
export type HealthDetail = keyof HealthSources;
export interface FleetHealthLine { id: HealthDetail; text: string }
export interface FleetHealth { schema: 'fleet.health.v1'; asOf: string; lines: FleetHealthLine[] }
const unknown = (why: string) => `unknown, because ${why}`;
const brief = (rows: string[]) => rows.slice(0, 3).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');

export function composeFleetHealth(s: HealthSources, now: number): FleetHealth {
  const main = s.main, merges = s.merges?.metrics === 'ok' ? s.merges.totals : null;
  const red = main?.repos.filter(r => r.state === 'red').map(r => r.repo) ?? [];
  const missingMain = main?.repos.filter(r => r.state === 'unknown').map(r => r.repo) ?? [];
  const poolUnknown = s.pools?.pools.filter(r => r.state === 'unknown').map(r => `${r.pool}: ${r.reason ?? 'no forecast'}`) ?? [];
  const wasting = s.pools?.pools.filter(r => r.state === 'wasting').map(r => `${r.pool} (${Math.round(100 - r.projected_percent_at_reset!)}% unused)`) ?? [];
  const empty = s.families?.launch_families.filter(r => r.empty > 0).map(r => `${r.family.replace(/^RQ-(?:PHX-)?/, '')}: ${r.empty} empty of ${r.launches} starts`) ?? [];
  const releaseUnknown = s.releases?.filter(r => r.state === 'unknown' || r.commitsSinceTag === null && r.state !== 'due').map(r => `${r.repo}: ${r.reason}`) ?? [];
  const waiting = s.releases?.filter(r => r.state !== 'unknown' && (r.commitsSinceTag !== null && r.commitsSinceTag > 0 || r.state === 'due' && r.latestTag === null)).map(r => r.repo) ?? [];
  return { schema: 'fleet.health.v1', asOf: new Date(now).toISOString(), lines: [
    { id: 'main', text: `Main: ${!main || main.source !== 'ok' ? unknown('guardian status could not be read')
      : main.stale ? unknown('guardian status is over 30 minutes old') : main.guardianOff ? unknown('the guardian is off')
        : !main.repos.length ? unknown('guardian status lists no repos') : red.length ? `red on ${red.join(', ')}`
          : missingMain.length ? unknown(`checks are missing for ${missingMain.join(', ')}`) : 'green'}.` },
    { id: 'merges', text: `Merges, last hour: ${merges?.merged == null ? unknown('job metrics could not be read')
      : `${merges.merged} PR${merges.merged === 1 ? '' : 's'}; publish to merge ${merges.median_publish_to_merge_s === null ? unknown('no merged PR has a recorded publish time')
        : `median ${durationText(merges.median_publish_to_merge_s)}${merges.merge_time_unknown ? ` (${merges.merge_time_unknown} timings unknown)` : ''}`}`}.` },
    { id: 'pools', text: `Unused before reset: ${!s.pools?.pools.length ? unknown('pool forecasts could not be read')
      : `${brief(wasting) || 'no measured pool'}${poolUnknown.length ? `; ${unknown(brief(poolUnknown))}` : ''}`}.` },
    { id: 'families', text: `Wasted starts, last 24 hours: ${!s.families?.known ? unknown('family yield could not be read') : brief(empty) || 'no empty runs recorded'}.` },
    { id: 'releases', text: `Unreleased work: ${!s.releases?.length ? unknown('release status could not be read')
      : `${brief(waiting) || 'none measured'}${releaseUnknown.length ? `; ${unknown(brief(releaseUnknown))}` : ''}`}.` },
  ] };
}

export async function readHealthSources(runsDir: string, now: number): Promise<HealthSources> {
  const quiet = <T>(read: Promise<T>) => read.catch(() => null);
  const [main, merges, pace, families, releases] = await Promise.all([
    quiet(readFleetMainHealth({ runsDir, now: () => now })),
    quiet(readThroughput({ runsDir, metricsPath: join(runsDir, 'metrics/jobs.jsonl'), now, hours: 1, by: 'repo' })),
    quiet(readUsagePace(join(runsDir, 'queue/status.json'))),
    quiet(readFamilyYield(join(runsDir, 'metrics/jobs.jsonl'), 24, now)), quiet(readReleaseRepos({ now })),
  ]);
  return { main, merges, pools: pace?.shares ?? null, families, releases };
}
export async function readFleetHealth(opts: { runsDir?: string; now?: number; read?: typeof readHealthSources } = {}): Promise<FleetHealth> {
  const now = opts.now ?? Date.now();
  return composeFleetHealth(await (opts.read ?? readHealthSources)(opts.runsDir ?? defaultRunsDir(), now), now);
}
