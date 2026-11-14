import { describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheck } from '../src/cli/fleet-recheck.js';
import { type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';

const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T13:12:00.000Z', ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};
const ledger: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0,
};
const channel = (c: 'slack' | 'imessage'): ChannelHealth => ({
  channel: c, configured: true, processAlive: true, runtimeHost: 'fake-host',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
  proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO,
});
const channels: ChannelHealthReport = { schemaVersion: 1, asOf: ISO, channels: [channel('slack'), channel('imessage')] };

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'fake-done-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
    receivedAt: '2026-11-13T13:00:00.000Z', state: 'VERIFIED', asOf: '2026-11-13T13:05:00.000Z',
    source: 'bus-reply:fake-reply-1', missing: [],
    owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-done-1:1:1700000000000', ...over,
  };
}

function deps(items: WorkBoardItem[], over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW, homeDir: () => HOME,
    readRuntimeIdentity: () => runtime, readFleetBoard: () => ledger, readChannelHealth: () => channels,
    listWorkBoard: (): WorkBoardResult => ({ items, inbox: 'ok', truncated: false }),
    listCoordination: () => ({ source: 'unavailable', claims: [] }),
    ...over,
  };
}

describe('fleet recheck text lines', () => {
  async function output(items: WorkBoardItem[]): Promise<{ code: number; lines: string[] }> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await cmdFleetRecheck([], deps(items));
      return { code, lines: log.mock.calls.map(call => String(call[0])) };
    } finally {
      log.mockRestore();
    }
  }

  it('prints one TASK verdict with last verified evidence', async () => {
    const result = await output([item()]);
    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(5);
    expect(result.lines.map(line => line.split(' ')[0])).toEqual(['RUNTIME', 'CLAIMS', 'BRIDGE', 'TASK', 'OVERALL']);
    expect(result.lines.filter(line => line.startsWith('TASK '))).toHaveLength(1);
    expect(result.lines[3]).toContain('last-verified=fake-done-1@2026-11-13T13:05:00.000Z');
    expect(result.lines[3]).toContain('last-verified-owner=agent-alpha');
  });

  it('prints none when there is no verified item', async () => {
    const result = await output([]);
    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(5);
    expect(result.lines[3]).toContain('last-verified=none');
  });

  it('flattens newlines and strips terminal escapes from evidence', async () => {
    const result = await output([item({ id: 'fake-done-1\n\u001b[2Jfake' })]);
    expect(result.code).toBe(1);
    expect(result.lines).toHaveLength(5);
    expect(result.lines.join('\n')).not.toContain('\u001b');
    expect(result.lines[3]).toContain('last-verified=fake-done-1 fake@');
  });
});
