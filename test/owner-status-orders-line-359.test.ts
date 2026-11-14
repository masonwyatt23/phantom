/** RQ-PHX-STATUSORDERSLINE359 — the "Your orders" line on the fixed owner
 * status reply: counts Mason's recent inbox orders by state so the Slack
 * answer itself shows whether his orders reached anyone. Fake data only. */
import { describe, expect, it, vi } from 'vitest';
import { defaultOrdersLine, formatOrdersLine, ORDERS_UNKNOWN_LINE, ORDERS_WINDOW_HOURS } from '../src/core/agents/owner-status-orders-line.js';
import { composeOwnerStatusReply } from '../src/core/agents/owner-status-reply.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const now = new Date('2026-11-13T20:27:00Z'); // 15:27 ET
const brief = async () => 'Morning leader brief\nShipped (last 12h): 2 fake PRs';
const RUNTIME = 'Runtime: fake-host (1.0.0, source 1.0.0), fleet state 1m old · Slack LIVE · iMessage LIVE';
const ORDERS = 'Your orders (72h): 1 VERIFIED; as of 15:27 ET';
const emptyBoard = (): WorkBoardResult => ({ items: [], inbox: 'ok', truncated: false });

type TraceOrder = OrderTraceV1['orders'][number];
const job = (over: Partial<TraceOrder['jobs'][number]> = {}): TraceOrder['jobs'][number] =>
  ({ id: 'RQ-FAKE-1', lane: 'devin', state: 'queued', url: null, ...over });
const order = (at: string, jobs: TraceOrder['jobs'] = []): TraceOrder =>
  ({ at, source: 'slack', key: at.slice(5), jobs });
const trace = (orders: TraceOrder[], inbox: OrderTraceV1['sources']['inbox'] = 'healthy'): OrderTraceV1 => ({
  v: 1,
  generatedAt: now.toISOString(),
  sources: { inbox, prompts: 'healthy', publishes: 'healthy' },
  orders,
});
const read = async (value: OrderTraceV1) => value;

/** Orders inside the 72h window, one per reachable trace state. */
const mixedOrders: TraceOrder[] = [
  // Merged with a github pull URL verifies the order.
  order('2026-11-13 12:00', [job({ id: 'RQ-FAKE-VERIFIED', state: 'merged', url: 'https://github.com/ashlrai/phantom/pull/4242' })]),
  // Launched and published jobs are real claims: ASSIGNED.
  order('2026-11-13 13:00', [job({ id: 'RQ-FAKE-LAUNCHED', lane: 'claude', state: 'launched' })]),
  order('2026-11-13 13:30', [job({ id: 'RQ-FAKE-PUBLISHED', state: 'published', url: 'https://github.com/ashlrai/phantom/pull/4300' })]),
  // No citing job, and a queued line (a routed lane is not a claim receipt).
  order('2026-11-13 14:00'),
  order('2026-11-14 10:00', [job({ id: 'RQ-FAKE-QUEUED' })]),
];

describe('formatOrdersLine', () => {
  it('names only non-zero states, in VERIFIED/RUNNING/BLOCKED/ASSIGNED/RECEIVED order', () => {
    expect(formatOrdersLine({ RECEIVED: 1, ASSIGNED: 3, VERIFIED: 2, RUNNING: 1 }, now, 72))
      .toBe('Your orders (72h): 2 VERIFIED, 1 RUNNING, 3 ASSIGNED, 1 RECEIVED; as of 15:27 ET');
    expect(formatOrdersLine({ VERIFIED: 2, RUNNING: 1, BLOCKED: 4, ASSIGNED: 3, RECEIVED: 1 }, now, 72))
      .toBe('Your orders (72h): 2 VERIFIED, 1 RUNNING, 4 BLOCKED, 3 ASSIGNED, 1 RECEIVED; as of 15:27 ET');
    expect(formatOrdersLine({ RECEIVED: 5 }, now, ORDERS_WINDOW_HOURS)).toBe('Your orders (72h): 5 RECEIVED; as of 15:27 ET');
  });

  it('reads "none" when every count is zero or absent, honoring the hours label', () => {
    expect(formatOrdersLine({}, now, 72)).toBe('Your orders (72h): none');
    expect(formatOrdersLine({ VERIFIED: 0, RECEIVED: 0 }, now, 24)).toBe('Your orders (24h): none');
  });
});

describe('defaultOrdersLine', () => {
  it('counts last-72h orders by classified state', async () => {
    await expect(defaultOrdersLine(now, { read: () => read(trace(mixedOrders)) }))
      .resolves.toBe('Your orders (72h): 1 VERIFIED, 2 ASSIGNED, 2 RECEIVED; as of 15:27 ET');
  });

  it('drops orders older than the window and unparseable timestamps', async () => {
    const orders = [
      ...mixedOrders,
      order('2026-11-10 10:00', [job({ id: 'RQ-FAKE-OLD', state: 'merged', url: 'https://github.com/ashlrai/phantom/pull/1' })]),
      order('not a timestamp'),
    ];
    await expect(defaultOrdersLine(now, { read: () => read(trace(orders)) }))
      .resolves.toBe('Your orders (72h): 1 VERIFIED, 2 ASSIGNED, 2 RECEIVED; as of 15:27 ET');
  });

  it.each(['missing', 'degraded'] as const)('reads "unknown" when the inbox source is %s', async inbox => {
    await expect(defaultOrdersLine(now, { read: () => read(trace(mixedOrders, inbox)) })).resolves.toBe(ORDERS_UNKNOWN_LINE);
    expect(ORDERS_UNKNOWN_LINE).toBe('Your orders: unknown (inbox unreadable)');
  });

  it('reads "unknown" when the trace read throws', async () => {
    await expect(defaultOrdersLine(now, { read: async () => { throw new Error('synthetic trace failure'); } }))
      .resolves.toBe(ORDERS_UNKNOWN_LINE);
  });

  it('carries no order text, ids or paths', async () => {
    const line = await defaultOrdersLine(now, { read: () => read(trace(mixedOrders)) });
    expect(line).not.toContain('RQ-');
    expect(line).not.toContain('https://');
    expect(line).not.toContain('slack');
  });
});

describe('composeOwnerStatusReply orders line', () => {
  it('sits directly after the runtime line, above the digest', async () => {
    const orders = vi.fn(async () => ORDERS);
    const reply = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, runtime: async () => RUNTIME, orders });
    const lines = reply.split('\n');
    expect(lines[0]).toBe('Phantom status, 15:27 ET');
    expect(lines[1]).toBe(RUNTIME);
    expect(lines[2]).toBe(ORDERS);
    expect(lines[3]).toBe('Shipped (last 12h): 2 fake PRs');
    expect(orders).toHaveBeenCalledWith(now);
  });

  it('sits directly under the heading when there is no runtime line', async () => {
    const reply = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, orders: async () => ORDERS });
    expect(reply.split('\n')[1]).toBe(ORDERS);
  });

  it('a throwing orders seam leaves the no-seam reply byte-identical', async () => {
    const baseline = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, runtime: async () => RUNTIME });
    const throwing = await composeOwnerStatusReply('/x', now, {
      brief, board: emptyBoard, runtime: async () => RUNTIME,
      orders: async () => { throw new Error('synthetic orders failure'); },
    });
    expect(throwing).toBe(baseline);
    expect(throwing).not.toContain('Your orders');
  });

  it('without the seam the reply is unchanged', async () => {
    const deps = { brief, board: emptyBoard, runtime: async () => RUNTIME };
    expect(await composeOwnerStatusReply('/x', now, deps)).toBe(await composeOwnerStatusReply('/x', now, { ...deps }));
  });

  it('keeps only the first line of a multi-line seam result; a blank seam adds no line', async () => {
    const reply = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, orders: async () => `${ORDERS}\nextra` });
    expect(reply).toContain(ORDERS);
    expect(reply).not.toContain('extra');
    const blank = await composeOwnerStatusReply('/x', now, { brief, board: emptyBoard, orders: async () => '' });
    expect(blank.split('\n')[1]).toBe('Shipped (last 12h): 2 fake PRs');
  });

  it('drops work-board lines before the orders line when over 1500 chars', async () => {
    const items: WorkBoardItem[] = ['a', 'b', 'c'].map(id => ({
      id, channel: 'slack', channelRef: null, receivedAt: 'x', state: 'BLOCKED',
      asOf: 'x', source: 'x', missing: [], owner: null, claimReceipt: null,
    }));
    const reply = await composeOwnerStatusReply('/x', now, {
      brief: async () => `Morning leader brief\n${'d'.repeat(1300)}`,
      board: () => ({ items, inbox: 'ok', truncated: false }),
      runtime: async () => RUNTIME,
      orders: async () => ORDERS,
    });
    expect(reply.length).toBeLessThanOrEqual(1500);
    expect(reply).toContain(RUNTIME);
    expect(reply).toContain(ORDERS);
    expect(reply).not.toContain('Work items');
  });

  it('drops the orders line before the runtime line', async () => {
    const reply = await composeOwnerStatusReply('/x', now, {
      brief: async () => `Morning leader brief\n${'d'.repeat(1360)}`,
      board: emptyBoard,
      runtime: async () => RUNTIME,
      orders: async () => ORDERS,
    });
    expect(reply.length).toBeLessThanOrEqual(1500);
    expect(reply).toContain(RUNTIME);
    expect(reply).not.toContain('Your orders');
  });

  it('drops orders and runtime, truncating the digest last', async () => {
    const reply = await composeOwnerStatusReply('/x', now, {
      brief: async () => `Morning leader brief\n${'d'.repeat(1480)}`,
      board: emptyBoard,
      runtime: async () => RUNTIME,
      orders: async () => ORDERS,
    });
    expect(reply).toHaveLength(1500);
    expect(reply.endsWith('…')).toBe(true);
    expect(reply).not.toContain('Runtime:');
    expect(reply).not.toContain('Your orders');
  });
});
