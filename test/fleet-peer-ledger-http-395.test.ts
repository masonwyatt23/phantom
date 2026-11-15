/** GET /api/verse/fleet/runtime-identity/peer-ledger — sanitized peer-bus budget evidence. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger, type PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import {
  createFleetPeerLedgerApi,
  handleFleetPeerLedgerApi,
  VERSE_FLEET_PEER_LEDGER_PATH as PATH,
} from '../src/core/verse/fleet-peer-ledger-api.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const NOW_MS = NOW.getTime();
const UUID = '123e4567-e89b-12d3-a456-426614174000';

let root: string, n = 0;
const row = (from: string, target: string, at: number, over: Record<string, unknown> = {}) => ({
  id: `peer-${UUID.slice(0, 35)}${n++ % 10}`, fromAgent: from, target, origin: `peer-${UUID}`,
  digest: 'a'.repeat(64), hopCount: 1, threadId: 'thread-secret-id', at, ...over });
function write(rows: unknown[]) {
  mkdirSync(join(root, 'agentnet'), { recursive: true });
  writeFileSync(join(root, 'agentnet', 'coordination.json'), JSON.stringify(rows), { mode: 0o600 });
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'peer-ledger-http-')); n = 0; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

// `path` arrives already stripped of the query (the router keeps it in req.url).
async function call(api: ApiModule, method = 'GET', path = PATH, url = path) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const req = { url } as IncomingMessage;
  const handled = await api({} as VerseApiContext, req, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('peer-ledger HTTP route', () => {
  it('answers 200 with a real readPeerLedger over a temp busRoot', async () => {
    write([row('agent0', 'agent1', NOW_MS - 1000), row('agent0', 'agent2', NOW_MS - 2000)]);
    const api = createFleetPeerLedgerApi({
      read: () => readPeerLedger({ busRoot: root, now: () => NOW_MS }),
      now: () => NOW,
    });
    const r = await call(api);
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body.v).toBe(1);
    expect(r.body.authority).toBe('none');
    expect(r.body.generatedAt).toBe(NOW.toISOString());
    expect(r.body.report.status).toBe('ok');
    expect(r.body.report.liveRows).toBe(2);
    expect(r.body.report.pairs).toHaveLength(2);
    expect(r.body.report.capacity).toBe(1024);
    expect(r.text).not.toContain('threadId');
    expect(r.text).not.toContain('aaaaaaaa');
  });

  it('degrades a throwing reader to the fixed fallback without leaking the message', async () => {
    const read = vi.fn((): PeerLedgerReport => { throw new Error('/Users/someone/secret-ledger'); });
    const r = await call(createFleetPeerLedgerApi({ read, now: () => NOW }));
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body.report).toEqual({
      v: 1, authority: 'none', status: 'unavailable', reason: 'peer-ledger-reader-failed',
      asOf: NOW.toISOString(), liveRows: 0, capacity: 1024,
      windowMs: PEER_WINDOW_MS, pairLimit: PEER_PAIR_LIMIT, maxHops: PEER_MAX_HOPS,
      pairs: [], origins: [], truncated: { pairs: false, origins: false },
    });
    expect(r.text).not.toContain('/Users/');
    expect(r.text).not.toContain('secret-ledger');
  });

  it('rejects POST with 405 before any read', async () => {
    const read = vi.fn(() => { throw new Error('must not be called'); });
    const r = await call(createFleetPeerLedgerApi({ read }), 'POST');
    expect(r).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects ?x=1 with 400 before any read', async () => {
    const read = vi.fn(() => { throw new Error('must not be called'); });
    const r = await call(createFleetPeerLedgerApi({ read }), 'GET', PATH, `${PATH}?x=1`);
    expect(r).toMatchObject({ handled: true, status: 400 });
    expect(r.body).toEqual({ v: 1, authority: 'none', error: 'no parameters accepted' });
    expect(read).not.toHaveBeenCalled();
  });

  it('routes the path through the runtime-identity dispatcher to the peerLedger seam', async () => {
    const peerLedger = vi.fn<ApiModule>(async () => true);
    const hostReach = vi.fn<ApiModule>(async () => false);
    const api = createFleetRuntimeIdentityApi({ peerLedger, hostReach });
    const r = await call(api, 'GET', PATH);
    expect(r.handled).toBe(true);
    expect(peerLedger.mock.calls[0]!.slice(3)).toEqual([PATH, 'GET']);
    expect(hostReach).not.toHaveBeenCalled();
  });

  it('returns false for an unrelated path', async () => {
    const r = await call(handleFleetPeerLedgerApi, 'GET', '/api/verse/fleet/runtime-identity/other');
    expect(r).toMatchObject({ handled: false, status: 0, body: null });
  });
});
