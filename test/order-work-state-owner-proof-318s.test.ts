import { describe, expect, it } from 'vitest';
import { classifyOrder, orderEvidence, type TraceOrder } from '../src/core/fleet/order-work-state.js';
import type { OrderTraceJob } from '../src/core/fleet/order-trace.js';

const now = '2026-11-14T04:00:00.000Z';
const order = (jobs: OrderTraceJob[]): TraceOrder => ({
  at: '2026-11-12 22:29 ET', source: 'inbox', key: '11-12 22:29', jobs,
});
const job = (state: OrderTraceJob['state'], url: string | null = null): OrderTraceJob => ({
  id: 'RQ-EXAMPLE', lane: 'codex-personal', state, url,
});

describe('order trace ownership evidence', () => {
  it.each(['queued', 'launched', 'published'] as const)('%s routing metadata does not prove a claim', state => {
    const input = order([job(state)]);
    const evidence = orderEvidence(input, now);
    expect(evidence).not.toHaveProperty('owner');
    expect(evidence).not.toHaveProperty('claimReceipt');
    expect(evidence).not.toHaveProperty('runningEvidence');
    expect(classifyOrder(input, now, now)).toMatchObject({
      state: 'RECEIVED', source: 'receivedAt', missing: ['named owner', 'durable claim receipt'],
    });
  });

  it('retains receipt evidence when there is no job', () => {
    const input = order([]);
    expect(orderEvidence(input, now).receivedAt).toBe('2026-11-13T03:29:00.000Z');
    expect(classifyOrder(input, now, now)).toMatchObject({ state: 'RECEIVED', source: 'receivedAt' });
  });

  it('retains verified merged PR artifact evidence without inventing an owner', () => {
    const input = order([job('merged', 'https://github.com/example/repo/pull/123')]);
    expect(orderEvidence(input, now)).toMatchObject({
      verified: { pr: 123, artifact: 'https://github.com/example/repo/pull/123', source: 'order-trace', at: now },
    });
    expect(orderEvidence(input, now)).not.toHaveProperty('owner');
    expect(orderEvidence(input, now)).not.toHaveProperty('claimReceipt');
    expect(classifyOrder(input, now, now)).toMatchObject({ state: 'VERIFIED', source: 'order-trace', asOf: now });
  });

  it.each(['https://github.com/example/repo/issues/123', 'not a URL', 'https://github.com/example/repo/pull/nope'])('does not verify a merged job with %s', url => {
    const input = order([job('merged', url)]);
    expect(orderEvidence(input, now)).not.toHaveProperty('verified');
    expect(classifyOrder(input, now, now)).toMatchObject({ state: 'RECEIVED', missing: ['named owner', 'durable claim receipt'] });
  });
});
