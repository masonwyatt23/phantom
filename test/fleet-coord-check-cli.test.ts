/** RQ-PHX-COORDCHECK320 — `ashlr fleet coord-check` prints the composed report
 * as JSON or one section per part plus a verdict line; exit 0 REACHABLE, 3
 * BLOCKED, 2 on bad args, and the verb is registered with the fleet loader. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordCheck } from '../src/cli/fleet-coord-check.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { CoordCheckDeps } from '../src/core/fleet/coord-check.js';
import type { ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T18:13:00.000Z');
const ISO = NOW.toISOString();
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const runtime = (stale: boolean | 'unknown' = false): RuntimeIdentity => ({
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: {
    path: '~/state.json', mtime: ago(stale === true ? 47 : 1),
    ageSeconds: stale === true ? 47 * 60 : 60, stale,
  },
  tailnetName: 'fake-tailnet-node', reasons: [],
});

const channels = (): ChannelHealthReport => ({
  schemaVersion: 1, asOf: ISO,
  channels: ['slack', 'imessage'].map(channel => ({
    channel: channel as 'slack' | 'imessage', configured: true, processAlive: true,
    runtimeHost: 'fake-host', lastInboundAt: null, lastReplyAt: null,
    unansweredCount: 0, state: 'LIVE' as const, missing: [], asOf: ISO,
  })),
});

const boardItem: WorkBoardItem = {
  id: 'rq-dot-bridge-9', channel: 'slack', channelRef: 'T0/C0/1700000000.000101',
  receivedAt: ago(3), state: 'RUNNING', asOf: ago(3), source: 'runs-ledger',
  missing: [], owner: 'fake-bridge-owner', claimReceipt: 'bus-claim:rq-dot-bridge-9:1:1700000000101',
};
const board = (items: WorkBoardItem[] = [boardItem]): WorkBoardResult => ({ items, inbox: 'ok', truncated: false });

const deps = (over: Partial<CoordCheckDeps> = {}): CoordCheckDeps => ({
  now: () => NOW,
  homeDir: () => '/home/fakeuser',
  readRuntime: () => runtime(),
  readChannels: () => Promise.resolve(channels()),
  listBoard: () => board(),
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('cmdFleetCoordCheck', () => {
  it('--json prints the report shape and exits 0 on REACHABLE', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdFleetCoordCheck(['--json'], deps());
    expect(code).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report).toMatchObject({
      schemaVersion: 1, asOf: ISO, verdict: 'REACHABLE', missing: [],
      runtime: { reason: null }, channels: { reason: null },
      claims: { value: { total: 1 } },
      bridgeOwner: { value: { owner: 'fake-bridge-owner', state: 'RUNNING' } },
      oneTask: { value: { id: 'rq-dot-bridge-9', claimReceipt: 'bus-claim:rq-dot-bridge-9:1:1700000000101' } },
    });
  });

  it('exits 3 on BLOCKED and names the missing piece in text output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdFleetCoordCheck([], deps({ readRuntime: () => runtime(true) }));
    expect(code).toBe(3);
    const out = log.mock.calls.map(c => c[0]).join('\n');
    expect(out).toContain('verdict: BLOCKED');
    expect(out).toContain('missing: fleet state stale 47m');
    expect(out).toContain('bridgeOwner:');
    expect(out).toContain('owner: fake-bridge-owner');
  });

  it('text output prints one section per part on REACHABLE', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdFleetCoordCheck([], deps());
    expect(code).toBe(0);
    const out = log.mock.calls.map(c => c[0]).join('\n');
    for (const section of ['runtime:', 'channels:', 'claims:', 'bridgeOwner:', 'oneTask:', 'verdict: REACHABLE']) {
      expect(out).toContain(section);
    }
  });

  it('exits 2 on bad args and 0 on --help without reading sources', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetCoordCheck(['--bogus'], deps())).toBe(2);
    expect(await cmdFleetCoordCheck(['--json', '--bogus'], deps())).toBe(2);
    expect(err).toHaveBeenCalledWith('Usage: ashlr fleet coord-check [--json]');
    expect(await cmdFleetCoordCheck(['--help'], deps())).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('Usage: ashlr fleet coord-check');
  });

  it("the 'coord-check' verb is registered with the fleet loader", () => {
    expect(FLEET_SUBCOMMAND_LOADERS['coord-check']).toBeTypeOf('function');
  });
});
