/**
 * routes/verse/fleet/FleetCards.lanecapacity.test.tsx — through the real
 * path: a fake dispatchd runs dir → readLaneCapacity → the live snapshot's
 * stale-tick substitution → LanesStrip. A fresh status write puts real
 * running/target on the chips and the "Lane capacity is unobserved" note
 * never renders; a stale write keeps it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { DaemonLivenessV1 } from '../../../../core/daemon/liveness.js';
import { readLaneCapacity } from '../../../../core/fleet/lane-capacity-read.js';
import type { EffectivePolicy } from '../../../../core/authority/types.js';
import { buildFleetLiveSnapshot, type FleetLiveDeps } from '../../../../core/verse/fleet-live-api.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { resetLaneHistory } from './lane-history-store.js';
import { LanesStrip } from './FleetCards.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const MIN = 60_000;
const tick = (ageMs: number) => new Date(NOW - ageMs).toISOString();

const ALIVE = {
  v: 1, checkedAt: tick(0), state: 'alive', alive: true, pid: 123,
  recorded: { running: true, pid: 123, startedAt: tick(3_600_000), lastTickAt: tick(MIN) },
  lock: null, activity: null, staleRecord: false, reason: 'daemon is running',
} as DaemonLivenessV1;

const POLICY: EffectivePolicy = {
  v: 1, grantId: 'g', grantSeq: 1, keyId: 'k', issuedAt: tick(86_400_000), expiresAt: new Date(NOW + 3_600_000).toISOString(), switch: 'autonomous',
  rollout: { stageId: '2a', stageIndex: 1, stageCount: 5, enteredAt: tick(3_600_000) },
  repos: [{ nameWithOwner: 'ashlrai/phantom', stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null }],
  merge: { maxFiles: 4, maxLines: 150, selfRepo: 'propose-only', localAuthored: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } },
  spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats: {} }, engines: ['devin-cli'], leader: { classes: ['A'], vetoMinutes: 30 },
  conductorGoals: false, computedAt: tick(0),
};

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  evictAll();
  resetLaneHistory();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lane-capacity-live-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'queue', name), text);
  return dir;
}

/** The producer's deps: every source stubbed except laneCapacity, which reads the fake runs dir for real. */
function liveDeps(dir: string): FleetLiveDeps {
  return {
    now: () => NOW, policy: () => POLICY, killSwitch: () => 'inactive', paused: () => false, liveness: () => ALIVE,
    tickState: () => null, journal: async () => [], holds: () => [], tasks: () => ({ ok: true, tasks: [] }),
    ledger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    setHold: () => ({ ok: true, reason: null, before: null, after: null }),
    inFlight: () => [], enrolled: () => [], isMirror: () => false, repoIdentity: () => null,
    watches: () => [], dispatchStarts: async () => new Map(),
    fleetTruth: async (since, now) => ({ windowStartMs: since, windowEndMs: now, mergeCountState: 'ok', truncated: false, running: null, queued: null, merged: [] }),
    laneCapacity: (nowMs) => readLaneCapacity(dir, nowMs),
  };
}

const status = (lanes: unknown, lastTick: unknown = tick(2 * MIN)) =>
  JSON.stringify({ schema: 'dispatchd.status.v1', last_tick: lastTick, paused: null, mem_free_pct: 42, lanes });

describe('LanesStrip lane capacity from dispatchd', () => {
  it('shows dispatchd running/target and the held reason instead of "unobserved"', async () => {
    const dir = await runsDir({
      'status.json': status({
        devin: { running: 7, target: 10, floor: 1, ceiling: 12, held: false, queued: 712 },
        claude: { running: 0, target: 8, floor: 0, ceiling: 8, held: true, queued: 0 },
      }),
      'slots.json': JSON.stringify({ claude: { target: 8, floor: 0, ceiling: 8, held: true, held_reason: 'credits exhausted (anthropic)' } }),
    });
    stubSurfaceFetch({ kind: 'live', now: NOW, routes: { '/api/verse/fleet/runs': null } });
    const { snapshot } = await buildFleetLiveSnapshot(liveDeps(dir));
    expect(snapshot.lanes.find((l) => l.lane === 'devin-cli')).toMatchObject({ slots: 10, busy: 7, capReason: null });
    render(<LanesStrip live={snapshot} />);
    const lanes = await screen.findByRole('list', { name: 'Lanes: busy of slots' });
    expect(within(lanes).getByText('Devin CLI').closest('li')!).toHaveTextContent('7/10');
    expect(within(lanes).getByText('Claude').closest('li')!).toHaveTextContent('0/8');
    const notes = screen.getByRole('list', { name: 'Why lanes are limited' });
    expect(notes).toHaveTextContent('Held by the dispatcher: credits exhausted (anthropic)');
    expect(notes).not.toHaveTextContent('unobserved');
    expect(screen.queryByText('capacity unknown')).not.toBeInTheDocument();
  });

  it('keeps the unobserved reason on the snapshot when the write is stale', async () => {
    const dir = await runsDir({ 'status.json': status({ devin: { running: 7, target: 10, held: false, queued: 1 } }, tick(30 * MIN)) });
    const { snapshot } = await buildFleetLiveSnapshot(liveDeps(dir));
    expect(snapshot.lanes.find((l) => l.lane === 'devin-cli')).toMatchObject({
      slots: 0,
      capReason: 'No standing tick has reported lanes in the last 10 minutes.',
    });
  });
});
