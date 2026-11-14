/** GET /api/verse/fleet/recheck?history=N — history read outcome evidence.
 * Absent log, successful empty read and failed read must stay distinguishable
 * through top-level outcome/failure while `history` keeps {rows, skipped,
 * missing}; a failed read never suppresses the fresh verdict. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSE_FLEET_RECHECK_PATH as PATH, createFleetRecheckApi } from '../src/core/verse/fleet-recheck-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { recheckLogPath } from '../src/core/fleet/recheck-record.js';

const VERDICT = {
  schema: 'fleet.recheck.v1',
  asOf: '2026-11-14T00:00:00.000Z',
  sections: {},
  overall: { state: 'VERIFIED', missing: [] },
} as unknown as FleetRecheck;

const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'recheck-api-331s-'));
  tmps.push(d);
  return d;
}

function row(asOf: string, overall: string): string {
  return JSON.stringify({
    schema: 'fleet.recheck-record.v1', asOf, overall,
    sections: {
      runtime: { state: 'VERIFIED', host: 'h', installedVersion: '1', asOf },
      claims: { state: 'VERIFIED', active: 0, asOf },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf },
      task: { state: 'VERIFIED', id: null, owner: null, claimReceipt: null, asOf },
    },
  });
}

async function call(api: ApiModule, method = 'GET', url = `${PATH}?history=5`) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url } as IncomingMessage, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null, raw: text };
}

const apiFor = (h: string) => createFleetRecheckApi({ readRecheck: () => VERDICT, home: () => h });

describe('fleet recheck api history outcome', () => {
  it('absent log keeps the legacy shape with no outcome', async () => {
    const h = home();
    const r = await call(apiFor(h));
    expect(r.status).toBe(200);
    expect(r.body.recheck).toEqual(VERDICT);
    expect(r.body.history).toEqual({ rows: [], skipped: 0, missing: true });
    expect(r.body.outcome).toBeUndefined();
    expect(r.body.failure).toBeUndefined();
    expect(existsSync(recheckLogPath(h))).toBe(false);
  });

  it('a fresh empty file is a successful empty read, distinct from absent', async () => {
    const h = home();
    mkdirSync(join(h, 'fleet'), { recursive: true });
    writeFileSync(recheckLogPath(h), '');
    const r = await call(apiFor(h));
    expect(r.body.history).toEqual({ rows: [], skipped: 0, missing: false });
    expect(r.body.outcome).toBe('ok');
    expect(r.body.failure).toBeUndefined();
    expect(readFileSync(recheckLogPath(h), 'utf8')).toBe('');
  });

  it('a valid row reads ok and preserves rows/skipped/missing', async () => {
    const h = home();
    mkdirSync(join(h, 'fleet'), { recursive: true });
    const line = `${row('2026-11-14T01:00:00.000Z', 'BLOCKED')}\nnot json\n`;
    writeFileSync(recheckLogPath(h), line);
    const r = await call(apiFor(h));
    expect(r.body.history.rows.map((x: { asOf: string }) => x.asOf)).toEqual(['2026-11-14T01:00:00.000Z']);
    expect(r.body.history.skipped).toBe(1);
    expect(r.body.history.missing).toBe(false);
    expect(r.body.outcome).toBe('ok');
    expect(readFileSync(recheckLogPath(h), 'utf8')).toBe(line);
  });

  it('a failed history read reports unreadable + safe code without suppressing the verdict', async () => {
    const h = home();
    mkdirSync(recheckLogPath(h), { recursive: true }); // directory at the log path → EISDIR
    const r = await call(apiFor(h));
    expect(r.status).toBe(200);
    expect(r.body.recheck).toEqual(VERDICT);
    expect(r.body.history).toEqual({ rows: [], skipped: 0, missing: false });
    expect(r.body.outcome).toBe('unreadable');
    expect(r.body.failure).toBe('EISDIR');
    expect(r.raw).not.toContain(h);
    expect(statSync(recheckLogPath(h)).isDirectory()).toBe(true);
  });

  it('no history query retains the prior response shape', async () => {
    const r = await call(apiFor(home()), 'GET', PATH);
    expect(r.body).toEqual({ recheck: VERDICT });
  });

  it('preserves 400/405 and writes nothing on any path', async () => {
    const h = home();
    const api = apiFor(h);
    expect((await call(api, 'GET', `${PATH}?history=0`)).status).toBe(400);
    expect((await call(api, 'POST')).status).toBe(405);
    expect(existsSync(join(h, 'fleet'))).toBe(false);
  });
});
