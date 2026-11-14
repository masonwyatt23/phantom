/** RQ-PHX-COORDCHECK320 — one read must compose runtime identity, channel
 * health and the work board into the sanitized owner-order answer: verdict
 * REACHABLE only when every piece is present and the fleet state is fresh,
 * the named Dot-bridge owner, and one claimed task with execution evidence. */
import { describe, expect, it } from 'vitest';
import { buildCoordCheck, BRIDGE_KEYWORDS, type CoordCheckDeps } from '../src/core/fleet/coord-check.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T18:13:00.000Z');
const HOME = '/home/fakeuser';
const ISO = NOW.toISOString();
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const runtime = (over: Partial<RuntimeIdentity> = {}): RuntimeIdentity => ({
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: ago(1), ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [], ...over,
});

const chan = (channel: ChannelHealth['channel'], over: Partial<ChannelHealth> = {}): ChannelHealth => ({
  channel, configured: true, processAlive: true, runtimeHost: 'fake-host',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
  state: 'LIVE', missing: [], asOf: ISO, ...over,
});
const channels = (over: Partial<ChannelHealthReport> = {}): ChannelHealthReport => ({
  schemaVersion: 1, asOf: ISO, channels: [chan('slack'), chan('imessage')], ...over,
});

const item = (over: Partial<WorkBoardItem>): WorkBoardItem => ({
  id: 'rq-plain-1', channel: 'bus', channelRef: null, receivedAt: ago(10),
  state: 'RECEIVED', asOf: ago(10), source: 'receivedAt',
  missing: ['named owner', 'durable claim receipt'], owner: null, claimReceipt: null, ...over,
});
const board = (items: WorkBoardItem[], over: Partial<WorkBoardResult> = {}): WorkBoardResult => ({
  items, inbox: 'ok', truncated: false, ...over,
});

const bridgeItem = item({
  id: 'rq-dot-bridge-9', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1700000000.000101',
  receivedAt: ago(3), state: 'RUNNING', asOf: ago(3), source: 'runs-ledger',
  missing: [], owner: 'fake-bridge-owner', claimReceipt: 'bus-claim:rq-dot-bridge-9:1:1700000000000',
});
const taskItem = item({
  id: 'rq-fix-parser-2', receivedAt: ago(2), state: 'RUNNING', asOf: ago(2),
  source: 'runs-ledger', missing: [], owner: 'fake-worker', claimReceipt: 'bus-claim:rq-fix-parser-2:1:1700000000000',
});

const deps = (over: Partial<CoordCheckDeps> = {}): CoordCheckDeps => ({
  now: () => NOW,
  homeDir: () => HOME,
  readRuntime: () => runtime(),
  readChannels: () => Promise.resolve(channels()),
  listBoard: () => board([bridgeItem, taskItem]),
  ...over,
});

describe('buildCoordCheck', () => {
  it('REACHABLE with the bridge owner and one claimed task when every source is good', async () => {
    const r = await buildCoordCheck(deps());
    expect(r.verdict).toBe('REACHABLE');
    expect(r.missing).toEqual([]);
    expect(r.schemaVersion).toBe(1);
    expect(r.asOf).toBe(ISO);
    expect(r.runtime.value?.host).toBe('fake-host');
    expect(r.channels.value?.channels).toHaveLength(2);
    expect(r.claims.value).toMatchObject({ total: 2, byState: { RUNNING: 2, RECEIVED: 0, VERIFIED: 0 } });
    expect(r.bridgeOwner).toEqual({
      value: { id: 'rq-dot-bridge-9', owner: 'fake-bridge-owner', state: 'RUNNING', receivedAt: ago(3) },
      reason: null,
    });
    expect(r.oneTask).toEqual({
      value: {
        id: 'rq-fix-parser-2', owner: 'fake-worker', state: 'RUNNING',
        claimReceipt: 'bus-claim:rq-fix-parser-2:1:1700000000000', evidence: 'runs-ledger', at: ago(2),
      },
      reason: null,
    });
  });

  it('BLOCKED naming the stale fleet state while other parts stay present', async () => {
    const r = await buildCoordCheck(deps({
      readRuntime: () => runtime({
        fleetState: { path: '~/state.json', mtime: ago(47), ageSeconds: 47 * 60, stale: true },
      }),
    }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.missing).toContain('fleet state stale 47m');
    expect(r.claims.value?.total).toBe(2);
    expect(r.channels.value?.channels).toHaveLength(2);
    expect(r.bridgeOwner.value?.owner).toBe('fake-bridge-owner');
  });

  it('BLOCKED with "work board unreadable" when the board read throws; other parts stay present', async () => {
    const r = await buildCoordCheck(deps({ listBoard: () => { throw new Error('EIO'); } }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.missing).toContain('work board unreadable');
    expect(r.claims).toEqual({ value: null, reason: 'work board unreadable' });
    expect(r.bridgeOwner).toEqual({ value: null, reason: 'work board unreadable' });
    expect(r.oneTask).toEqual({ value: null, reason: 'work board unreadable' });
    expect(r.runtime.value?.host).toBe('fake-host');
    expect(r.channels.value?.channels).toHaveLength(2);
  });

  it('BLOCKED when the board settles but the inbox scan failed', async () => {
    const r = await buildCoordCheck(deps({ listBoard: () => board([], { inbox: 'unavailable' }) }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.claims).toEqual({ value: null, reason: 'work board unreadable' });
  });

  it('oneTask is null with a reason when no owned item carries execution evidence', async () => {
    const unclaimed = item({ id: 'rq-lonely-1', receivedAt: ago(2) });
    const claimedButReceived = item({
      id: 'rq-claimed-3', receivedAt: ago(4), state: 'ASSIGNED', source: 'claim:bus-claim:rq-claimed-3:1:1',
      owner: 'fake-worker', claimReceipt: 'bus-claim:rq-claimed-3:1:1', missing: [],
    });
    const r = await buildCoordCheck(deps({ listBoard: () => board([unclaimed, claimedButReceived]) }));
    expect(r.verdict).toBe('REACHABLE');
    expect(r.oneTask).toEqual({ value: null, reason: 'no owned task with execution evidence on the board' });
    expect(r.bridgeOwner).toEqual({ value: null, reason: 'no named owner on the board' });
  });

  it('ignores running items that carry no claim receipt, and never claims dispatch', async () => {
    const ghost = item({
      id: 'rq-ghost-1', state: 'RUNNING', source: 'runs-ledger', missing: [],
      owner: 'fake-worker', claimReceipt: null,
    });
    const r = await buildCoordCheck(deps({ listBoard: () => board([ghost]) }));
    expect(r.oneTask.value).toBeNull();
    expect(r.missing).toEqual([]);
  });

  it('BLOCKED when a bridge process is down, naming the missing piece', async () => {
    const r = await buildCoordCheck(deps({
      readChannels: () => Promise.resolve(channels({
        channels: [chan('slack', {
          state: 'BLOCKED', configured: true, processAlive: false,
          missing: ['slack bridge process not running'],
        }), chan('imessage')],
      })),
    }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.missing).toContain('slack bridge process not running');
  });

  it('BLOCKED when the channel read times out or throws', async () => {
    const slow = await buildCoordCheck(deps({
      readChannels: () => new Promise<ChannelHealthReport>(() => {}), channelTimeoutMs: 5,
    }));
    expect(slow.verdict).toBe('BLOCKED');
    expect(slow.channels).toEqual({ value: null, reason: 'channel health read timed out' });
    const boom = await buildCoordCheck(deps({ readChannels: () => Promise.reject(new Error('EACCES')) }));
    expect(boom.channels).toEqual({ value: null, reason: 'channel health unreadable' });
    expect(boom.missing).toContain('channel health unreadable');
  });

  it('BLOCKED when runtime identity cannot be read', async () => {
    const r = await buildCoordCheck(deps({ readRuntime: () => { throw new Error('ENOENT'); } }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.runtime).toEqual({ value: null, reason: 'runtime identity unreadable' });
    expect(r.missing).toContain('runtime identity unreadable');
  });

  it('redacts IPv4 addresses and /Users paths from board labels', async () => {
    const leaky = item({
      id: 'rq-/Users/x/secret-10.1.2.3', channel: 'slack',
      state: 'RUNNING', source: 'runs-ledger', missing: [],
      owner: 'worker@10.1.2.3', claimReceipt: 'bus-claim:rq-leak:1:1',
      channelRef: 'T0/C0/1700000000.000101',
    });
    const r = await buildCoordCheck(deps({ listBoard: () => board([leaky]) }));
    const text = JSON.stringify(r);
    expect(text).not.toContain('10.1.2.3');
    expect(text).not.toContain('/Users/x');
    expect(r.oneTask.value?.owner).toBe('worker@[ip]');
    expect(r.oneTask.value?.id).toContain('~');
    // The channel_ref is not a path and its digits survive.
    expect(r.bridgeOwner.value?.owner).toBe('worker@[ip]');
  });

  it('matches bridge items on the fixed lowercase keywords', async () => {
    const dotty = item({ id: 'RQ-DOTDISPATCH-1', owner: 'fake-dot-owner', state: 'RECEIVED', receivedAt: ago(1) });
    const imsg = item({ id: 'req-8', channel: 'imessage', owner: 'fake-imsg-owner', receivedAt: ago(2) });
    const plain = item({ id: 'req-9', owner: 'fake-other-owner', receivedAt: ago(0) });
    const r = await buildCoordCheck(deps({ listBoard: () => board([plain, imsg, dotty]) }));
    expect(r.bridgeOwner.value?.owner).toBe('fake-dot-owner');
    expect(BRIDGE_KEYWORDS).toEqual(['dot', 'bridge', 'slack', 'imessage']);
  });
});
