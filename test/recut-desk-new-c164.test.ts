/** RQ-PHX-RECUTDESKS0C164: recut of #4848 — GET /api/nodes and the
 * phantom.nodes.v1 projection exercised through the real exported entry
 * points (handleApi, buildNodesSnapshot). Fake node ids and times only. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { buildNodesSnapshot, NODES_SCHEMA } from '../src/core/nodes/view.js';
import { handleApi } from '../src/core/web/api.js';

const socket = { localAddress: '127.0.0.1', localPort: 4312 };

afterEach(() => vi.unstubAllEnvs());

function nodesDir(): string {
  const home = mkdtempSync(join(tmpdir(), 'recut-c164-'));
  vi.stubEnv('ASHLR_HOME', home);
  const dir = join(home, 'nodes');
  mkdirSync(dir);
  return dir;
}

function response() {
  let status = 0;
  let body = '';
  const headers: Record<string, unknown> = {};
  const res = {
    writeHead: (code: number, values: Record<string, unknown>) => { status = code; Object.assign(headers, values); },
    end: (value: string) => { body = value; },
    setHeader: (name: string, value: unknown) => { headers[name] = value; },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, headers, raw: body, body: JSON.parse(body) as Record<string, unknown> }) };
}

async function get(path: string) {
  const req = { url: path, method: 'GET', socket, headers: {} } as unknown as IncomingMessage;
  const out = response();
  const handled = await handleApi(req, out.res, defaultConfig(), { token: 'test-only', allowDispatch: false });
  return { handled, ...out.result() };
}

describe('GET /api/nodes (recut of #4848)', () => {
  it('serves a 200 projection error for torn JSON instead of crashing', async () => {
    const dir = nodesDir();
    writeFileSync(join(dir, 'nodes.json'), '{"version":"drive.nodes.v1",oops');
    const out = await get('/api/nodes');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ schema: NODES_SCHEMA, nodes: [], leaderId: null, error: 'inventory is not valid JSON' });
  });

  it('answers only the exact route — a lookalike path gets no projection fields', async () => {
    nodesDir();
    const out = await get('/api/nodes/extra');
    expect(out.status).toBe(404);
    expect(out.body['schema']).toBeUndefined();
    expect(out.body['nodes']).toBeUndefined();
  });

  it('drops the leader badge once the lease lapses; lapsed holder and pool backup read standby', async () => {
    const dir = nodesDir();
    const now = Date.now();
    writeFileSync(join(dir, 'nodes.json'), JSON.stringify({
      version: 'drive.nodes.v1', sequence: 9, observedAt: now, jobs: [],
      leader: { nodeId: 'fake-alpha', session: 1, token: 5, expiresAt: now - 1_000 },
      pool: { primary: 'fake-alpha', backup: 'fake-beta', active: 'primary', epoch: 1, heartbeatAt: now },
      nodes: [
        { nodeId: 'fake-alpha', session: 1, heartbeatAt: now - 5_000, expiresAt: now + 600_000 },
        { nodeId: 'fake-beta', session: 2, heartbeatAt: now - 5_000, expiresAt: now + 600_000 },
        { nodeId: 'fake-gamma', session: 3, heartbeatAt: now - 5_000, expiresAt: now + 600_000 },
      ],
    }));
    const out = await get('/api/nodes');
    expect(out.status).toBe(200);
    expect(out.body['leaderId']).toBeNull();
    const rows = out.body['nodes'] as Array<Record<string, unknown>>;
    expect(rows.map(n => [n['id'], n['role'], n['status'], n['leader']])).toEqual([
      ['fake-alpha', 'standby', 'ready', false],
      ['fake-beta', 'standby', 'ready', false],
      ['fake-gamma', 'worker', 'ready', false],
    ]);
  });
});

describe('buildNodesSnapshot (recut of #4848)', () => {
  it('marks a heartbeat stamped in the future as unknown rather than ready', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recut-c164-snap-'));
    const now = Date.now();
    writeFileSync(join(dir, 'nodes.json'), JSON.stringify({
      version: 'drive.nodes.v1', sequence: 1, observedAt: now, jobs: [], leader: null,
      nodes: [{ nodeId: 'fake-clock-skew', session: 1, heartbeatAt: now + 60_000, expiresAt: now + 600_000 }],
    }));
    const snap = buildNodesSnapshot({ dir, nowMs: now });
    expect(snap.error).toBeNull();
    expect(snap.nodes.map(n => [n.id, n.status, n.heartbeatAgeMs])).toEqual([['fake-clock-skew', 'unknown', 0]]);
  });
});
