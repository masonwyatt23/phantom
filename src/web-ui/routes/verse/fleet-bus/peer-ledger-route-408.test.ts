import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { peerLedgerQuery } from './peer-ledger-query.js';
import { parsePeerLedger, peerLedgerHeadline } from './peer-ledger-model.js';

// Hard-coded: mirrors VERSE_FLEET_PEER_LEDGER_PATH in
// src/core/verse/fleet-peer-ledger-api.ts (server code stays out of the web bundle).
const PATH = '/api/verse/fleet/peer-ledger';

const okReport = () => ({
  v: 1, authority: 'none', status: 'ok', asOf: '2026-11-15T00:00:00Z', liveRows: 3, capacity: 1024, windowMs: 3600000,
  pairLimit: 6, maxHops: 8,
  pairs: [{ fromAgent: 'dot', target: 'claude', inWindow: 6, remaining: 0, lastAt: '2026-11-15T00:00:00Z' }],
  origins: [], truncated: { pairs: false, origins: false },
});
const unavailableReport = () => ({
  v: 1, authority: 'none', status: 'unavailable', reason: 'peer-ledger-reader-failed', asOf: '2026-11-15T00:00:00Z',
  liveRows: 0, capacity: 0, pairLimit: 0, maxHops: 0, pairs: [], origins: [],
});

function stub(body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function load(body: unknown) {
  const fetch = stub(body);
  const result = await peerLedgerQuery.fetch(new AbortController().signal);
  return { fetch, result };
}

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('fetches the served peer-ledger path and parses an ok flat report', async () => {
  const { fetch, result } = await load(okReport());
  expect(fetch).toHaveBeenCalledWith(PATH, expect.any(Object));
  const view = parsePeerLedger(result);
  expect(view?.status).toBe('ok');
  expect(view?.pairs).toHaveLength(1);
  expect(peerLedgerHeadline(view!)).toBe('Peer bus: 3 of 1024 rows · 1 pair at limit');
});

it('parses an unavailable flat report with its reason', async () => {
  const { result } = await load(unavailableReport());
  const view = parsePeerLedger(result);
  expect(view?.status).toBe('unavailable');
  expect(peerLedgerHeadline(view!)).toBe('Peer bus: unknown (peer-ledger-reader-failed)');
});

it('uses asOf as generatedAt when wrapping', async () => {
  const { result } = await load(okReport());
  expect((result as { generatedAt: string }).generatedAt).toBe('2026-11-15T00:00:00Z');
});

it('rejects a body missing authority none', async () => {
  const { authority: _a, ...noAuthority } = okReport();
  const { result } = await load(noAuthority);
  expect(parsePeerLedger(result)).toBeNull();
});

it('leaves an already-enveloped body unchanged', async () => {
  const envelope = { v: 1, authority: 'none', generatedAt: 'x', report: okReport() };
  const { result } = await load(envelope);
  expect(result).toEqual(envelope);
});
