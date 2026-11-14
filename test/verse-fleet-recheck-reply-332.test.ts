/** GET /api/verse/fleet/recheck?reply=1 — adds the exact Slack-path reply text.
 * Read-only; fixtures are plainly fake. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSE_FLEET_RECHECK_PATH as PATH, createFleetRecheckApi } from '../src/core/verse/fleet-recheck-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';

const FAKE = {
  schema: 'fleet.recheck.v1',
  asOf: '2026-11-14T00:00:00.000Z',
  sections: {
    runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '1.2.3', fleetState: { ageSeconds: 5, stale: false } },
    claims: { state: 'VERIFIED', active: 1, top: [{ agent: 'fake-agent', repo: 'fake/repo' }] },
    bridge: { state: 'BLOCKED', missingBridge: 'fake bridge missing', channels: [{ channel: 'slack', state: 'LIVE' }] },
    task: { state: 'UNKNOWN', task: null, missing: ['no fake task'] },
  },
  overall: { state: 'BLOCKED', missing: ['fake bridge missing'] },
} as unknown as FleetRecheck;

const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'recheck-reply-332-'));
  tmps.push(d);
  return d;
}

async function call(url: string, h = home()) {
  let calls = 0;
  const api = createFleetRecheckApi({ readRecheck: () => { calls++; return FAKE; }, home: () => h });
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url } as IncomingMessage, res, PATH, 'GET');
  return { status, text, body: JSON.parse(text), calls };
}

describe('fleet recheck api ?reply=1', () => {
  it('adds reply equal to formatRecheckReply(verdict)', async () => {
    const r = await call(`${PATH}?reply=1`);
    expect(r.status).toBe(200);
    expect(r.body.reply).toBe(formatRecheckReply(FAKE));
    expect(r.body.recheck).toEqual(FAKE);
    expect(r.body.history).toBeUndefined();
  });

  it('rejects any other reply value with 400 before reading the verdict', async () => {
    for (const v of ['2', '', 'true']) {
      const r = await call(`${PATH}?reply=${v}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'reply must be 1' });
      expect(r.calls).toBe(0);
    }
  });

  it('plain request body is exactly { recheck }', async () => {
    const r = await call(PATH);
    expect(r.status).toBe(200);
    expect(r.text).toBe(JSON.stringify({ recheck: FAKE }));
  });

  it('?history=3&reply=1 returns both and does not append to the log', async () => {
    const h = home();
    mkdirSync(join(h, 'fleet'), { recursive: true });
    const r = await call(`${PATH}?history=3&reply=1`, h);
    expect(r.status).toBe(200);
    expect(r.body.reply).toBe(formatRecheckReply(FAKE));
    expect(r.body.history).toEqual({ rows: [], skipped: 0, missing: true });
    writeFileSync(join(h, 'marker'), '');
  });
});
