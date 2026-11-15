import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import * as lag from '../src/core/release/lag.js';
import { handleReleaseLagApi, RELEASE_LAG_PATH } from '../src/core/verse/release-lag-api.js';
import { handleApi } from '../src/core/web/api.js';

afterEach(() => vi.restoreAllMocks());

async function call(url = RELEASE_LAG_PATH, method = 'GET', wired = true) {
  let status = 0;
  let text = '';
  const req = { url, method, headers: {} } as IncomingMessage;
  const res = {
    writeHead(code: number) { status = code; },
    end(chunk: string) { text = chunk; },
  } as unknown as ServerResponse;
  const cfg = { version: 1, roots: [], telemetry: {}, tools: {}, models: { providerChain: [] } } as never;
  const handled = await handleApi(req, res, cfg, {
    token: 'test-only', allowDispatch: false,
    ...(wired ? { releaseLagApi: handleReleaseLagApi } : {}),
  });
  return { handled, status, body: JSON.parse(text) };
}

it('serves and caches release evidence through the injected HTTP handler', async () => {
  const fixture: lag.ReleaseLagV1 = {
    schema: lag.RELEASE_LAG_SCHEMA, checkedAt: '2026-11-14T00:00:00.000Z',
    latestTag: 'v9.9.9-test', assetCount: 7, feedOk: true,
    installedVersion: '9.9.8-test', mergedSince: 12,
  };
  const read = vi.spyOn(lag, 'readReleaseLag').mockResolvedValue(fixture);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  expect(await call()).toEqual({ handled: true, status: 200, body: fixture });
  expect(await call()).toEqual({ handled: true, status: 200, body: fixture });
  expect(read).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(1_060_001);
  await call();
  expect(read).toHaveBeenCalledTimes(2);
});

it('fails closed when the composition root has not supplied the display handler', async () => {
  expect(await call(RELEASE_LAG_PATH, 'GET', false)).toMatchObject({ handled: true, status: 503 });
});

it.each([
  [`${RELEASE_LAG_PATH}/extra`, 'GET', 404],
  [`${RELEASE_LAG_PATH}?refresh=1`, 'GET', 400],
  [RELEASE_LAG_PATH, 'POST', 404],
  [RELEASE_LAG_PATH, 'HEAD', 404],
])('rejects %s %s without reading release sources', async (url, method, status) => {
  const read = vi.spyOn(lag, 'readReleaseLag');
  expect(await call(url as string, method as string)).toMatchObject({ handled: true, status });
  expect(read).not.toHaveBeenCalled();
});
