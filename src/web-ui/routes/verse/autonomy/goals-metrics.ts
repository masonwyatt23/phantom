/**
 * routes/verse/autonomy/goals-metrics.ts — the four live numbers across the
 * top of the Goals panel, so Mason can see whether the fleet is moving on the
 * goals he set:
 *
 *   1. Phantom PRs merged in the last 24 h      (/api/verse/fleet/live)
 *   2. Open Phantom PRs, and how many conflict  (/api/verse/github/fleet-backlog)
 *   3. Commits on master since the newest tag   (/api/verse/ops/releases)
 *   4. Installed vs newest published w/ assets  (/api/verse/release/stages)
 *
 * Pure: no React and no fetch — every input is a response the panel's queries
 * already make. The one rule every row obeys is the cockpit's rule: a number
 * the server cannot supply is "unknown" with the reason, never 0.
 */
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
import type { OpsReleasesV1, OpsRepoReleaseV1 } from '../../../../core/verse/ops-types.js';
import type { OptionalFleetRead } from './fleet-contract.js';
import { compareReleaseTags } from '../sections/release-gap-model.js';

const PHANTOM_REPO = 'ashlrai/phantom';

/** An as-of older than this reads as stale — the source has stopped refreshing. */
export const GOALS_METRIC_STALE_MS = 15 * 60 * 1000;

/**
 * What one metric's source read looks like to the model: still in flight,
 * refused/absent (with the sentence the surface layer wrote), or answered.
 */
export type MetricRead<T> =
  | { kind: 'pending' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ok'; value: T };

/** The structural part of a QueryEntry the adapters read (data/cache.ts shape). */
export interface QueryEntryLike<T> {
  data: T | undefined;
  status: string;
  error?: { message?: string | undefined } | undefined;
}

/**
 * Map a `useQuery` entry to a MetricRead. `undefined` data is a read in
 * flight (or a failed one — the error's message becomes the reason); a
 * resolved `null` is the server's own "I don't serve this" answer, which the
 * caller names with `nullReason`.
 */
export function metricReadOf<T>(
  entry: QueryEntryLike<T>,
  nullReason = 'The route did not answer.',
): MetricRead<Exclude<T, null | undefined>> {
  if (entry.data === undefined) {
    return entry.status === 'error'
      ? { kind: 'unavailable', reason: entry.error?.message ?? 'The read failed.' }
      : { kind: 'pending' };
  }
  if (entry.data === null) return { kind: 'unavailable', reason: nullReason };
  return { kind: 'ok', value: entry.data as Exclude<T, null | undefined> };
}

/** Same mapping for an `optionalQuery` read: the absent-source envelope is unwrapped once. */
export function optionalMetricReadOf<T>(entry: QueryEntryLike<OptionalFleetRead<T>>): MetricRead<T> {
  const outer = metricReadOf(entry);
  if (outer.kind !== 'ok') return outer;
  const read = outer.value;
  return read.value === null || !read.available
    ? { kind: 'unavailable', reason: read.reason ?? 'The read is unavailable.' }
    : { kind: 'ok', value: read.value };
}

// ---------------------------------------------------------------------------
// /api/verse/release/stages — validated client-side, with the check time kept
// (power/release-stages-model.ts drops `checkedAt`, which is this tile's as-of).
// ---------------------------------------------------------------------------

export interface ReleaseStagesRead {
  tag: string | null;
  /** When the server last checked the newest release (this tile's as-of). */
  checkedAt: string | null;
  /** The route's own refusal line when the newest release could not be read. */
  reason: string | null;
  stages: ReadonlyArray<{ stage: string; status: string; version: string | null; reason: string | null }>;
}

export function narrowReleaseStages(value: unknown): ReleaseStagesRead | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['schema'] !== 'verse.release-stages.v1' || !Array.isArray(row['stages'])) return null;
  const stages = (row['stages'] as unknown[]).flatMap((raw): ReleaseStagesRead['stages'] => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
    const s = raw as Record<string, unknown>;
    if (typeof s['stage'] !== 'string' || typeof s['status'] !== 'string') return [];
    return [{
      stage: s['stage'],
      status: s['status'],
      version: typeof s['version'] === 'string' ? s['version'] : null,
      reason: typeof s['reason'] === 'string' ? s['reason'] : null,
    }];
  });
  const checkedAt = row['checkedAt'];
  return {
    tag: typeof row['tag'] === 'string' && row['tag'] ? row['tag'] : null,
    checkedAt: typeof checkedAt === 'string' && Number.isFinite(Date.parse(checkedAt)) ? checkedAt : null,
    reason: typeof row['reason'] === 'string' ? row['reason'] : null,
    stages,
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface GoalMetricRow {
  id: 'merged-24h' | 'open-prs' | 'unshipped' | 'release-version';
  label: string;
  /** The number as printed; null = unknown (unknownReason says why). */
  value: string | null;
  /** Secondary line — "12 conflicting", "since v3.30.8". */
  detail: string | null;
  /** Why the value is null; null when the value is present. */
  unknownReason: string | null;
  /** When the source snapshot was generated (ISO); null = the source gave none. */
  asOf: string | null;
  /** asOf parses and is older than GOALS_METRIC_STALE_MS at `now`. */
  stale: boolean;
  /** Which server read produced the number. */
  source: string;
}

export interface GoalsMetricsInput {
  live: MetricRead<FleetLiveSnapshotV1>;
  backlog: MetricRead<MergeBacklogReadV1>;
  releases: MetricRead<OpsReleasesV1>;
  stages: MetricRead<ReleaseStagesRead>;
  /** installedDesktopVersion() ?? APP_VERSION — the build Mason is running. */
  installedVersion: string | null;
  now?: number;
}

interface RowBase {
  id: GoalMetricRow['id'];
  label: string;
  source: string;
}

function make(
  base: RowBase,
  asOf: string | null,
  now: number,
  body: { value: string; detail?: string | null } | { unknown: string },
): GoalMetricRow {
  const ms = asOf === null ? NaN : Date.parse(asOf);
  const stale = Number.isFinite(ms) && now - ms > GOALS_METRIC_STALE_MS;
  if ('unknown' in body) return { ...base, value: null, detail: null, unknownReason: body.unknown, asOf, stale };
  return { ...base, value: body.value, detail: body.detail ?? null, unknownReason: null, asOf, stale };
}

/** Resolve a MetricRead to its value, or to the row's unknown reason. */
function sourceDown<T>(read: MetricRead<T>, what: string): { value: T } | { unknown: string } {
  if (read.kind === 'ok') return { value: read.value };
  if (read.kind === 'pending') return { unknown: `${what} has not answered yet.` };
  return { unknown: read.reason };
}

// 1 — Phantom PRs landed in the rolling 24 h window (authority-ledger landings).
function mergedRow(read: MetricRead<FleetLiveSnapshotV1>, now: number): GoalMetricRow {
  const base: RowBase = { id: 'merged-24h', label: 'Merged PRs · 24 h', source: 'fleet live' };
  const got = sourceDown(read, 'The live fleet view');
  if ('unknown' in got) return make(base, null, now, got);
  const live = got.value;
  const asOf = live.generatedAt || null;
  const landings = live.merged24h;
  if (landings === undefined) return make(base, asOf, now, { unknown: 'This build does not report merged landings.' });
  if (landings === null) return make(base, asOf, now, { unknown: 'The landing ledger could not be read.' });
  const count = landings.filter((m) => m.repo.toLowerCase() === PHANTOM_REPO).length;
  return make(base, asOf, now, { value: String(count), detail: `recorded landings on ${PHANTOM_REPO}` });
}

// 2 — open PRs on ashlrai/phantom, and how many GitHub reports DIRTY (conflicting).
function openPrsRow(read: MetricRead<MergeBacklogReadV1>, now: number): GoalMetricRow {
  const base: RowBase = { id: 'open-prs', label: 'Open PRs', source: 'fleet backlog' };
  const got = sourceDown(read, 'The merge-backlog read');
  if ('unknown' in got) return make(base, null, now, got);
  const backlog = got.value;
  const asOf = backlog.generatedAt || null;
  if (backlog.source !== 'ok') {
    return make(base, asOf, now, { unknown: `GitHub could not list open PRs${backlog.reason ? ` (${backlog.reason})` : ''}.` });
  }
  const dirty = backlog.counts.mergeState['DIRTY'] ?? 0;
  return make(base, asOf, now, { value: String(backlog.items.length), detail: `${dirty} conflicting` });
}

function phantomRelease(releases: OpsReleasesV1): OpsRepoReleaseV1 | null {
  const repos = releases.repos;
  return repos.find((r) => r.repo.toLowerCase() === PHANTOM_REPO)
    ?? repos.find((r) => r.repo.toLowerCase() === 'phantom')
    ?? repos.find((r) => r.repo.toLowerCase().endsWith('/phantom'))
    ?? null;
}

// 3 — commits on master past the newest tag (the "unshipped" gap).
function unshippedRow(read: MetricRead<OpsReleasesV1>, now: number): GoalMetricRow {
  const base: RowBase = { id: 'unshipped', label: 'Unshipped commits', source: 'ops/releases' };
  const got = sourceDown(read, 'The releases read');
  if ('unknown' in got) return make(base, null, now, got);
  const releases = got.value;
  const asOf = releases.generatedAt || null;
  const repo = phantomRelease(releases);
  if (repo === null) return make(base, asOf, now, { unknown: 'No phantom checkout is enrolled.' });
  const since = repo.commitsSinceTag;
  if (since === undefined) return make(base, asOf, now, { unknown: 'This build does not report commits-since-tag.' });
  if (since === null) return make(base, asOf, now, { unknown: 'The checkout or its latest tag could not be read.' });
  return make(base, asOf, now, { value: String(since), detail: `on master since ${repo.latestTag ?? 'the last tag'}` });
}

// 4 — installed vs newest published whose desktop assets are verified.
function releaseRow(read: MetricRead<ReleaseStagesRead>, installedVersion: string | null, now: number): GoalMetricRow {
  const base: RowBase = { id: 'release-version', label: 'Installed vs newest', source: 'release/stages' };
  const got = sourceDown(read, 'The release-stages read');
  if ('unknown' in got) return make(base, null, now, got);
  const stages = got.value;
  const asOf = stages.checkedAt;
  if (stages.tag === null) {
    return make(base, asOf, now, { unknown: stages.reason ?? 'The newest release could not be read.' });
  }
  if (installedVersion === null) {
    return make(base, asOf, now, { unknown: 'The installed app version is unavailable.' });
  }
  const feed = stages.stages.find((s) => s.stage === 'feed-ready');
  const published = stages.stages.find((s) => s.stage === 'published');
  // A tag is "published with assets" when the update feed serves it, or when
  // the release itself carries all seven desktop update files.
  const installable = feed?.status === 'observed' ? feed.version : published?.status === 'observed' ? stages.tag : null;
  if (installable === null) {
    const reason = published?.reason;
    return make(base, asOf, now, { unknown: `${stages.tag} is published but its desktop assets are not verified${reason ? ` — ${reason}` : ''}.` });
  }
  const view = compareReleaseTags(installedVersion, installable);
  if (view.state === 'unknown') return make(base, asOf, now, { unknown: 'Version strings could not be compared.' });
  const plain = (v: string) => v.replace(/^v/i, '');
  const newest = plain(installable);
  const installed = plain(installedVersion);
  if (view.state === 'behind') return make(base, asOf, now, { value: `${installed} → ${newest}`, detail: 'newer release published' });
  if (view.state === 'ahead') return make(base, asOf, now, { value: `${installed} · ahead`, detail: `newest published ${newest}` });
  return make(base, asOf, now, { value: `${installed} · current`, detail: `newest published ${newest}` });
}

export function goalsMetrics(input: GoalsMetricsInput): GoalMetricRow[] {
  const now = input.now ?? Date.now();
  return [
    mergedRow(input.live, now),
    openPrsRow(input.backlog, now),
    unshippedRow(input.releases, now),
    releaseRow(input.stages, input.installedVersion, now),
  ];
}
