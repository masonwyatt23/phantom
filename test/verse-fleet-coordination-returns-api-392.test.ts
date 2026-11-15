import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { createFleetCoordinationClaimsApi } from '../src/core/verse/fleet-coordination-claims-api.js';
import {
  createFleetCoordinationReturnsApi, VERSE_FLEET_COORDINATION_RETURNS_PATH as PATH,
} from '../src/core/verse/fleet-coordination-returns-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'returns-api-392-'));
  dirs.push(dir);
  const options = { path: join(dir, 'board.jsonl'), now: NOW.getTime() - 2000 };
  for (const evidence of [{ pr: 392, head: 'abc1234' }, { blocked: 'fake upstream dependency' }]) {
    const claimed = claimFleetWork({ repo: 'example/fake-repo', task: 'Fake fixture task', agent: 'fake-agent' }, options);
    if (!claimed.ok) throw new Error('fixture claim failed');
    expect(returnFleetClaim({ id: claimed.value.claim.id, agent: 'fake-agent', lease: claimed.value.lease, ...evidence }, options).outcome).toBe('returned');
    options.now += 1000;
  }
  return readFleetBoard(options);
}

async function call(api: ApiModule, method = 'GET', url = PATH, path = PATH) {
  let status = 0;
  let text = '';
  const req = { url } as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, req, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet coordination returns API', () => {
  it('returns VERIFIED PR/head and BLOCKED dependency receipts newest first without changing the board', async () => {
    const board = fixture();
    const before = JSON.stringify(board);
    const result = await call(createFleetCoordinationReturnsApi({ read: () => board, now: () => NOW }));
    expect(result).toMatchObject({ handled: true, status: 200, body: {
      v: 1, authority: 'none', generatedAt: NOW.toISOString(), asOf: NOW.toISOString(), state: 'known', unparsed: 0,
    } });
    expect(result.body.returns).toEqual([
      expect.objectContaining({ result: 'BLOCKED', evidenceKind: 'dependency', evidence: 'dependency fake upstream dependency', pr: null, head: null,
        at: new Date(NOW.getTime() - 1000).toISOString() }),
      expect.objectContaining({ result: 'VERIFIED', evidenceKind: 'pr', repo: 'example/fake-repo', from: 'fake-agent', pr: 392, head: 'abc1234',
        at: new Date(NOW.getTime() - 2000).toISOString() }),
    ]);
    expect(JSON.stringify(board)).toBe(before);
    expect(result.text).not.toMatch(/lease|proposals|messages/);
  });

  it('projects a fixed unknown result when the reader throws, without leaking error text', async () => {
    const result = await call(createFleetCoordinationReturnsApi({ read: () => { throw new Error('fake private reader detail'); }, now: () => NOW }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ state: 'unknown', returns: [], reason: 'coordination ledger: reader failed' });
    expect(result.text).not.toContain('fake private reader detail');
  });

  it('rejects POST and any query before reading and ignores unrelated paths', async () => {
    const read = vi.fn(() => fixture());
    const api = createFleetCoordinationReturnsApi({ read, now: () => NOW });
    expect(await call(api, 'POST')).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    for (const query of ['?x=1', '?root=/fake', '?cwd=/fake', '?path=/fake', '?x=1&x=2']) {
      expect(await call(api, 'GET', PATH + query)).toMatchObject({ handled: true, status: 400,
        body: { v: 1, authority: 'none', error: 'no query accepted' } });
    }
    expect((await call(api, 'GET', '/api/verse/fleet/other', '/api/verse/fleet/other')).handled).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('chains the returns path through the claims module to the injected handler', async () => {
    const returns = vi.fn(createFleetCoordinationReturnsApi({ read: () => fixture(), now: () => NOW }));
    const read = vi.fn(() => fixture());
    const mutate = vi.fn<ApiModule>();
    const result = await call(createFleetCoordinationClaimsApi({ returns, read, mutate }));
    expect(result).toMatchObject({ handled: true, status: 200, body: { state: 'known' } });
    expect(result.body.returns).toHaveLength(2);
    expect(returns).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ url: PATH }), expect.anything(), PATH, 'GET');
    expect(read).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
