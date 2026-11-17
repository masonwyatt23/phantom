import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetCoordinationReturnsApi, VERSE_FLEET_COORDINATION_RETURNS_PATH as PATH } from '../src/core/verse/fleet-coordination-returns-api.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const time = NOW.getTime();
const board: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, proposals: [], claims: [],
  messages: [{ id: 'return-c1', from: 'agent', to: 'fleet', at: time - 1000, expiresAt: time + 60_000,
    body: 'RESULT VERIFIED fake/repo claim c1 task "task": pr #12 head abcdef1' }],
};

async function call(api: ApiModule, method = 'GET') {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url: PATH } as IncomingMessage, res, PATH, method);
  expect(text.length).toBeLessThan(10_000);
  return { handled, status, text, body: JSON.parse(text) };
}

describe('returns route observation clock recovery', () => {
  for (const failure of ['invalid', 'throw'] as const) {
    it(`recovers on the same handler after a ${failure} clock`, async () => {
      const original = structuredClone(board);
      const read = vi.fn(() => board);
      let calls = 0;
      const api = createFleetCoordinationReturnsApi({ read, now: () => {
        if (calls++ === 0) {
          if (failure === 'throw') throw new Error('clock private detail');
          return new Date(NaN);
        }
        return NOW;
      } });
      const unknown = await call(api);
      expect(unknown).toMatchObject({ handled: true, status: 200, body: {
        state: 'unknown', source: 'coordination-ledger', asOf: 'unknown', generatedAt: 'unknown',
        reason: 'observation clock: unavailable', authority: 'none', returns: [{ temporal: 'invalid' }],
      } });
      expect(unknown.text).not.toContain('clock private detail');
      const recovered = await call(api);
      expect(recovered).toMatchObject({ status: 200, body: {
        state: 'known', asOf: NOW.toISOString(), generatedAt: NOW.toISOString(), authority: 'none',
        returns: [{ claimId: 'c1', result: 'VERIFIED', temporal: 'current' }],
      } });
      expect(read).toHaveBeenCalledTimes(2);
      expect(board).toEqual(original);
    });
  }

  it('reports a failed ledger separately with a valid clock', async () => {
    const api = createFleetCoordinationReturnsApi({ now: () => NOW, read: () => { throw new Error('ledger private detail'); } });
    const result = await call(api);
    expect(result).toMatchObject({ status: 200, body: { state: 'unknown', asOf: NOW.toISOString(),
      generatedAt: NOW.toISOString(), reason: 'coordination ledger: reader failed', returns: [], authority: 'none' } });
    expect(result.text).not.toContain('ledger private detail');
  });

  it('preserves a valid GET and rejects other methods without reading or consulting the clock', async () => {
    const original = structuredClone(board);
    const read = vi.fn(() => board);
    const now = vi.fn(() => NOW);
    const api = createFleetCoordinationReturnsApi({ read, now });
    expect(await call(api, 'POST')).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    expect(read).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(await call(api)).toMatchObject({ status: 200, body: { state: 'known', authority: 'none',
      asOf: NOW.toISOString(), generatedAt: NOW.toISOString(), returns: [{ temporal: 'current' }] } });
    expect(board).toEqual(original);
  });
});
