import { homedir } from 'node:os';
import { join } from 'node:path';
import { explainFleetAdmission, type FleetAdmissionReport } from '../../cli/fleet-admission.js';
import { readFleetQueue, readSource, type FleetQueueV1, type Source } from './runs-parked-queue.js';
import { readLaneTargets, type LaneTargetsV1 } from './runs-lane-targets.js';
import { readRebaseStatus } from './rebase-status.js';

export const FLEET_AUTOPILOT_SCHEMA = 'fleet.autopilot.v1';
export const AUTOPILOT_OVER_DEEP_FACTOR = 3;
export const AUTOPILOT_MAX_PROPOSED = 20;

export type RebaseSource = 'unconfigured' | 'ok' | 'partial' | 'degraded';
export interface AutopilotSources { status: Source; queue: Source; slots: Source; rebase: RebaseSource }

export interface AutopilotRebaseRepo {
  repo: string;
  source: 'ok' | 'truncated' | 'unavailable';
  conflicting: number | null;
  uncovered: number | null;
  staleHeadOnly: number | null;
}

export type AutopilotQueue = FleetQueueV1 & { metDeps?: Array<{ job: string; lane: string | null }> };

export interface FleetAutopilotState {
  generatedAt: string;
  sources: AutopilotSources;
  admission: FleetAdmissionReport | null;
  queue: AutopilotQueue | null;
  slots: LaneTargetsV1 | null;
  rebase: AutopilotRebaseRepo[] | null;
}

export interface AutopilotReadDeps {
  statusText?: (path: string) => Promise<string>;
  queue?: (opts: { runsDir: string; depDetail: boolean }) => Promise<AutopilotQueue>;
  slots?: (opts: { runsDir: string }) => Promise<LaneTargetsV1>;
  rebase?: typeof readRebaseStatus;
  now?: () => Date;
}

export async function readFleetAutopilotState(
  opts: { runsDir?: string; repos?: string[] } & AutopilotReadDeps = {},
): Promise<FleetAutopilotState> {
  const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const now = opts.now ?? (() => new Date());
  const [status, queue, slots, rebase] = await Promise.all([
    (async (): Promise<{ source: Source; report: FleetAdmissionReport | null }> => {
      try {
        const path = join(runsDir, 'queue', 'status.json');
        const text = opts.statusText ? await opts.statusText(path) : await (async () => {
          const source = await readSource(path, 2 * 1024 * 1024, false);
          if (source.state !== 'healthy') throw Object.assign(new Error('status unavailable'), { code: source.state === 'missing' ? 'ENOENT' : 'EIO' });
          return source.text;
        })();
        return { source: 'healthy', report: explainFleetAdmission(JSON.parse(text)) };
      } catch (error) {
        return { source: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'degraded', report: null };
      }
    })(),
    (opts.queue ?? ((o) => readFleetQueue(o)))({ runsDir, depDetail: true })
      .then((view): { source: Source; view: AutopilotQueue | null } => ({
        source: view.sources.ready, view,
      }))
      .catch((): { source: Source; view: AutopilotQueue | null } => ({ source: 'degraded', view: null })),
    (opts.slots ?? ((o) => readLaneTargets(o)))({ runsDir })
      .then((view): { source: Source; view: LaneTargetsV1 } => ({ source: view.sourceState, view }))
      .catch((): { source: Source; view: LaneTargetsV1 | null } => ({ source: 'degraded', view: null })),
    (async (): Promise<{ source: RebaseSource; repos: AutopilotRebaseRepo[] | null }> => {
      const repos = opts.repos ?? [];
      if (repos.length === 0) return { source: 'unconfigured', repos: null };
      try {
        const report = await (opts.rebase ?? readRebaseStatus)(repos, runsDir, now());
        const rows: AutopilotRebaseRepo[] = report.repos.map((row) => ({
          repo: row.repo,
          source: row.source === 'ok' || row.source === 'truncated' ? row.source : 'unavailable',
        conflicting: row.summary?.conflicting ?? null,
        uncovered: row.summary === null ? null : (row.summary.coverage?.uncovered ?? null),
        staleHeadOnly: row.summary === null ? null : (row.summary.coverage?.staleHeadOnly ?? null),
        }));
        const ok = rows.filter((row) => row.source === 'ok' && row.uncovered !== null && row.staleHeadOnly !== null).length;
        return { source: ok === rows.length ? 'ok' : ok === 0 ? 'degraded' : 'partial', repos: rows };
      } catch {
        return { source: 'degraded', repos: null };
      }
    })(),
  ]);
  return {
    generatedAt: now().toISOString(),
    sources: { status: status.source, queue: queue.source, slots: slots.source, rebase: rebase.source },
    admission: status.report, queue: queue.view, slots: slots.view, rebase: rebase.repos,
  };
}

export type AutopilotGapKind = 'uncovered-conflicts' | 'starved-lane' | 'stale-parked-deps' | 'missing-restock';
const GAP_KIND_ORDER: Record<AutopilotGapKind, number> = {
  'uncovered-conflicts': 0, 'starved-lane': 1, 'stale-parked-deps': 2, 'missing-restock': 3,
};
export type AutopilotNoopReason = 'fleet-healthy' | 'capacity-bound' | 'dispatch-stall' | 'state-unreadable';
export type AutopilotEnqueueType = 'rebase' | 'restock' | 'unpark';

export interface AutopilotGap {
  kind: AutopilotGapKind;
  lane: string | null;
  severity: number;
  detail: string;
    evidence: Record<string, unknown>;
}

export type AutopilotAction =
  | { kind: 'enqueue'; type: AutopilotEnqueueType; count: number; lane: string | null; repos?: string[]; detail: string }
  | { kind: 'hold-lane'; lane: string; detail: string }
  | { kind: 'no-op'; reason: AutopilotNoopReason; detail: string };

export interface AutopilotLane {
  lane: string;
  running: number | null;
  target: number | null;
    queued: number | null;
    ready: number | null;
  parked: number | null;
    depWaiting: number | null;
  held: boolean;
    freeSlots: number | null;
    utilization: number | null;
    reason: string | null;
}

export interface AutopilotReport {
  schema: typeof FLEET_AUTOPILOT_SCHEMA;
  readOnly: true;
    status: 'ok' | 'degraded' | 'unreadable';
  generatedAt: string;
  sources: AutopilotSources;
  global: { cap: number | null; running: number | null; atCap: boolean | null; admitReason: string | null };
  lanes: AutopilotLane[];
    gaps: AutopilotGap[];
    topGap: AutopilotGap | null;
  action: AutopilotAction;
}

function cleanLane(value: string): string {
  return Array.from(value.slice(0, 64), (char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('').trim();
}

export function autopilotLanes(state: FleetAutopilotState): AutopilotLane[] {
  const queueOk = state.queue !== null && state.sources.queue === 'healthy';
  const readyByLane = new Map((state.queue?.byLane ?? []).map((row) => [row.lane, row]));
  const depWaiting = new Map<string, number>();
  for (const row of state.queue?.unmetDeps ?? []) {
    const lane = row.lane ?? '';
    depWaiting.set(lane, (depWaiting.get(lane) ?? 0) + 1);
  }
  const holds = new Map((state.slots?.lanes ?? []).map((row) => [row.lane, row.held || row.heldReason !== null]));
  const names = new Set<string>([
    ...(state.admission?.lanes ?? []).map((row) => row.lane),
    ...(state.slots?.lanes ?? []).map((row) => row.lane),
    ...(state.queue?.byLane ?? []).map((row) => row.lane),
  ]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((raw): AutopilotLane => {
    const lane = cleanLane(raw) || raw;
    const admit = state.admission?.lanes.find((row) => row.lane === lane) ?? null;
    const queuedRow = queueOk ? readyByLane.get(raw) ?? null : null;
    const running = admit?.running ?? null;
    const target = admit?.target ?? state.slots?.lanes.find((row) => row.lane === lane)?.target ?? null;
    const held = Boolean(admit?.held || holds.get(raw) || holds.get(lane));
    const free = held || running === null || target === null ? null : Math.max(0, target - running);
    return {
      lane,
      running, target,
      queued: admit?.queued ?? null,
      ready: queuedRow?.ready ?? (queueOk ? 0 : null),
      parked: queuedRow?.parked ?? (queueOk ? 0 : null),
      depWaiting: depWaiting.get(raw) ?? depWaiting.get(lane) ?? (queueOk && state.queue?.unmetDeps ? 0 : null),
      held, freeSlots: free,
      utilization: running !== null && target !== null && target > 0 ? running / target : null,
      reason: admit?.reason ?? null,
    };
  });
}

function starvedAction(lane: AutopilotLane, lanes: AutopilotLane[], atCap: boolean): AutopilotAction {
  if (atCap) {
    const holdable = lanes
      .filter((row) => row.lane !== lane.lane && !row.held && (row.running ?? 0) > 0 &&
        (row.target ?? 0) > 0 && (row.ready ?? 0) > (row.target ?? 0) * AUTOPILOT_OVER_DEEP_FACTOR)
      .sort((a, b) => (b.ready ?? 0) / (b.target || 1) - (a.ready ?? 0) / (a.target || 1) || a.lane.localeCompare(b.lane));
    if (holdable.length > 0) {
      const target = holdable[0]!;
      return {
        kind: 'hold-lane', lane: target.lane,
        detail: `Hold '${target.lane}' (ready ${target.ready} > ${AUTOPILOT_OVER_DEEP_FACTOR}x target ${target.target}) so '${lane.lane}' queued work can reach the freed cap.`,
      };
    }
    return { kind: 'no-op', reason: 'capacity-bound', detail: `'${lane.lane}' has queued work under target but the global cap is full; no over-deep lane is safe to hold.` };
  }
  return { kind: 'no-op', reason: 'dispatch-stall', detail: `'${lane.lane}' has launchable work and free slots under the cap but is not running to target — the dispatcher should be launching.` };
}

export function planFleetAutopilot(state: FleetAutopilotState): AutopilotReport {
  const gaps: AutopilotGap[] = [];
  const lanes = autopilotLanes(state);
  const admission = state.admission;
  const atCap = admission?.global.at_cap ?? null;
  for (const repo of state.rebase ?? []) {
    if (repo.uncovered === null && repo.staleHeadOnly === null) continue;
    const due = (repo.uncovered ?? 0) + (repo.staleHeadOnly ?? 0);
    if (due <= 0) continue;
    gaps.push({
      kind: 'uncovered-conflicts', lane: null,
      severity: 90 + Math.min(due, 10),
      detail: `${repo.repo}: ${due} conflicting bridge PR${due === 1 ? '' : 's'} with no current rebase job (of ${repo.conflicting ?? due} conflicting).`,
      evidence: { repo: repo.repo, conflicting: repo.conflicting, uncovered: repo.uncovered, staleHeadOnly: repo.staleHeadOnly, source: repo.source },
    });
  }
  for (const lane of lanes) {
    const waiting = lane.ready;
    if (lane.held || lane.running === null || lane.target === null || lane.running >= lane.target || !waiting || waiting <= 0) continue;
    gaps.push({
      kind: 'starved-lane', lane: lane.lane,
      severity: 80 + Math.min(waiting, 15) + (lane.running === 0 ? 5 : 0),
      detail: `'${lane.lane}' runs ${lane.running} of target ${lane.target} with ${waiting} launchable job${waiting === 1 ? '' : 's'} waiting${atCap ? ' while the fleet sits at the cap' : ' under the cap'}.`,
      evidence: { running: lane.running, target: lane.target, waiting, ready: lane.ready, queued: lane.queued, atCap },
    });
  }
  const met = state.queue?.metDeps ?? [];
  if (met.length > 0) {
    const byLane = new Map<string, number>();
    for (const row of met) byLane.set(row.lane ?? '', (byLane.get(row.lane ?? '') ?? 0) + 1);
    const modal = [...byLane.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    gaps.push({
      kind: 'stale-parked-deps', lane: modal[0] || null,
      severity: 60 + Math.min(met.length, 10),
      detail: `${met.length} parked DEP row${met.length === 1 ? '' : 's'} (${met.slice(0, 3).map((row) => row.job).join(', ')}${met.length > 3 ? ', …' : ''}) ${met.length === 1 ? 'has' : 'have'} all gates merged but ${met.length === 1 ? 'was' : 'were'} never unparked.`,
      evidence: { count: met.length, jobs: met.slice(0, 10).map((row) => row.job), byLane: Object.fromEntries(byLane) },
    });
  }
  for (const lane of lanes) {
    const waiting = lane.ready;
    if (atCap !== false || lane.held || lane.freeSlots === null || lane.freeSlots <= 0 || waiting === null || waiting > 0) continue;
    gaps.push({
      kind: 'missing-restock', lane: lane.lane,
      severity: 50 + Math.min(lane.freeSlots * 2, 20),
      detail: `'${lane.lane}' has ${lane.freeSlots} free slot${lane.freeSlots === 1 ? '' : 's'} and no launchable work queued.`,
      evidence: { freeSlots: lane.freeSlots, running: lane.running, target: lane.target, parked: lane.parked, depWaiting: lane.depWaiting },
    });
  }

  gaps.sort((a, b) => GAP_KIND_ORDER[a.kind] - GAP_KIND_ORDER[b.kind] || b.severity - a.severity || (a.lane ?? '').localeCompare(b.lane ?? ''));
  const topGap = gaps[0] ?? null;

  const localUsable = admission !== null || state.sources.queue === 'healthy' || state.sources.slots === 'healthy';
  let action: AutopilotAction;
  if (!localUsable) {
    action = { kind: 'no-op', reason: 'state-unreadable', detail: 'No local queue, slots or admission source was readable; nothing safe to propose.' };
  } else if (topGap === null) {
    action = { kind: 'no-op', reason: 'fleet-healthy', detail: 'No gap measured: every lane is held, at target, or fed to its queue.' };
  } else {
    switch (topGap.kind) {
      case 'uncovered-conflicts': {
        const due = Math.min((topGap.evidence.uncovered as number ?? 0) + (topGap.evidence.staleHeadOnly as number ?? 0), AUTOPILOT_MAX_PROPOSED);
        action = {
          kind: 'enqueue', type: 'rebase', count: due, lane: null, repos: [topGap.evidence.repo as string],
          detail: `Enqueue ${due} rebase job${due === 1 ? '' : 's'} for ${topGap.evidence.repo}: conflicting bridge PRs have no current rebase coverage.`,
        };
        break;
      }
      case 'starved-lane':
        action = atCap === null ? { kind: 'no-op', reason: 'state-unreadable', detail: 'Global capacity is unknown.' } : starvedAction(lanes.find((row) => row.lane === topGap.lane)!, lanes, atCap);
        break;
      case 'stale-parked-deps':
        action = {
          kind: 'enqueue', type: 'unpark', count: met.length, lane: topGap.lane,
          detail: `Enqueue an unpark sweep: ${met.length} parked DEP row${met.length === 1 ? ' sits' : 's sit'} stale with every gate merged.`,
        };
        break;
      case 'missing-restock': {
        const lane = lanes.find((row) => row.lane === topGap.lane)!;
        action = {
          kind: 'enqueue', type: 'restock', count: lane.freeSlots ?? 1, lane: lane.lane,
          detail: `Enqueue ${lane.freeSlots} restock job${lane.freeSlots === 1 ? '' : 's'} for '${lane.lane}': free slots but an empty ready queue.`,
        };
        break;
      }
    }
  }

  const degraded = !localUsable ? false
    : [state.sources.status, state.sources.queue, state.sources.slots].some((source) => source !== 'healthy')
      || ['degraded', 'partial'].includes(state.sources.rebase)
      || (state.queue !== null && (state.queue.unmetDeps === undefined || state.queue.metDeps === undefined));
  return {
    schema: FLEET_AUTOPILOT_SCHEMA,
    readOnly: true,
    status: !localUsable ? 'unreadable' : degraded ? 'degraded' : 'ok',
    generatedAt: state.generatedAt,
    sources: state.sources,
    global: {
      cap: admission?.global.cap ?? null,
      running: admission?.global.running ?? null,
      atCap: admission?.global.at_cap ?? null,
      admitReason: admission?.global.admit_reason ?? null,
    },
    lanes,
    gaps,
    topGap,
    action,
  };
}
