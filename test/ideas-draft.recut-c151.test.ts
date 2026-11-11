import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { handleIdeasDraftApi } from '../src/core/web/ideas-draft-route.js';

it('gates the HTTP draft and writes only after an authenticated request', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'ideas-recut-'));
  try {
    const call = async (token: string) => {
      const req = Object.assign(Readable.from([JSON.stringify({ ideaIds: ['idea-1'] })]), {
        headers: { 'x-ashlr-token': token, 'content-type': 'application/json' },
      }) as IncomingMessage;
      let status = 0;
      let body = '';
      const res = {
        writeHead(code: number) { status = code; return this; },
        end(data: string) { body = data; return this; },
      } as unknown as ServerResponse;
      await handleIdeasDraftApi({ token: 'test-token', allowDispatch: true }, req, res, 'POST', {
        runsDir,
        backlog: () => ({ items: [{ id: 'idea-1', title: 'Repair parser', repo: 'phantom', source: 'issue', detail: 'Fix parser', score: 1 }] } as never),
        readQueuedClaims: async () => ({ sourceState: 'missing', claims: new Map() }),
      });
      return { status, body: JSON.parse(body) as { written?: boolean } };
    };
    expect((await call('wrong-token')).status).toBe(401);
    expect(await readdir(runsDir)).toEqual([]);
    expect(await call('test-token')).toMatchObject({ status: 200, body: { written: true } });
    expect(await call('test-token')).toMatchObject({ status: 200, body: { written: false } });
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});
