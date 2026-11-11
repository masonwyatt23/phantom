import { describe, expect, it } from 'vitest';
import { buildStatusDigest, type StatusDigestInput, type StatusDigestLane } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput } from '../src/core/leader/status-digest-sources.js';

const ok = <T>(value: T) => ({ ok: true as const, value });
const input: StatusDigestInput = {
  installedVersion: ok('1'), publishedVersion: ok('1'), updatePending: false,
  mergesLastHour: ok(0), mergesLast24h: ok(0), lanes: ok([]), needsMason: ok(0), topP0: ok(null),
};
const lane = (overrides: Partial<StatusDigestLane> = {}): StatusDigestLane => ({
  lane: 'devin-flash', running: 0, target: 3, held: false, heldReason: null, ...overrides,
});
const render = (...lanes: StatusDigestLane[]) => buildStatusDigest({ ...input, lanes: ok(lanes) })[2];

describe('stalled status digest lanes', () => {
  it('reports queued work behind zero workers', () => {
    expect(render(lane({ queued: 88 }))).toBe('Lanes: stalled: devin-flash 0/3 (88 queued)');
  });

  it('keeps held lanes held and running lanes live, in segment order', () => {
    expect(render(lane({ lane: 'held', held: true, heldReason: 'limit', queued: 4 }), lane({ queued: 88 }), lane({ lane: 'live', running: 1, queued: 2 })))
      .toBe('Lanes: live 1/3 · stalled: devin-flash 0/3 (88 queued) · held: held (limit)');
    expect(render(lane({ target: 0, queued: 2 }))).toBe('Lanes: no lane has a target');
  });

  it('leaves missing and invalid queue counts live', () => {
    for (const queued of [undefined, null, 0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(render(lane({ queued }))).toBe('Lanes: devin-flash 0/3');
    }
  });

  it('preserves the full digest without queue data', () => {
    expect(buildStatusDigest({ ...input, lanes: ok([lane()]) })).toEqual([
      'App: installed 1 · published 1 · up to date',
      'Merges: 0 in the last hour · 0 in the last 24h',
      'Lanes: devin-flash 0/3',
      'Needs Mason: none waiting',
      'Top P0: none in the inbox',
    ]);
  });

  it('carries the queue count from the runs state', async () => {
    const result = await gatherStatusDigestInput('/r', new Date('2026-11-10T20:00:00Z'), {
      installedVersion: () => '1', publishedVersion: async () => '1',
      mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
      runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes: [{ ...lane(), queued: 88, floor: null, ceiling: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }] }),
      needs: () => ({ status: 'available', items: [] }),
      inbox: async () => ({ sourceState: 'healthy', entries: [] }),
    });
    expect(result.lanes).toEqual(ok([lane({ queued: 88 })]));
    expect(buildStatusDigest(result)[2]).toBe('Lanes: stalled: devin-flash 0/3 (88 queued)');
  });
});
