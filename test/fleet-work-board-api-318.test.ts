/** GET /api/fleet/work-board through the real server against a real bus inbox
 * in a private ASHLR_HOME. Fixtures are plainly fake; no body text may leak. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const REF_A = 'T0FAKEWS/C0FAKECH/1700000000.000001';
const REF_B = 'T0FAKEWS/C0FAKECH/1700000000.000002';
const SECRET = 'fake-body-text-zzz';
let home: string, root: string, now: number, handle: { close(): Promise<void> } | undefined;
let prevHome: string | undefined;

const request = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-peer-agent', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-peer-agent', vendor: 'fake-vendor', human: false, team: true },
  external: false, body: { kind: 'slack-coordination', text: SECRET },
});
const post = (e: BusEnvelope) => { expect(appendBusInbox(e, { root, now: () => now }).status).toBe('posted'); };

function get(h: { port: number }, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: h.port, path, method: 'GET',
      headers: { Host: `127.0.0.1:${h.port}`, ...readAuthHeaders(h.port) } }, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function boot() {
  const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
  handle = h;
  return h;
}

beforeEach(() => {
  prevHome = process.env['ASHLR_HOME'];
  home = mkdtempSync(join(tmpdir(), 'work-board-api-318-'));
  chmodSync(home, 0o700);
  process.env['ASHLR_HOME'] = home;
  root = join(home, 'fleet');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  now = Date.now();
});
afterEach(async () => {
  await handle?.close(); handle = undefined;
  if (prevHome === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('GET /api/fleet/work-board', { timeout: 60_000 }, () => {
  it('empty store: items [] and an inbox field', async () => {
    const res = await get(await boot(), '/api/fleet/work-board');
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.items).toEqual([]);
    expect(['ok', 'unavailable']).toContain(json.inbox);
    expect(typeof json.asOf).toBe('string');
  });

  it('two requests and a reply: two items, newest first, no body text', async () => {
    post(request('api-request-a', REF_A)); now += 1000;
    post(request('api-request-b', REF_B)); now += 1000;
    expect(postBusReply('api-request-a', 'fake-reply-1', { text: SECRET }, { root, now: () => now }).outcome).toBe('posted');
    const res = await get(await boot(), '/api/fleet/work-board');
    const json = JSON.parse(res.body);
    expect(json.inbox).toBe('ok');
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['api-request-b', 'api-request-a']);
    expect(json.truncated).toBe(false);
    expect(res.body).not.toContain(SECRET);
  });

  it('limit=1 truncates; limit=abc falls back to the default', async () => {
    post(request('api-request-a', REF_A)); now += 1000;
    post(request('api-request-b', REF_B));
    const h = await boot();
    const one = JSON.parse((await get(h, '/api/fleet/work-board?limit=1')).body);
    expect(one.items).toHaveLength(1);
    expect(one.truncated).toBe(true);
    const bad = JSON.parse((await get(h, '/api/fleet/work-board?limit=abc')).body);
    expect(bad.items).toHaveLength(2);
    expect(bad.truncated).toBe(false);
  });

  it('thread filters to that channel_ref', async () => {
    post(request('api-request-a', REF_A)); now += 1000;
    post(request('api-request-b', REF_B));
    const res = await get(await boot(), `/api/fleet/work-board?thread=${encodeURIComponent(REF_A)}`);
    expect(JSON.parse(res.body).items.map((i: { id: string }) => i.id)).toEqual(['api-request-a']);
  });

  it('rejects an overlong or control-character thread with 400', async () => {
    const h = await boot();
    for (const t of ['x'.repeat(513), 'a%00b', 'a%0Ab']) {
      const res = await get(h, `/api/fleet/work-board?thread=${t}`);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid thread' });
    }
  });
});
