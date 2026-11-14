import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { VERSE_FLEET_RUNTIME_IDENTITY_PATH, createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const identity = (over: Partial<RuntimeIdentity> = {}): RuntimeIdentity => ({
  host: 'studio', platform: 'darwin', asOf: '2026-11-13T00:00:00.000Z', installedVersion: '1.2.3', sourceVersion: '1.2.3',
  versionDrift: false, fleetState: { path: '~/.ashlr/guardian/state.json', mtime: '2026-11-13T00:00:00.000Z', ageSeconds: 5, stale: false },
  tailnetName: 'studio', reasons: [], ...over,
});
async function call(api: ApiModule, method = 'GET', path = VERSE_FLEET_RUNTIME_IDENTITY_PATH) {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

it('returns v:1 with the identity, redacting a home path and an IPv4', async () => {
  const api = createFleetRuntimeIdentityApi({
    identity: () => identity({ host: 'studio', tailnetName: '100.64.1.2', reasons: [`bad ${homedir()}/x`] }),
    now: () => 1_700_000_000_000,
  });
  const { handled, status, body, text } = await call(api);
  expect(handled).toBe(true);
  expect(status).toBe(200);
  expect(body).toMatchObject({ v: 1, generatedAt: new Date(1_700_000_000_000).toISOString(), identity: { host: 'studio', platform: 'darwin' } });
  expect(body.identity.tailnetName).toBe('[ip]');
  expect(body.identity.reasons[0]).toBe('bad ~/x');
  expect(text).not.toContain(homedir());
  expect(text).not.toContain('100.64.1.2');
});

it('caches for 30 seconds then reads again', async () => {
  let time = 1_000;
  const identityFn = vi.fn(() => identity());
  const api = createFleetRuntimeIdentityApi({ identity: identityFn, now: () => time });
  await call(api);
  time += 29_999;
  await call(api);
  expect(identityFn).toHaveBeenCalledTimes(1);
  time += 1;
  await call(api);
  expect(identityFn).toHaveBeenCalledTimes(2);
});

it('answers 200 with identity null when the read throws, without leaking detail', async () => {
  const api = createFleetRuntimeIdentityApi({ identity: () => { throw new Error('boom at /Users/someone/secret'); }, now: () => 1 });
  const { status, body, text } = await call(api);
  expect(status).toBe(200);
  expect(body).toMatchObject({ v: 1, identity: null, reasons: ['read failed'] });
  expect(text).not.toContain('/Users/');
  expect(text).not.toContain('Error');
});

it('rejects other methods with 405 and ignores other paths', async () => {
  const identityFn = vi.fn(() => identity());
  const api = createFleetRuntimeIdentityApi({ identity: identityFn });
  expect(await call(api, 'POST')).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
  expect((await call(api, 'GET', '/api/verse/fleet/other')).handled).toBe(false);
  expect(identityFn).not.toHaveBeenCalled();
});
