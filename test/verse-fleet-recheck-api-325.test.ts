/** GET /api/verse/fleet/recheck — read-only fleet.recheck.v1 verdict. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { VERSE_FLEET_RECHECK_PATH as PATH, createFleetRecheckApi } from '../src/core/verse/fleet-recheck-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { WORKBENCH_ROUTE_FAMILIES } from '../src/core/verse/workbench-types.js';

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

const FAKE = {
  schema: 'fleet.recheck.v1',
  asOf: '2026-11-13T18:00:00.000Z',
  sections: { fake: 'section' },
  overall: { state: 'VERIFIED', missing: [] },
} as unknown as FleetRecheck;

describe('fleet recheck api', () => {
  it('returns the injected recheck verbatim', async () => {
    const r = await call(createFleetRecheckApi({ read: async () => FAKE }));
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(FAKE);
  });

  it('rejects non-GET with 405', async () => {
    const read = vi.fn(async () => FAKE);
    const r = await call(createFleetRecheckApi({ read }), 'POST');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(405);
    expect(r.body).toEqual({ error: 'method not allowed' });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not handle other paths', async () => {
    const read = vi.fn(async () => FAKE);
    expect((await call(createFleetRecheckApi({ read }), 'GET', '/api/verse/fleet/recheck/x')).handled).toBe(false);
    expect((await call(createFleetRecheckApi({ read }), 'GET', '/api/verse/fleet/other')).handled).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('degrades to UNKNOWN without leaking error text when the reader throws', async () => {
    const r = await call(createFleetRecheckApi({ read: async () => { throw new Error('boom /Users/fake/path'); } }));
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('boom');
    expect(r.text).not.toContain('/Users/fake');
    expect(r.text).not.toContain('VERIFIED');
    expect(r.body).toMatchObject({
      schema: 'fleet.recheck.v1',
      overall: { state: 'UNKNOWN', missing: ['recheck: reader failed'] },
      sections: null,
    });
    expect(Number.isNaN(Date.parse(r.body.asOf))).toBe(false);
  });

  it('ignores the query string and calls read with no args', async () => {
    const read = vi.fn(async (..._a: unknown[]) => FAKE);
    const r = await call(createFleetRecheckApi({ read }), 'GET', PATH + '?root=/tmp');
    // The router passes a bare path; a query-suffixed string is not an exact match.
    expect(r.handled).toBe(false);
    const ok = await call(createFleetRecheckApi({ read }));
    expect(ok.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]).toEqual([]);
  });

  it('is registered in the workbench route families', () => {
    const row = WORKBENCH_ROUTE_FAMILIES.find(f => f.id === 'fleet-recheck');
    expect(row).toMatchObject({ handler: 'handleFleetRecheckApi', prefixes: [PATH] });
  });
});
