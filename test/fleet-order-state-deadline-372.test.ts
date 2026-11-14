import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const GEN = '2026-01-02T03:00:00.000Z';
const NOW = () => Date.parse('2026-01-02T03:05:00Z');
const TIMEOUT = 50;
const PR_URL = 'https://github.com/ashlrai/phantom/pull/123';

const trace: OrderTraceV1 = {
  v: 1, generatedAt: GEN,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [
    { at: '2026-01-01 10:00', source: 'Phantom desktop', key: 'verified-order', jobs: [
      { id: 'RQ-PHX-FAKEV1', lane: 'devin', state: 'merged', url: PR_URL }] },
    { at: '2026-01-01 11:00', source: 'Phantom desktop', key: 'running-order', jobs: [
      { id: 'RQ-PHX-FAKER1', lane: 'devin', state: 'launched', url: null }] },
    { at: '2026-01-01 12:00', source: 'Phantom desktop', key: 'queued-order', jobs: [
      { id: 'RQ-PHX-FAKEQ1', lane: 'fake-lane', state: 'queued', url: null }] },
  ],
};
const noLive: LiveWorkersSnapshot = { v: 1, generatedAt: GEN, sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 };
const liveWithWorker: LiveWorkersSnapshot = {
  ...noLive,
  workers: [{ pid: 1, job: 'RQ-PHX-FAKER1', repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 5 }],
};
const heldLanes: LaneTargetsV1 = { v: 1, generatedAt: GEN, sourceState: 'healthy', lanes: [{
  lane: 'fake-lane', target: 0, floor: 0, ceiling: 2, held: true, heldReason: 'fake-account usage reset', heldUntil: '2026-01-03T00:00:00.000Z',
  pausedFrom: 1, lastChange: null, changedBy: 'fake-operator',
}] };

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const healthy = {
  read: async () => trace,
  now: NOW,
  live: async () => noLive,
  lanes: async () => heldLanes,
  timeoutMs: TIMEOUT,
};
const logged = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).join('\n');

/** Run the command under fake timers, advancing past every reader bound. */
async function runCmd<T>(p: Promise<T>): Promise<T> {
  const done = p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  await vi.advanceTimersByTimeAsync(TIMEOUT * 4);
  return (await done).v as T;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('fleet order-state per-reader deadline', () => {
  it('a stalled trace read exits 1 with the sanitized error and no thrown text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCmd(cmdFleetOrderState(['--json'], {
      read: async () => { throw new Error('PRIVATE-MARKER path=/secret'); },
      timeoutMs: TIMEOUT,
    }));
    expect(code).toBe(1);
    expect(logged(err)).toBe('fleet order-state: unable to read the order trace');
    expect(logged(log) + logged(err)).not.toContain('PRIVATE-MARKER');
    expect(logged(err)).not.toContain('/secret');
  });

  it('a never-settling trace read exits 1 within the bound', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runCmd(cmdFleetOrderState([], { read: never, timeoutMs: TIMEOUT }));
    expect(code).toBe(1);
    expect(logged(err)).toBe('fleet order-state: unable to read the order trace');
  });

  it('a stalled live read degrades to unavailable and never fabricates RUNNING', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCmd(cmdFleetOrderState(['--json'], { ...healthy, live: never }));
    expect(code).toBe(0);
    const body = JSON.parse(logged(log));
    expect(body.live).toBe('unavailable');
    const states = Object.fromEntries(body.orders.map((o: { key: string; state: string }) => [o.key, o.state]));
    expect(states['verified-order']).toBe('VERIFIED');
    expect(states['running-order']).toBe('ASSIGNED');
    // Lanes evidence is independent and still classifies: held lane => BLOCKED.
    expect(states['queued-order']).toBe('BLOCKED');
    expect(logged(log)).not.toContain('RUNNING');
  });

  it('a stalled lanes read degrades to unavailable and never fabricates BLOCKED', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCmd(cmdFleetOrderState(['--json'], { ...healthy, lanes: never }));
    expect(code).toBe(0);
    const body = JSON.parse(logged(log));
    expect(body.lanes).toBe('unavailable');
    expect(body.live).toBe('healthy');
    const states = Object.fromEntries(body.orders.map((o: { key: string; state: string }) => [o.key, o.state]));
    expect(states['verified-order']).toBe('VERIFIED');
    expect(states['queued-order']).not.toBe('BLOCKED');
    expect(logged(log)).not.toContain('BLOCKED');
  });

  it('text mode warns on stdout for live and stderr for lanes when readers stall', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCmd(cmdFleetOrderState([], { ...healthy, live: never, lanes: never }));
    expect(code).toBe(0);
    expect(logged(log)).toContain('warning: live workers unavailable; RUNNING not checked');
    expect(logged(err)).toContain('warning: lane holds unavailable; BLOCKED not checked');
    expect(logged(log)).not.toContain('RUNNING as-of');
  });

  it('a reader settling after its timeout prints nothing more', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let settle!: (s: LiveWorkersSnapshot) => void;
    const lateLive = () => new Promise<LiveWorkersSnapshot>((resolve) => { settle = resolve; });
    const code = await runCmd(cmdFleetOrderState(['--json'], { ...healthy, live: lateLive }));
    expect(code).toBe(0);
    const callsAfter = log.mock.calls.length + err.mock.calls.length;
    settle(liveWithWorker);
    await vi.advanceTimersByTimeAsync(TIMEOUT * 8);
    expect(log.mock.calls.length + err.mock.calls.length).toBe(callsAfter);
  });

  it('a fresh invocation with healthy readers returns current evidence, not cached degradation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stalled = await runCmd(cmdFleetOrderState(['--json'], { ...healthy, live: never }));
    expect(stalled).toBe(0);
    const degraded = JSON.parse(logged(log));
    expect(degraded.live).toBe('unavailable');
    log.mockClear();
    const fresh = await runCmd(cmdFleetOrderState(['--json'], { ...healthy, live: async () => liveWithWorker }));
    expect(fresh).toBe(0);
    const body = JSON.parse(logged(log));
    expect(body.live).toBe('healthy');
    const states = Object.fromEntries(body.orders.map((o: { key: string; state: string }) => [o.key, o.state]));
    expect(states['running-order']).toBe('RUNNING');
    expect(states['queued-order']).toBe('BLOCKED');
  });

  it('healthy readers keep the existing JSON and text contracts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCmd(cmdFleetOrderState(['--json'], healthy))).toBe(0);
    const body = JSON.parse(logged(log));
    expect(body).toMatchObject({ v: 1, generatedAt: GEN, live: 'healthy', lanes: 'healthy' });
    expect(body.orders.map((o: { state: string }) => o.state)).toEqual(['BLOCKED', 'ASSIGNED', 'VERIFIED']);
    log.mockClear(); err.mockClear();
    expect(await runCmd(cmdFleetOrderState([], healthy))).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('2026-01-01 12:00');
    expect(lines[0]).toContain('BLOCKED');
    expect(lines[0]).toContain('blocked-on=lane fake-lane held until 2026-01-03T00:00:00.000Z');
    expect(lines[1]).toContain('2026-01-01 11:00');
    expect(lines[1]).toContain('ASSIGNED');
    expect(lines[1]).toContain('source=claim:RQ-PHX-FAKER1');
    expect(lines[2]).toContain('2026-01-01 10:00');
    expect(lines[2]).toContain('VERIFIED');
    expect(lines[2]).toContain(`pr=${PR_URL}`);
    expect(err).not.toHaveBeenCalled();
  });
});
