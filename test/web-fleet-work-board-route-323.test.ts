/**
 * RQ-PHX-WORKBOARDROUTE323 — GET /api/fleet/work-board through the real
 * handleApi dispatch: the same listWorkBoard listing `ashlr fleet work-board
 * --json` and fleet_work_board serve, read from the server-owned default
 * fleet root (<ASHLR_HOME>/fleet) so the desktop Fleet Board pane renders
 * the coordination board instead of "Work board not available".
 *
 * Hermetic: temporary ASHLR_HOME, real durable bus store, minimal fake
 * req/res, no daemon, no network. No query parameter may choose a root.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApi } from '../src/core/web/api.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import type { AshlrConfig } from '../src/core/types.js';

let home: string, root: string, now: number;
const TTL = 10_000_000;
const REF_A = 'T0FAKEWS/C0FAKECH/1700000000.000001';
const SENTINEL = 'FAKE-SENTINEL-BODY-323-never-serialised';
const iso = (ms: number) => new Date(ms).toISOString();
const STATES = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];

/** The field subset work-board-section.tsx's WorkBoardItemView reads. */
interface WorkBoardItemView {
  id: string;
  channel: string;
  channelRef: string | null;
  receivedAt: string;
  state: string;
  asOf: string;
  source: string;
  missing: string[];
}

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-peer-agent', to: 'fake-lane', priority: 'P2', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-peer-agent', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'slack-coordination', text: `fake request text ${SENTINEL}` },
});
const busRequest = (id: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  body: { kind: 'work', text: `fake request text ${SENTINEL}` },
});
/** Posts at the fake clock, then steps it forward so receivedAt orders strictly. */
const post = (envelope: BusEnvelope) => {
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  now += 1_000;
};
const seed = () => {
  post(slackRequest('slack-request-a', REF_A));
  post(busRequest('bus-request-b'));
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'web-work-board-323-'));
  root = join(home, 'fleet');
  now = Date.now();
  vi.stubEnv('ASHLR_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function get(query = ''): Promise<{ handled: boolean; status: number; body: Record<string, unknown> }> {
  const req = Readable.from([]) as IncomingMessage;
  req.url = `/api/fleet/work-board${query}`;
  req.method = 'GET';
  req.headers = {};
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; },
    end(text: string) { payload = text; },
  } as unknown as ServerResponse;
  const handled = await handleApi(req, res, {} as AshlrConfig, { token: 'route-323', allowDispatch: false });
  return { handled, status, body: payload ? JSON.parse(payload) as Record<string, unknown> : {} };
}

describe('GET /api/fleet/work-board through handleApi', { timeout: 60_000 }, () => {
  it('answers an empty fleet root honestly: an items array and a real inbox state', async () => {
    const r = await get();
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body['items']).toEqual([]);
    expect(r.body['truncated']).toBe(false);
    expect(['ok', 'unavailable']).toContain(r.body['inbox']);
    expect(Number.isFinite(Date.parse(String(r.body['asOf'])))).toBe(true);
  });

  it('lists seeded requests newest-first with state and channelRef, never body text', async () => {
    seed();
    const r = await get('?limit=20');
    expect(r.status).toBe(200);
    expect(r.body['inbox']).toBe('ok');
    const items = r.body['items'] as WorkBoardItemView[];
    expect(items.map(item => item.id)).toEqual(['bus-request-b', 'slack-request-a']);
    expect(items.map(item => item.receivedAt)).toEqual([iso(now - 1_000), iso(now - 2_000)]);
    expect(items[0]).toMatchObject({
      channel: 'bus', channelRef: null, state: 'RECEIVED',
      missing: ['named owner', 'durable claim receipt'],
    });
    expect(items[1]).toMatchObject({ channel: 'slack', channelRef: REF_A, state: 'RECEIVED' });
    expect(JSON.stringify(r.body)).not.toContain(SENTINEL);
    for (const item of items) expect(item).not.toHaveProperty('body');
  });

  it('honours limit with a truncated flag', async () => {
    seed();
    const r = await get('?limit=1');
    expect(r.status).toBe(200);
    expect(r.body['inbox']).toBe('ok');
    expect(r.body['truncated']).toBe(true);
    expect((r.body['items'] as WorkBoardItemView[]).map(item => item.id)).toEqual(['bus-request-b']);
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'limit=', 'limit=1.5', 'limit=-3'])(
    'rejects ?%s with 400 invalid-limit', async (query) => {
      const r = await get(`?${query}`);
      expect(r.handled).toBe(true);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid-limit' });
    },
  );

  it('thread filters one exact channel_ref; an unusable thread is a 400', async () => {
    seed();
    const filtered = await get(`?thread=${encodeURIComponent(REF_A)}`);
    expect(filtered.status).toBe(200);
    expect((filtered.body['items'] as WorkBoardItemView[]).map(item => item.id)).toEqual(['slack-request-a']);
    const none = await get(`?thread=${encodeURIComponent('T0FAKEWS/C0FAKECH/9999999999.000099')}`);
    expect(none.status).toBe(200);
    expect(none.body['items']).toEqual([]);
    for (const bad of ['', 'x'.repeat(513), 'bad\u0000ref', 'bad\nref']) {
      const r = await get(`?thread=${encodeURIComponent(bad)}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid-thread' });
    }
  });

  it('ignores root/path/cwd query params — the server-owned default root is always read', async () => {
    seed();
    const decoy = mkdtempSync(join(tmpdir(), 'web-work-board-323-decoy-'));
    try {
      const r = await get(`?root=${encodeURIComponent(decoy)}&path=%2Fetc&cwd=%2F`);
      expect(r.status).toBe(200);
      expect(r.body['inbox']).toBe('ok');
      expect((r.body['items'] as WorkBoardItemView[]).map(item => item.id))
        .toEqual(['bus-request-b', 'slack-request-a']);
      // Read-only and decoy-blind: nothing was created under the caller-named dir.
      expect(readdirSync(decoy)).toEqual([]);
      expect(existsSync(join(decoy, 'bus-inbox'))).toBe(false);
    } finally { rmSync(decoy, { recursive: true, force: true }); }
  });

  it('serialises the WorkBoardResponse shape the desktop pane consumes', async () => {
    seed();
    const r = await get();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['asOf', 'inbox', 'items', 'truncated']);
    expect(['ok', 'unavailable']).toContain(r.body['inbox']);
    expect(typeof r.body['truncated']).toBe('boolean');
    expect(Number.isFinite(Date.parse(String(r.body['asOf'])))).toBe(true);
    for (const item of r.body['items'] as WorkBoardItemView[]) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.channel).toBe('string');
      expect(item.channelRef === null || typeof item.channelRef === 'string').toBe(true);
      expect(Number.isFinite(Date.parse(item.receivedAt))).toBe(true);
      expect(STATES).toContain(item.state);
      expect(Number.isFinite(Date.parse(item.asOf))).toBe(true);
      expect(typeof item.source).toBe('string');
      expect(Array.isArray(item.missing)).toBe(true);
    }
  });
});
