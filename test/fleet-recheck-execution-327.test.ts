/** RQ-PHX-RECHECKEXECEVIDENCE327 — `fleet recheck` names execution evidence for
 * the task pick: RUNNING carries running evidence, ASSIGNED says plainly that
 * none exists yet. All four readers are faked with a fixed `now`; nothing
 * touches the real home, ledger, bus or network. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheck } from '../src/cli/fleet-recheck.js';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const ISO = NOW.toISOString();

const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T11:59:00.000Z', ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};

const board: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known',
  claims: [{
    id: 'fake-claim-2', repo: 'ashlrai/phantom', task: 'fake owner task',
    agent: 'fake-owner-agent', claimedAt: NOW_MS - 2_000, expiresAt: NOW_MS + 3_600_000,
  }],
  messages: [], proposals: [], expiredClaims: 0,
};

function channel(name: 'slack' | 'imessage'): ChannelHealth {
  return {
    channel: name, configured: true, processAlive: true, runtimeHost: 'fake-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 },
    state: 'LIVE', missing: [], asOf: ISO,
  };
}
const channels: ChannelHealthReport = { schemaVersion: 1, asOf: ISO, channels: [channel('slack'), channel('imessage')] };

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'fake-request-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
    receivedAt: '2026-11-13T11:58:00.000Z', state: 'RUNNING', asOf: ISO,
    source: 'bus-work-claims lease-until 2026-11-13T12:10:00.000Z', missing: [],
    owner: 'fake-owner-agent', claimReceipt: 'bus-claim:fake-request-1:1:1700000000000', ...over,
  };
}

function deps(items: WorkBoardItem[], over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => '/home/fakeuser',
    readRuntimeIdentity: () => runtime,
    readFleetBoard: () => board,
    readChannelHealth: () => channels,
    listWorkBoard: () => ({ items, inbox: 'ok', truncated: false } satisfies WorkBoardResult),
    ...over,
  };
}

async function textTaskLine(d: FleetRecheckDeps): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdFleetRecheck([], d);
  return log.mock.calls.map(c => String(c[0])).find(l => l.startsWith('TASK ')) ?? '';
}

afterEach(() => vi.restoreAllMocks());

describe('fleet recheck execution evidence', () => {
  it('RUNNING pick carries running evidence in the object, text line and reply', async () => {
    const d = deps([item()]);
    const recheck = await readFleetRecheck(d);
    const task = recheck.sections.task;
    expect(task.state).toBe('VERIFIED');
    expect(task.task?.execution).toEqual({ state: 'RUNNING', source: task.task?.source, at: ISO });
    expect(task.missing).toEqual([]);
    expect(await textTaskLine(d)).toContain(`exec=RUNNING@${ISO}`);
    expect(formatRecheckReply(recheck)).toContain('exec running since');
  });

  it('ASSIGNED pick with a live claim stays VERIFIED but says no running evidence yet', async () => {
    const d = deps([item({ state: 'ASSIGNED', source: 'bus-work-claims assigned' })]);
    const recheck = await readFleetRecheck(d);
    const task = recheck.sections.task;
    expect(task.task?.state).toBe('ASSIGNED');
    expect(task.task?.execution).toBeNull();
    expect(task.state).toBe('VERIFIED');
    expect(task.missing).toEqual(['task: fake-request-1 ASSIGNED, no running evidence yet']);
    expect(recheck.overall.state).toBe('VERIFIED');
    expect(await textTaskLine(d)).toContain('exec=none');
    const reply = formatRecheckReply(recheck);
    expect(reply).toContain('no running evidence yet');
    expect(reply).not.toContain('exec running since');
  });

  it('no pick leaves task null and behaviour unchanged', async () => {
    const recheck = await readFleetRecheck(deps([]));
    expect(recheck.sections.task.task).toBeNull();
    expect(recheck.sections.task.state).toBe('BLOCKED');
    expect(recheck.sections.task.missing).toEqual(['task: no RUNNING or ASSIGNED board item']);
    expect(formatRecheckReply(recheck)).toContain('Task: none');
  });

  it('reply scrubs paths and banned words from the source and stays within 900 chars', async () => {
    const source = 'lane /Users/someone/work routed dispatched at /home/other/x';
    const recheck = await readFleetRecheck(deps([item({ source })]));
    const reply = formatRecheckReply(recheck);
    expect(reply).toContain('exec running since');
    expect(reply).not.toMatch(/\/Users\//);
    expect(reply).not.toMatch(/\/home\//);
    expect(reply).not.toMatch(/routed|dispatched/i);
    expect(reply.length).toBeLessThanOrEqual(900);
  });
});
