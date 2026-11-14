/** GET /api/verse/fleet/tailnet-peers — the Fleet Host TailnetPeersCard feed. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_TAILNET_PEERS_PATH as PATH,
  createFleetTailnetPeersApi,
} from '../src/core/verse/fleet-tailnet-peers-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';
import { WORKBENCH_ROUTE_FAMILIES } from '../src/core/verse/workbench-types.js';
import { narrowTailnetPeers } from '../src/web-ui/routes/verse/fleet-host/tailnet-peers-model.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');
const SECRET_DNS = 'secret-dns.example.ts.net.';
const SECRET_KEY = 'nodekey:SECRETKEYVALUE';
const SECRET_IP = '100.64.9.9';

const STATUS = JSON.stringify({
  Self: { HostName: 'fake-self' },
  Peer: {
    a: { HostName: 'fake-studio', OS: 'macOS', Online: false, LastSeen: '2026-11-13T17:00:00Z' },
    b: {
      HostName: 'fake-mini', OS: 'macOS', Online: true, LastSeen: '2026-11-13T17:59:00Z',
      TailscaleIPs: [SECRET_IP], DNSName: SECRET_DNS, PublicKey: SECRET_KEY,
    },
  },
});

function deps(exec: TailnetPeersDeps['exec']): TailnetPeersDeps {
  return { now: () => NOW, homeDir: () => '/Users/fakehome', exec };
}

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet tailnet-peers api', () => {
  it('returns online-first peers the card narrows', async () => {
    const calls: Array<readonly string[]> = [];
    const r = await call(createFleetTailnetPeersApi({
      peersDeps: deps((_c, args) => { calls.push(args); return STATUS; }),
      now: () => NOW,
    }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ v: 1, generatedAt: NOW.toISOString(), self: 'fake-self' });
    expect(r.body.peers.map((p: { name: string }) => p.name)).toEqual(['fake-mini', 'fake-studio']);
    expect(narrowTailnetPeers(r.body)?.peers).toHaveLength(2);
    expect(calls).toEqual([['status', '--json']]);
  });

  it('degrades to an empty list when tailscale is unavailable', async () => {
    const r = await call(createFleetTailnetPeersApi({
      peersDeps: deps(() => { throw new Error('ENOENT'); }),
      now: () => NOW,
    }));
    expect(r.status).toBe(200);
    expect(r.body.peers).toEqual([]);
    expect(r.body.reasons).toContain('tailscale unavailable or status unreadable');
  });

  it('reports reader failure without the thrown message', async () => {
    const r = await call(createFleetTailnetPeersApi({
      peersDeps: { ...deps(() => STATUS), now: () => { throw new Error('boom-secret'); } },
      now: () => NOW,
    }));
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('boom-secret');
    expect(r.body).toMatchObject({ self: 'unknown', peers: [], reasons: ['tailnet peers: reader failed'] });
  });

  it('never leaks addresses, DNS names or keys', async () => {
    const r = await call(createFleetTailnetPeersApi({ peersDeps: deps(() => STATUS), now: () => NOW }));
    for (const s of [SECRET_IP, SECRET_DNS, SECRET_KEY, 'SECRETKEYVALUE']) expect(r.text).not.toContain(s);
  });

  it('rejects non-GET with 405 and ignores other paths', async () => {
    const api = createFleetTailnetPeersApi({ peersDeps: deps(() => STATUS), now: () => NOW });
    const post = await call(api, 'POST');
    expect(post.status).toBe(405);
    expect(post.body).toEqual({ error: 'method not allowed' });
    expect((await call(api, 'GET', '/api/verse/fleet/other')).handled).toBe(false);
  });

  it('is registered exactly once in the workbench route table', () => {
    const rows = WORKBENCH_ROUTE_FAMILIES.filter(f => (f.prefixes as readonly string[]).includes(PATH));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: 'desktop-command', handler: 'handleFleetTailnetPeersApi' });
  });
});
