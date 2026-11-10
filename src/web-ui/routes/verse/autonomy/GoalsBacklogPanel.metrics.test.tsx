/**
 * GoalsBacklogPanel.metrics.test.tsx — the live-metrics strip at the top of
 * the Goals panel (RQ-PHX-GOALSLIVEMETRICS82): four tiles, each with its
 * source and as-of time, and a number the server cannot supply renders
 * "unknown" with the reason — never 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { APP_VERSION } from '../sections/app-version.js';
import { GoalsBacklogPanel } from './GoalsBacklogPanel.js';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

const NOW = Date.now();
const ISO = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const fleetLive = {
  v: 1,
  generatedAt: ISO(60_000),
  state: 'running',
  stateReason: null,
  lastActivityAt: ISO(30_000),
  merged24h: [
    { id: 'a', repo: 'ashlrai/phantom', prNumber: 1, landedAt: ISO(3_600_000) },
    { id: 'b', repo: 'ashlrai/phantom', prNumber: 2, landedAt: ISO(2_600_000) },
    { id: 'c', repo: 'ashlrai/other', prNumber: 9, landedAt: ISO(1_000_000) },
  ],
  summary: {},
  lanes: [],
  runs: [],
  funnel: null,
  repos: [],
};

const fleetBacklogOk = {
  v: 1,
  repo: 'ashlrai/phantom',
  generatedAt: ISO(90_000),
  source: 'ok',
  items: [
    { number: 11, title: 'Fix', headRef: 'rq-a', updatedAt: null, mergeStateStatus: 'DIRTY', isDraft: false, job: null, classification: { class: 'conflicted', work: 'recut', reason: 'x' }, suggestedAction: 'recut' },
    { number: 12, title: 'Fix 2', headRef: 'rq-b', updatedAt: null, mergeStateStatus: 'CLEAN', isDraft: false, job: null, classification: { class: 'green-ready', work: 'merge', reason: 'x' }, suggestedAction: 'merge' },
  ],
  counts: { mergeState: { DIRTY: 1, CLEAN: 1 }, actions: { merge: 1, recut: 1, refresh: 0, wait: 0, none: 0 } },
};

const fleetBacklogFailed = {
  v: 1,
  repo: 'ashlrai/phantom',
  generatedAt: ISO(90_000),
  source: 'gh-failed',
  reason: 'gh-pr-list-failed',
  items: [],
  counts: { mergeState: {}, actions: { merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 } },
};

const opsReleases = {
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
};

const releaseStages = {
  schema: 'verse.release-stages.v1',
  repo: 'ashlrai/phantom',
  tag: 'v3.30.99',
  checkedAt: ISO(60_000),
  stages: [
    { stage: 'published', status: 'observed', version: 'v3.30.99', reason: null },
    { stage: 'feed-ready', status: 'observed', version: '3.30.99', reason: null },
  ],
};

function stubReads(backlog: unknown = fleetBacklogOk) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/verse/fleet/live')) return json(fleetLive);
    if (url.startsWith('/api/verse/github/fleet-backlog')) return json(backlog);
    if (url.startsWith('/api/verse/ops/releases')) return json(opsReleases);
    if (url.startsWith('/api/verse/release/stages')) return json(releaseStages);
    if (url.startsWith('/api/goals')) return json([]);
    if (url.startsWith('/api/backlog')) return json(null);
    return new Response('not found', { status: 404 });
  }));
}

beforeEach(() => evictAll());
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('GoalsBacklogPanel metrics strip', () => {
  it('renders four tiles, each with value, source and as-of time', async () => {
    stubReads();
    render(<GoalsBacklogPanel />);
    const strip = await screen.findByRole('list', { name: 'Live metrics' });
    const tiles = within(strip).getAllByRole('listitem');
    expect(tiles).toHaveLength(4);

    expect(within(tiles[0]!).getByText('Merged PRs · 24 h')).toBeInTheDocument();
    expect(within(tiles[0]!).getByText('2')).toBeInTheDocument();
    expect(within(tiles[0]!).getByText(/fleet live · as of /)).toBeInTheDocument();

    expect(within(tiles[1]!).getByText('Open PRs')).toBeInTheDocument();
    expect(within(tiles[1]!).getByText('2')).toBeInTheDocument();
    expect(within(tiles[1]!).getByText('1 conflicting')).toBeInTheDocument();

    expect(within(tiles[2]!).getByText('Unshipped commits')).toBeInTheDocument();
    expect(within(tiles[2]!).getByText('14')).toBeInTheDocument();
    expect(within(tiles[2]!).getByText('on master since v3.30.31')).toBeInTheDocument();

    expect(within(tiles[3]!).getByText('Installed vs newest')).toBeInTheDocument();
    expect(within(tiles[3]!).getByText(`${APP_VERSION} → 3.30.99`)).toBeInTheDocument();
    expect(within(tiles[3]!).getByText(/release\/stages · as of /)).toBeInTheDocument();
  });

  it('shows unknown with the reason when a source cannot supply a number', async () => {
    stubReads(fleetBacklogFailed);
    render(<GoalsBacklogPanel />);
    const strip = await screen.findByRole('list', { name: 'Live metrics' });
    const tiles = within(strip).getAllByRole('listitem');
    const open = tiles[1]!;
    expect(within(open).getByText('unknown')).toBeInTheDocument();
    expect(within(open).getByText('GitHub could not list open PRs (gh-pr-list-failed).')).toBeInTheDocument();
    // The other three still render their numbers.
    expect(within(tiles[0]!).getByText('2')).toBeInTheDocument();
    expect(within(tiles[2]!).getByText('14')).toBeInTheDocument();
  });
});
