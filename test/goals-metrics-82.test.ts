/**
 * goals-metrics-82.test.ts — the Goals panel's four-number strip
 * (RQ-PHX-GOALSLIVEMETRICS82). The contract under test: a number the server
 * cannot supply is "unknown" with the reason, never 0 — and each row names
 * its source and as-of time, flagged stale past GOALS_METRIC_STALE_MS.
 */
import { describe, expect, it } from 'vitest';
import {
  GOALS_METRIC_STALE_MS,
  goalsMetrics,
  metricReadOf,
  narrowReleaseStages,
  optionalMetricReadOf,
  type GoalMetricRow,
  type MetricRead,
  type ReleaseStagesRead,
} from '../src/web-ui/routes/verse/autonomy/goals-metrics.js';
import type { FleetLiveSnapshotV1 } from '../src/core/fleet/fleet-types.js';
import type { MergeBacklogReadV1 } from '../src/core/fleet/merge-backlog-read.js';
import type { OpsReleasesV1 } from '../src/core/verse/ops-types.js';
import type { OptionalFleetRead } from '../src/web-ui/routes/verse/autonomy/fleet-contract.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const ISO = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const ok = <T>(value: T): MetricRead<T> => ({ kind: 'ok', value });
const pending = <T>(): MetricRead<T> => ({ kind: 'pending' });
const down = <T>(reason: string): MetricRead<T> => ({ kind: 'unavailable', reason });

function liveSnapshot(over: Partial<FleetLiveSnapshotV1> = {}): FleetLiveSnapshotV1 {
  return {
    v: 1,
    generatedAt: ISO(60_000),
    state: 'running',
    stateReason: null,
    lastActivityAt: ISO(30_000),
    merged24h: [
      { id: 'ashlrai/phantom#1@abc', repo: 'ashlrai/phantom', prNumber: 1, landedAt: ISO(3_600_000) },
      { id: 'ashlrai/phantom#2@def', repo: 'ashlrai/phantom', prNumber: 2, landedAt: ISO(2_600_000) },
      { id: 'ashlrai/other#9@123', repo: 'ashlrai/other', prNumber: 9, landedAt: ISO(1_000_000) },
    ],
    summary: {
      building: null, queued: null, parked: null, waitingVerify: null,
      mergedToday: null, revertsToday: null, merged7d: null,
      postMergeGreenPct7d: null, cycleTimeP50Ms7d: null,
    },
    lanes: [],
    runs: [],
    funnel: null,
    repos: [],
    ...over,
  };
}

function backlog(over: Partial<MergeBacklogReadV1> = {}): MergeBacklogReadV1 {
  return {
    v: 1,
    repo: 'ashlrai/phantom',
    generatedAt: ISO(90_000),
    source: 'ok',
    items: [1, 2, 3].map((number) => ({
      number,
      title: `PR ${number}`,
      headRef: `rq-${number}`,
      updatedAt: null,
      mergeStateStatus: number === 3 ? 'CLEAN' : 'DIRTY',
      isDraft: false,
      job: null,
      classification: { class: 'conflicted', work: 'recut', reason: 'fixture' },
      suggestedAction: 'recut',
    })),
    counts: {
      mergeState: { DIRTY: 2, CLEAN: 1 },
      actions: { merge: 0, recut: 2, refresh: 0, wait: 1, none: 0 },
    },
    ...over,
  };
}

function releases(over: Partial<OpsReleasesV1> = {}): OpsReleasesV1 {
  return {
    v: 1,
    generatedAt: ISO(120_000),
    sourceState: 'healthy',
    repos: [{
      repo: 'ashlrai/phantom',
      path: '/Users/m/Projects/phantom',
      version: '3.30.31',
      latestTag: 'v3.30.31',
      commitsSinceTag: 14,
      releaseWorkflow: 'release.yml',
      gh: {
        latestRelease: { tag: 'v3.30.31', name: null, publishedAt: ISO(3_600_000), draft: false, prerelease: false },
        latestRun: null,
      },
      notes: [],
    }],
    ...over,
  };
}

function stages(over: Partial<ReleaseStagesRead> = {}): ReleaseStagesRead {
  return {
    tag: 'v3.30.31',
    checkedAt: ISO(60_000),
    reason: null,
    stages: [
      { stage: 'published', status: 'observed', version: 'v3.30.31', reason: null },
      { stage: 'feed-ready', status: 'observed', version: '3.30.31', reason: null },
    ],
    ...over,
  };
}

function metrics(over: Partial<Parameters<typeof goalsMetrics>[0]> = {}): GoalMetricRow[] {
  return goalsMetrics({
    live: ok(liveSnapshot()),
    backlog: ok(backlog()),
    releases: ok(releases()),
    stages: ok(stages()),
    installedVersion: '3.30.31',
    now: NOW,
    ...over,
  });
}

const row = (rows: GoalMetricRow[], id: GoalMetricRow['id']) => rows.find((r) => r.id === id)!;

describe('goalsMetrics — all four sources answering', () => {
  it('counts only phantom landings in the last 24 h', () => {
    const merged = row(metrics(), 'merged-24h');
    expect(merged.value).toBe('2');
    expect(merged.unknownReason).toBeNull();
    expect(merged.source).toBe('fleet live');
    expect(merged.asOf).toBe(ISO(60_000));
    expect(merged.stale).toBe(false);
  });

  it('reports open PRs with the conflicting share', () => {
    const open = row(metrics(), 'open-prs');
    expect(open.value).toBe('3');
    expect(open.detail).toBe('2 conflicting');
  });

  it('reports commits on master since the newest tag', () => {
    const unshipped = row(metrics(), 'unshipped');
    expect(unshipped.value).toBe('14');
    expect(unshipped.detail).toBe('on master since v3.30.31');
  });

  it('reports installed vs newest published when assets are verified', () => {
    const release = row(metrics(), 'release-version');
    expect(release.value).toBe('3.30.31 · current');
    expect(release.detail).toBe('newest published 3.30.31');
  });

  it('shows installed → newest when a verified newer release exists', () => {
    const release = row(metrics({ installedVersion: '3.29.15' }), 'release-version');
    expect(release.value).toBe('3.29.15 → 3.30.31');
    expect(release.detail).toBe('newer release published');
  });
});

describe('goalsMetrics — each missing source is unknown with a reason, never 0', () => {
  it('live fleet view unavailable', () => {
    const merged = row(metrics({ live: down('The live fleet view is not in this build yet.') }), 'merged-24h');
    expect(merged.value).toBeNull();
    expect(merged.unknownReason).toBe('The live fleet view is not in this build yet.');
    expect(merged.asOf).toBeNull();
  });

  it('merged24h null means the ledger, not zero merges', () => {
    const merged = row(metrics({ live: ok(liveSnapshot({ merged24h: null })) }), 'merged-24h');
    expect(merged.value).toBeNull();
    expect(merged.unknownReason).toBe('The landing ledger could not be read.');
  });

  it('merged24h absent means an older server build', () => {
    const merged = row(metrics({ live: ok(liveSnapshot({ merged24h: undefined })) }), 'merged-24h');
    expect(merged.value).toBeNull();
    expect(merged.unknownReason).toBe('This build does not report merged landings.');
  });

  it('a real zero still renders', () => {
    const merged = row(metrics({ live: ok(liveSnapshot({ merged24h: [] })) }), 'merged-24h');
    expect(merged.value).toBe('0');
  });

  it('gh-failed backlog names the gh reason', () => {
    const open = row(metrics({ backlog: ok(backlog({ source: 'gh-failed', reason: 'gh-pr-list-failed', items: [] })) }), 'open-prs');
    expect(open.value).toBeNull();
    expect(open.unknownReason).toBe('GitHub could not list open PRs (gh-pr-list-failed).');
  });

  it('commitsSinceTag null and undefined are different unknowns', () => {
    const uncounted = releases();
    uncounted.repos[0]!.commitsSinceTag = null;
    expect(row(metrics({ releases: ok(uncounted) }), 'unshipped').unknownReason)
      .toBe('The checkout or its latest tag could not be read.');
    const unreported = releases();
    unreported.repos[0]!.commitsSinceTag = undefined;
    expect(row(metrics({ releases: ok(unreported) }), 'unshipped').unknownReason)
      .toBe('This build does not report commits-since-tag.');
  });

  it('no phantom checkout enrolled is unknown, not zero', () => {
    expect(row(metrics({ releases: ok({ ...releases(), repos: [] }) }), 'unshipped').unknownReason)
      .toBe('No phantom checkout is enrolled.');
  });

  it('a newest release without verified assets is unknown with the tag named', () => {
    const unverified = stages({
      stages: [
        { stage: 'published', status: 'unknown', version: null, reason: 'desktop asset evidence incomplete; retry' },
        { stage: 'feed-ready', status: 'unknown', version: null, reason: 'feed unavailable or unsupported' },
      ],
    });
    const release = row(metrics({ stages: ok(unverified) }), 'release-version');
    expect(release.value).toBeNull();
    expect(release.unknownReason).toContain('v3.30.31 is published but its desktop assets are not verified');
    expect(release.unknownReason).toContain('desktop asset evidence incomplete; retry');
  });

  it('an unreadable newest release uses the route reason', () => {
    const release = row(metrics({ stages: ok(stages({ tag: null, reason: 'release unavailable; retry' })) }), 'release-version');
    expect(release.value).toBeNull();
    expect(release.unknownReason).toBe('release unavailable; retry');
  });

  it('missing installed version is unknown', () => {
    const release = row(metrics({ installedVersion: null }), 'release-version');
    expect(release.value).toBeNull();
    expect(release.unknownReason).toBe('The installed app version is unavailable.');
  });

  it('a pending read is "not answered yet", not a failure', () => {
    const rows = metrics({ backlog: pending() });
    expect(row(rows, 'open-prs').unknownReason).toBe('The merge-backlog read has not answered yet.');
    expect(row(rows, 'merged-24h').value).toBe('2');
  });
});

describe('goalsMetrics — staleness', () => {
  it('flags an as-of older than GOALS_METRIC_STALE_MS', () => {
    const old = liveSnapshot({ generatedAt: ISO(GOALS_METRIC_STALE_MS + 1) });
    expect(row(metrics({ live: ok(old) }), 'merged-24h').stale).toBe(true);
    expect(row(metrics(), 'merged-24h').stale).toBe(false);
  });

  it('a missing or future as-of is not flagged stale', () => {
    const release = row(metrics({ stages: ok(stages({ checkedAt: null })) }), 'release-version');
    expect(release.asOf).toBeNull();
    expect(release.stale).toBe(false);
    const future = liveSnapshot({ generatedAt: new Date(NOW + 60_000).toISOString() });
    expect(row(metrics({ live: ok(future) }), 'merged-24h').stale).toBe(false);
  });
});

describe('read adapters', () => {
  it('metricReadOf maps undefined→pending, error→unavailable, null→unavailable, value→ok', () => {
    expect(metricReadOf({ data: undefined, status: 'loading' })).toEqual({ kind: 'pending' });
    expect(metricReadOf({ data: undefined, status: 'error', error: new Error('boom') }))
      .toEqual({ kind: 'unavailable', reason: 'boom' });
    expect(metricReadOf({ data: null, status: 'success' }, 'no route'))
      .toEqual({ kind: 'unavailable', reason: 'no route' });
    expect(metricReadOf({ data: { n: 1 }, status: 'success' })).toEqual({ kind: 'ok', value: { n: 1 } });
    // Stale data plus a refresh error still wins on the data it has.
    expect(metricReadOf({ data: { n: 1 }, status: 'error', error: new Error('later') }))
      .toEqual({ kind: 'ok', value: { n: 1 } });
  });

  it('optionalMetricReadOf unwraps the absent-source envelope', () => {
    const absent: OptionalFleetRead<number> = { value: null, available: false, reason: 'not in this build' };
    expect(optionalMetricReadOf({ data: absent, status: 'success' }))
      .toEqual({ kind: 'unavailable', reason: 'not in this build' });
    const unrecognized: OptionalFleetRead<number> = { value: null, available: true, reason: 'Unrecognized response — update Phantom.' };
    expect(optionalMetricReadOf({ data: unrecognized, status: 'success' }))
      .toEqual({ kind: 'unavailable', reason: 'Unrecognized response — update Phantom.' });
    const present: OptionalFleetRead<number> = { value: 7, available: true, reason: null };
    expect(optionalMetricReadOf({ data: present, status: 'success' })).toEqual({ kind: 'ok', value: 7 });
  });
});

describe('narrowReleaseStages', () => {
  it('keeps tag, checkedAt, reason and stage rows', () => {
    const read = narrowReleaseStages({
      schema: 'verse.release-stages.v1',
      repo: 'ashlrai/phantom',
      tag: 'v3.30.31',
      checkedAt: '2026-11-10T11:59:00.000Z',
      stages: [{ stage: 'published', status: 'observed', version: 'v3.30.31', reason: null }],
    });
    expect(read).toMatchObject({ tag: 'v3.30.31', checkedAt: '2026-11-10T11:59:00.000Z', reason: null });
    expect(read!.stages).toHaveLength(1);
  });

  it('rejects other shapes and keeps a top-level refusal reason', () => {
    expect(narrowReleaseStages(null)).toBeNull();
    expect(narrowReleaseStages({ schema: 'other' })).toBeNull();
    const refused = narrowReleaseStages({ schema: 'verse.release-stages.v1', tag: null, checkedAt: 'x', stages: [], reason: 'release unavailable; retry' });
    expect(refused).toMatchObject({ tag: null, checkedAt: null, reason: 'release unavailable; retry' });
  });
});
