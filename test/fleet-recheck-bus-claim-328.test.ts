/** RQ-PHX-RECHECKBUSCLAIMVERIFY328 — the task section verifies its work-board
 * pick against the bus-work-claims row the board bound it to: the receipt
 * `bus-claim:<id>:<cursor>:<receivedAt>` is rebuilt from each inspected row and
 * compared whole (a claim id may itself contain ':'), and the task verifies
 * only when the table is available, exactly one row matches, the row's owner
 * equals the board owner, the claim is not completed, and its lease is live at
 * the verdict's clock. A coordination-ledger owner match is never task
 * identity: ledgerClaim stays null and the ledger read no longer gates the
 * verdict, though a live owner claim still ranks picks. Every reader is faked
 * here: nothing touches the real home, ledger, bus or network. Fixtures are
 * plainly fake; no message bodies, leases or env values appear. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { BusWorkClaimsInspection, BusWorkClaimView } from '../src/core/fleet/bus-work-claims.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-14T13:13:00.000Z');
const NOW_MS = NOW.getTime();
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';
const RECEIPT = 'bus-claim:fake-request-1:1:1700000000000';
const LEASE_UNTIL = new Date(NOW_MS + 3_600_000).toISOString();

const healthyRuntime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-14T13:12:00.000Z', ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};

function fakeClaim(over: Partial<FleetClaim> = {}): FleetClaim {
  return {
    id: 'fake-claim-1', repo: 'ashlrai/phantom', task: 'fake ledger task',
    agent: 'agent-alpha', claimedAt: NOW_MS - 1_000, expiresAt: NOW_MS + 3_600_000, ...over,
  };
}

const healthyBoard: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known',
  claims: [fakeClaim()],
  messages: [], proposals: [], expiredClaims: 0,
};

function fakeChannel(channel: 'slack' | 'imessage', over: Partial<ChannelHealth> = {}): ChannelHealth {
  return {
    channel, configured: true, processAlive: true, runtimeHost: 'fake-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 },
    state: 'LIVE', missing: [], asOf: ISO, ...over,
  };
}

const healthyChannels: ChannelHealthReport = {
  schemaVersion: 1, asOf: ISO,
  channels: [fakeChannel('slack'), fakeChannel('imessage')],
};

function fakeItem(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'fake-request-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
    receivedAt: '2026-11-14T13:11:00.000Z', state: 'RUNNING', asOf: ISO,
    source: `bus-work-claims lease-until ${LEASE_UNTIL}`, missing: [],
    owner: 'agent-alpha', claimReceipt: RECEIPT, ...over,
  };
}

function fakeBusClaim(over: Partial<BusWorkClaimView> = {}): BusWorkClaimView {
  return {
    id: 'fake-request-1', cursor: 1, receivedAt: 1_700_000_000_000,
    owner: 'agent-alpha', leaseUntil: NOW_MS + 3_600_000, completedAt: null, ...over,
  };
}

const healthyBusClaims: BusWorkClaimsInspection = { source: 'available', claims: [fakeBusClaim()] };
const healthyWork: WorkBoardResult = { items: [fakeItem()], inbox: 'ok', truncated: false };

function deps(over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => HOME,
    readRuntimeIdentity: () => healthyRuntime,
    readFleetBoard: () => healthyBoard,
    readChannelHealth: () => healthyChannels,
    listWorkBoard: () => healthyWork,
    inspectBusWorkClaims: () => healthyBusClaims,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fleet recheck task ↔ bus claim binding', () => {
  it('verifies the task against the bound row and fills busClaim when every section verifies', async () => {
    const recheck = await readFleetRecheck(deps());
    expect(recheck.sections.task.state).toBe('VERIFIED');
    expect(recheck.sections.task.missing).toEqual([]);
    expect(recheck.sections.task.task).toEqual({
      id: 'fake-request-1', state: 'RUNNING', owner: 'agent-alpha', claimReceipt: RECEIPT,
      ledgerClaim: null,
      busClaim: { owner: 'agent-alpha', leaseUntil: LEASE_UNTIL, completedAt: null },
      asOf: ISO, source: `bus-work-claims lease-until ${LEASE_UNTIL}`,
    });
    for (const name of ['runtime', 'claims', 'bridge'] as const) {
      expect(recheck.sections[name].state).toBe('VERIFIED');
    }
    expect(recheck.overall).toEqual({ state: 'VERIFIED', missing: [] });
  });

  it('reports UNKNOWN with the table source when the claims table is missing or unavailable', async () => {
    for (const source of ['missing', 'unavailable'] as const) {
      const recheck = await readFleetRecheck(deps({
        inspectBusWorkClaims: () => ({ source, claims: [] }),
      }));
      expect(recheck.sections.task.state).toBe('UNKNOWN');
      expect(recheck.sections.task.task?.busClaim).toBeNull();
      expect(recheck.sections.task.missing).toEqual([`task: bus work claims ${source}`]);
      expect(recheck.overall.state).toBe('UNKNOWN');
    }
  });

  it('reports UNKNOWN when the bus claims reader throws', async () => {
    const recheck = await readFleetRecheck(deps({
      inspectBusWorkClaims: () => { throw new Error('claims table exploded'); },
    }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual(['task: bus work claims reader failed']);
    expect(recheck.sections.runtime.state).toBe('VERIFIED');
    expect(recheck.sections.claims.state).toBe('VERIFIED');
    expect(recheck.sections.bridge.state).toBe('VERIFIED');
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('reports UNKNOWN when the bus claims reader stalls past the section bound', async () => {
    vi.useFakeTimers();
    const pending = readFleetRecheck(deps({
      inspectBusWorkClaims: () => new Promise<BusWorkClaimsInspection>(() => {}),
    }));
    await vi.advanceTimersByTimeAsync(5_000);
    const recheck = await pending;
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual(['task: bus work claims reader failed']);
    expect(recheck.sections.runtime.state).toBe('VERIFIED');
    expect(recheck.sections.claims.state).toBe('VERIFIED');
    expect(recheck.sections.bridge.state).toBe('VERIFIED');
  });

  it('reports UNKNOWN when no row matches the receipt, including two matching rows', async () => {
    for (const claims of [
      [] as BusWorkClaimView[],
      [fakeBusClaim({ owner: 'agent-beta' }), fakeBusClaim()],
    ]) {
      const recheck = await readFleetRecheck(deps({
        inspectBusWorkClaims: () => ({ source: 'available', claims }),
      }));
      expect(recheck.sections.task.state).toBe('UNKNOWN');
      expect(recheck.sections.task.task?.busClaim).toBeNull();
      expect(recheck.sections.task.missing).toEqual([`task: no bus claim row matches receipt ${RECEIPT}`]);
    }
  });

  it('reports UNKNOWN when the bound row names a different owner', async () => {
    const recheck = await readFleetRecheck(deps({
      inspectBusWorkClaims: () => ({ source: 'available', claims: [fakeBusClaim({ owner: 'agent-beta' })] }),
    }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual(['task: bus claim owner differs from board owner']);
    expect(recheck.sections.task.task?.busClaim).toBeNull();
  });

  it('reports UNKNOWN with the completion stamp when the bound claim completed', async () => {
    const recheck = await readFleetRecheck(deps({
      inspectBusWorkClaims: () => ({ source: 'available', claims: [fakeBusClaim({ completedAt: NOW_MS - 500 })] }),
    }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual([
      `task: bus claim for fake-request-1 completed at ${new Date(NOW_MS - 500).toISOString()}`,
    ]);
  });

  it('reports UNKNOWN with the expiry stamp when the bound lease is dead at the verdict now', async () => {
    for (const leaseUntil of [NOW_MS - 1, NOW_MS]) {
      const recheck = await readFleetRecheck(deps({
        inspectBusWorkClaims: () => ({ source: 'available', claims: [fakeBusClaim({ leaseUntil })] }),
      }));
      expect(recheck.sections.task.state).toBe('UNKNOWN');
      expect(recheck.sections.task.missing).toEqual([
        `task: bus claim lease for fake-request-1 expired at ${new Date(leaseUntil).toISOString()}`,
      ]);
    }
  });

  it('reports UNKNOWN when the verdict clock is unreadable and a bound row exists', async () => {
    const recheck = await readFleetRecheck(deps({ now: () => new Date(Number.NaN) }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual(['task: verdict clock unknown, bus claim lease unverifiable']);
  });

  it('matches a receipt whose claim id itself contains colons', async () => {
    const receipt = 'bus-claim:job:alpha:1:7:1700000000000';
    const work: WorkBoardResult = {
      inbox: 'ok', truncated: false,
      items: [fakeItem({ id: 'job:alpha:1', claimReceipt: receipt })],
    };
    const recheck = await readFleetRecheck(deps({
      listWorkBoard: () => work,
      inspectBusWorkClaims: () => ({
        source: 'available',
        claims: [fakeBusClaim({ id: 'job', cursor: 99, receivedAt: 1 }), fakeBusClaim({ id: 'job:alpha:1', cursor: 7, receivedAt: 1_700_000_000_000 })],
      }),
    }));
    expect(recheck.sections.task.state).toBe('VERIFIED');
    expect(recheck.sections.task.task?.claimReceipt).toBe(receipt);
  });

  it('never verifies on a live coordination-ledger claim alone', async () => {
    const recheck = await readFleetRecheck(deps({
      inspectBusWorkClaims: () => ({ source: 'missing', claims: [] }),
    }));
    // The owner holds a live ledger claim; without the bound bus row the pick
    // stays UNKNOWN with ledgerClaim null — owner equality is not identity.
    expect(recheck.sections.claims.active).toBe(1);
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.missing).toEqual(['task: bus work claims missing']);
  });

  it('prefers the qualified item whose bus claim would verify over plain ordering', async () => {
    const work: WorkBoardResult = {
      inbox: 'ok', truncated: false,
      items: [
        // Newest but unverifiable: no claim row matches this receipt.
        fakeItem({ id: 'newer-running', claimReceipt: 'bus-claim:newer-running:2:1700000000001', receivedAt: '2026-11-14T13:12:00.000Z' }),
        // Older, ASSIGNED, yet bound to the live claim row.
        fakeItem({ id: 'fake-request-1', state: 'ASSIGNED', receivedAt: '2026-11-14T13:05:00.000Z' }),
      ],
    };
    const recheck = await readFleetRecheck(deps({ listWorkBoard: () => work }));
    expect(recheck.sections.task.state).toBe('VERIFIED');
    expect(recheck.sections.task.task).toMatchObject({ id: 'fake-request-1', state: 'ASSIGNED' });
  });
});
