/** RQ-PHX-ORDERBLOCKEDQUEUE362: `fleet order-state` joins the order trace with
 * the parked queue (readFleetQueue), so an order whose most advanced job is
 * still queued and parked reads BLOCKED with the real dependency ids or parked
 * reason. Every dep is injected — no real ~/.ashlr-runs is read. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import { queueBlockers } from '../src/core/fleet/order-queue-blockers.js';
import { classifyOrder } from '../src/core/fleet/order-work-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { FleetQueueV1, ParkedGroup, ParkedUnmetDep } from '../src/core/fleet/runs-parked-queue.js';

const GENERATED = '2026-11-14T11:00:00.000Z';
const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const QUEUE_AT = '2026-11-14T11:58:00.000Z';
const PR_URL = 'https://github.com/ashlrai/phantom/pull/789';
const JOB = 'RQ-PHX-FAKEJOB1';
// '2026-11-14 06:00' ET is 2026-11-14T11:00:00.000Z (EST, UTC-5).
const ORDER_AT = '2026-11-14 06:00';
const RECEIVED_ISO = '2026-11-14T11:00:00.000Z';

const job = (id: string, state: OrderTraceJob['state'], url: string | null = null, lane: string | null = 'devin'): OrderTraceJob =>
  ({ id, lane, state, url });

const trace = (jobs: OrderTraceJob[]): OrderTraceV1 => ({
  v: 1, generatedAt: GENERATED,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: ORDER_AT, source: 'Phantom desktop', key: '11-14 06:00', jobs }],
});
const order = (jobs: OrderTraceJob[]) => trace(jobs).orders[0]!;

const queue = (opts: { unmetDeps?: ParkedUnmetDep[]; groups?: ParkedGroup[]; ready?: FleetQueueV1['sources']['ready'] } = {}): FleetQueueV1 => ({
  v: 1, generatedAt: QUEUE_AT, sources: { ready: opts.ready ?? 'healthy', skips: 'healthy' },
  total: 1, ready: 0, parked: 1, malformed: 0, byLane: [],
  groups: opts.groups ?? [], unmetDeps: opts.unmetDeps ?? [], skips: [], skipsLast24h: 0,
});

const noLive: LiveWorkersSnapshot = { v: 1, generatedAt: GENERATED, sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 };
const run = (args: string[], t: OrderTraceV1, q: () => Promise<FleetQueueV1>) =>
  cmdFleetOrderState(args, { read: async () => t, now: () => NOW_MS, live: async () => noLive, queue: q });
const lines = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.map((c) => String(c[0]));

const depQueue = () => queue({
  unmetDeps: [{ job: JOB, lane: 'devin', unmet: ['RQ-PHX-DEPA1', 'RQ-PHX-DEPB2'] }],
  groups: [{ reason: 'DEP', lane: 'devin', count: 1, jobs: [JOB] }],
});

afterEach(() => vi.restoreAllMocks());

describe('queueBlockers', () => {
  it('names unmerged dependency ids, caps at five and prefers unmetDeps over groups', () => {
    const ids = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
    const b = queueBlockers(queue({
      unmetDeps: [{ job: JOB, lane: null, unmet: ids }],
      groups: [{ reason: 'DRIP', lane: 'devin', count: 2, jobs: [JOB, 'RQ-PHX-OTHER2'] }],
    }))!;
    expect(b.at).toBe(QUEUE_AT);
    expect(b.byJob.get(JOB)).toBe('unmerged dependency: A1, A2, A3, A4, A5 +2 more');
    expect(b.byJob.get('RQ-PHX-OTHER2')).toBe('parked: DRIP (lane devin)');
  });
  it('omits the lane suffix when lane is null, skips DEP groups and unsafe tokens', () => {
    const b = queueBlockers(queue({
      groups: [
        { reason: 'HOLD', lane: null, count: 1, jobs: ['RQ-PHX-HOLD1'] },
        { reason: 'DEPENDENCY', lane: 'devin', count: 1, jobs: ['RQ-PHX-DEPONLY'] },
        { reason: 'bad reason!', lane: 'devin', count: 1, jobs: ['RQ-PHX-BAD1'] },
      ],
      unmetDeps: [{ job: 'RQ-PHX-PROSE', lane: null, unmet: ['see the prompt body'] }],
    }))!;
    expect(b.byJob.get('RQ-PHX-HOLD1')).toBe('parked: HOLD');
    expect(b.byJob.has('RQ-PHX-DEPONLY')).toBe(false);
    expect(b.byJob.has('RQ-PHX-BAD1')).toBe(false);
    expect(b.byJob.has('RQ-PHX-PROSE')).toBe(false);
  });
  it('returns null unless ready.tsv is healthy', () => {
    expect(queueBlockers(depQueue())).not.toBeNull();
    expect(queueBlockers(queue({ ready: 'degraded', unmetDeps: depQueue().unmetDeps }))).toBeNull();
    expect(queueBlockers(queue({ ready: 'missing' }))).toBeNull();
  });
});

describe('classifyOrder with queue blockers', () => {
  it('a queued job listed in unmetDeps is BLOCKED from the fleet queue', () => {
    const c = classifyOrder(order([job(JOB, 'queued')]), GENERATED, NOW_ISO, undefined, queueBlockers(depQueue())!);
    expect(c).toEqual({ state: 'BLOCKED', asOf: QUEUE_AT, source: 'fleet-queue', missing: [] });
  });
  it('a launched job also listed in unmetDeps stays ASSIGNED', () => {
    const c = classifyOrder(order([job(JOB, 'launched')]), GENERATED, NOW_ISO, undefined, queueBlockers(depQueue())!);
    expect(c.state).toBe('ASSIGNED');
    expect(c.source).toBe(`claim:${JOB}`);
  });
  it('only the most advanced job counts: a parked queued sibling does not block a launched order', () => {
    const c = classifyOrder(order([job('RQ-PHX-FAKEJOB2', 'launched'), job(JOB, 'queued')]), GENERATED, NOW_ISO, undefined,
      queueBlockers(depQueue())!);
    expect(c.state).toBe('ASSIGNED');
  });
});

describe('fleet order-state with the parked queue', () => {
  it('prints BLOCKED source=fleet-queue for a job waiting on unmerged dependencies', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([], trace([job(JOB, 'queued')]), async () => depQueue())).toBe(0);
    expect(lines(log)).toEqual([`2026-11-14 06:00 Phantom desktop BLOCKED as-of=${QUEUE_AT} source=fleet-queue missing=none`
      + ' blocked-by=unmerged dependency: RQ-PHX-DEPA1, RQ-PHX-DEPB2']);
    log.mockClear();
    expect(await run(['--json'], trace([job(JOB, 'queued')]), async () => depQueue())).toBe(0);
    const parsed = JSON.parse(lines(log).join('\n'));
    expect(parsed.queue).toBe('healthy');
    expect(parsed.orders[0]).toMatchObject({ state: 'BLOCKED', asOf: QUEUE_AT, evidenceSource: 'fleet-queue', missing: [],
      blocker: 'unmerged dependency: RQ-PHX-DEPA1, RQ-PHX-DEPB2' });
  });
  it('the dependency text names the unmerged ids', () => {
    expect(queueBlockers(depQueue())!.byJob.get(JOB)).toBe('unmerged dependency: RQ-PHX-DEPA1, RQ-PHX-DEPB2');
  });
  it('a queued job in a parked DRIP group on lane devin reads BLOCKED', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const q = queue({ groups: [{ reason: 'DRIP', lane: 'devin', count: 1, jobs: [JOB] }] });
    expect(queueBlockers(q)!.byJob.get(JOB)).toBe('parked: DRIP (lane devin)');
    expect(await run([], trace([job(JOB, 'queued')]), async () => q)).toBe(0);
    expect(lines(log)).toEqual([`2026-11-14 06:00 Phantom desktop BLOCKED as-of=${QUEUE_AT} source=fleet-queue missing=none`
      + ' blocked-by=parked: DRIP (lane devin)']);
  });
  it('a launched job also in unmetDeps stays ASSIGNED', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([], trace([job(JOB, 'launched')]), async () => depQueue())).toBe(0);
    expect(lines(log)).toEqual([`2026-11-14 06:00 Phantom desktop ASSIGNED as-of=${RECEIVED_ISO} source=claim:${JOB} missing=none`]);
  });
  it('a degraded ready.tsv proves nothing: no BLOCKED, warning in text, queue=unavailable in JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const q = async () => queue({ ready: 'degraded', unmetDeps: depQueue().unmetDeps });
    expect(await run([], trace([job(JOB, 'queued')]), q)).toBe(0);
    expect(lines(log)).toEqual([
      'warning: queue unavailable; BLOCKED not checked',
      `2026-11-14 06:00 Phantom desktop RECEIVED as-of=${RECEIVED_ISO} source=receivedAt missing=durable claim receipt`,
    ]);
    log.mockClear();
    expect(await run(['--json'], trace([job(JOB, 'queued')]), q)).toBe(0);
    const parsed = JSON.parse(lines(log).join('\n'));
    expect(parsed.queue).toBe('unavailable');
    expect(parsed.orders[0].state).toBe('RECEIVED');
  });
  it('a missing ready.tsv is unavailable in JSON without a text warning', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([], trace([job(JOB, 'queued')]), async () => queue({ ready: 'missing' }))).toBe(0);
    expect(lines(log)).toEqual([
      `2026-11-14 06:00 Phantom desktop RECEIVED as-of=${RECEIVED_ISO} source=receivedAt missing=durable claim receipt`,
    ]);
    log.mockClear();
    expect(await run(['--json'], trace([job(JOB, 'queued')]), async () => queue({ ready: 'missing' }))).toBe(0);
    expect(JSON.parse(lines(log).join('\n')).queue).toBe('unavailable');
  });
  it('a throwing or null queue reader exits 0 with the warning and today\'s states', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = trace([job(JOB, 'launched')]);
    const assigned = `2026-11-14 06:00 Phantom desktop ASSIGNED as-of=${RECEIVED_ISO} source=claim:${JOB} missing=none`;
    expect(await run([], t, async () => { throw new Error('ready.tsv exploded'); })).toBe(0);
    expect(lines(log)).toEqual(['warning: queue unavailable; BLOCKED not checked', assigned]);
    log.mockClear();
    expect(await run([], t, async () => null as unknown as FleetQueueV1)).toBe(0);
    expect(lines(log)).toEqual(['warning: queue unavailable; BLOCKED not checked', assigned]);
    log.mockClear();
    expect(await run(['--json'], t, async () => { throw new Error('boom'); })).toBe(0);
    const parsed = JSON.parse(lines(log).join('\n'));
    expect(parsed.queue).toBe('unavailable');
    expect(parsed.orders[0].state).toBe('ASSIGNED');
    expect(parsed.orders[0].blocker).toBeNull();
  });
  it('a merged job with a PR url stays VERIFIED even when the queue lists it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const q = async () => queue({
      unmetDeps: [{ job: JOB, lane: 'devin', unmet: ['RQ-PHX-DEPA1'] }],
      groups: [{ reason: 'DRIP', lane: 'devin', count: 1, jobs: [JOB] }],
    });
    expect(await run([], trace([job(JOB, 'merged', PR_URL)]), q)).toBe(0);
    expect(lines(log)).toEqual([`2026-11-14 06:00 Phantom desktop VERIFIED as-of=${GENERATED} source=order-trace missing=none pr=${PR_URL}`]);
  });
});
