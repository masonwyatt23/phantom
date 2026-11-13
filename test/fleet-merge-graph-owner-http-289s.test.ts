/**
 * RQ-PHX-MERGEGRAPHOWNERQUALIFY289S — qualification evidence for EXISTING
 * owner PR #5334 (RQ-PHX-MERGEGRAPHORIGINAL246S), which preserves original
 * #4387's merge-graph scenarios in test/merge-graph-original-246s.test.ts
 * against mergeGraph() directly. This file proves the same owner semantics
 * survive the real HTTP boundary of createFleetMergeGraphApi: a real
 * node:http server plus a fetch round-trip through the production sendJson
 * serializer, with the jobs-ledger reader and clock injected and the ledger
 * supplied as a temporary synthetic file. mergeGraph is never mocked and
 * every expected bucket is a literal; the request path is the module's own
 * VERSE_FLEET_MERGE_GRAPH_PATH export, not an invented mount.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { MergeGraphReport } from '../src/core/fleet/merge-graph.js';
import { createFleetMergeGraphApi, VERSE_FLEET_MERGE_GRAPH_PATH as PATH } from '../src/core/verse/fleet-merge-graph-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

// The owner suite's fixture verbatim (test/merge-graph-original-246s.test.ts):
// a launch-only lane attribution for job a, duplicate outcome rows for job b,
// a merge with no ttm_s (job c) and one a minute outside the window (job old).
const NOW = Date.parse('2026-11-09T12:30:00Z');
const LEDGER = [
  { event: 'launch', job: 'a', lane: 'work', ts: '2026-11-08T09:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'a', ts: '2026-11-09T11:05:00Z', ttm_s: 60 },
  { event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:30:00Z', ttm_s: 180 },
  { event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:30:00Z', ttm_s: 180 },
  { event: 'outcome', state: 'MERGED', job: 'c', lane: 'fast', ts: '2026-11-09T12:10:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'old', lane: 'work', ts: '2026-11-08T12:59:00Z' },
].map(row => JSON.stringify(row)).join('\n');

const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: 't'.repeat(64), allowDispatch: true };
let handler: ApiModule;
let server: http.Server;
let base: string;
let dir: string;

function mount(read: () => Promise<string | null>): void {
  handler = createFleetMergeGraphApi({ read, now: () => NOW });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handler(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(418, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'declined' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-graph-289s-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function req(p: string, method = 'GET') {
  const res = await fetch(`${base}${p}`, { method });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as unknown };
}

function writeLedger(text: string): string {
  const file = path.join(dir, 'jobs.jsonl');
  fs.writeFileSync(file, text);
  return file;
}

describe('GET merge-graph route over real HTTP', () => {
  it('serializes unique merges, launch-attributed lanes, 24 buckets and medians of known times', async () => {
    const file = writeLedger(LEDGER);
    mount(() => fs.promises.readFile(file, 'utf8'));
    const r = await req(PATH);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = r.json as MergeGraphReport;
    expect(body).toMatchObject({ schema: 'metrics.merges.v1', known: true, windowHours: 24 });
    // 'fast' sorts before 'work'; the out-of-window 'old' merge creates no third lane.
    expect(body.lanes!.map(lane => lane.lane)).toEqual(['fast', 'work']);
    const fast = body.lanes![0]!;
    const work = body.lanes![1]!;
    expect(work.buckets).toHaveLength(24);
    expect(fast.buckets).toHaveLength(24);
    // Job a (lane taken from its launch row, not the outcome) and the
    // deduplicated job b share the 11:00Z bucket; median of [60, 180] is 120.
    expect(work.buckets[22]).toEqual({ start: '2026-11-09T11:00:00.000Z', merges: 2, medianSeconds: 120 });
    // A known-empty bucket still serializes an explicit medianSeconds: null.
    expect(work.buckets[0]).toEqual({ start: '2026-11-08T13:00:00.000Z', merges: 0, medianSeconds: null });
    expect(Object.keys(work.buckets[0]!)).toContain('medianSeconds');
    // Job c merges with no ttm_s: counted in the 12:00Z bucket, median null.
    expect(fast.buckets[23]).toEqual({ start: '2026-11-09T12:00:00.000Z', merges: 1, medianSeconds: null });
    // Job 'old' (12:59Z, one minute before the window) is dropped entirely.
    expect(work.buckets.reduce((sum, bucket) => sum + bucket.merges, 0)).toBe(2);
    expect(fast.buckets.reduce((sum, bucket) => sum + bucket.merges, 0)).toBe(1);
  });

  it('keeps an unreadable ledger as known:false with lanes:null, never an empty graph', async () => {
    mount(async () => null);
    const r = await req(PATH);
    expect(r.status).toBe(200);
    const body = r.json as MergeGraphReport;
    expect(body).toEqual({ schema: 'metrics.merges.v1', known: false, windowHours: 24, lanes: null });
    // lanes serialized as explicit null, not omitted and not [].
    expect(Object.keys(body)).toContain('lanes');
  });

  it('keeps a rejecting reader as known:false and leaks no error detail', async () => {
    const secret = path.join(dir, 'jobs.jsonl');
    mount(async () => { throw new Error(`EACCES: permission denied, open '${secret}'`); });
    const r = await req(PATH);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ schema: 'metrics.merges.v1', known: false, windowHours: 24, lanes: null });
    expect(JSON.stringify(r.json)).not.toContain('EACCES');
    expect(JSON.stringify(r.json)).not.toContain(dir);
  });

  it('serves an empty ledger as known:true with lanes:[], distinct from unknown', async () => {
    const file = writeLedger('');
    mount(() => fs.promises.readFile(file, 'utf8'));
    const r = await req(PATH);
    expect(r.status).toBe(200);
    const body = r.json as MergeGraphReport;
    expect(body).toEqual({ schema: 'metrics.merges.v1', known: true, windowHours: 24, lanes: [] });
    expect(body.lanes).not.toBeNull();
  });

  it('answers 405 to non-GET without ever reading the ledger', async () => {
    const read = vi.fn(async () => LEDGER);
    mount(read);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await req(PATH, method);
      expect(r.status).toBe(405);
      expect(r.json).toEqual({ error: 'method not allowed' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('declines paths outside the module route without reading', async () => {
    const read = vi.fn(async () => LEDGER);
    mount(read);
    const r = await req(`${PATH}-extra`);
    expect(r.status).toBe(418);
    expect(r.json).toEqual({ error: 'declined' });
    expect(read).not.toHaveBeenCalled();
  });
});
