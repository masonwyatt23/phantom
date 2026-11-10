// Recut of #4023: the Verse live-status "Fleet health" panel reads GET
// /api/verse/fleet/doctor, and `fleet apps-changes --bus` posts each event to
// the leaders inbox. These assert both through the real exported entry points.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createAppsChangesPublisher } from '../src/core/fleet/apps-changes-bus.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { mountedApiModules, setMountedApiModulesForTest, type VerseApiContext } from '../src/core/verse/verse-api.js';

describe('recut #4023: fleet doctor in the Verse API', () => {
  it('mounts fleet-doctor in the real table and it refuses POST with 405', async () => {
    setMountedApiModulesForTest(null);
    const entry = mountedApiModules().find(m => m.id === 'fleet-doctor');
    expect(entry).toBeDefined();
    const handler = await entry!.load();
    let status = 0;
    const res = { writeHead: (s: number) => { status = s; }, end: () => {}, setHeader: () => {}, statusCode: 0 } as unknown as ServerResponse;
    const handled = await handler({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/doctor', 'POST');
    expect(handled).toBe(true);
    expect(status).toBe(405);
  });
});

describe('recut #4023: apps-changes bus publisher', () => {
  it('posts sequenced apps-changes envelopes addressed to leaders', () => {
    const sent: BusEnvelope[] = [];
    const append = vi.fn((envelope: BusEnvelope) => { sent.push(envelope); return { status: 'posted' } as const; });
    const publish = createAppsChangesPublisher('/fixture/runs', append as unknown as Parameters<typeof createAppsChangesPublisher>[1]);
    expect(publish({ type: 'transition', app: 'example-app', state: 'stopped', time: '2026-11-10T00:00:00.000Z' })).toBe(true);
    expect(publish({ type: 'summary', outcome: 'complete', samples: 2, transitions: 1 })).toBe(true);
    expect(append).toHaveBeenCalledWith(expect.anything(), { root: '/fixture/runs' });
    expect(sent.map(e => [e.from, e.to, (e.body as Record<string, unknown>).kind, (e.body as Record<string, unknown>).sequence]))
      .toEqual([['apps-changes', 'leaders', 'apps-changes.event.v1', 1], ['apps-changes', 'leaders', 'apps-changes.event.v1', 2]]);
    expect((sent[0]!.body as Record<string, unknown>).state).toBe('stopped');
  });
});
