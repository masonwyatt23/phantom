/**
 * ~/.ashlr/ui.json: schema coercion, the file round trip (UI write -> agent
 * read, agent hand-edit -> UI read) and the HTTP gates.
 *
 * The HTTP cases boot the real server (test/helpers/authenticated-web-server)
 * because the production mount lives in src/core/web/server.ts, outside
 * handleApi — that also exercises the read-session boundary. No raw binds in
 * this file, so it stays in the fast unit lane.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AshlrConfig, WebServerHandle } from '../src/core/types.js';
import {
  defaultUiSettings,
  normalizeUiSettings,
  readUiSettings,
  uiSettingsPath,
  writeUiSettings,
} from '../src/core/ui-settings.js';
import { startServer } from './helpers/authenticated-web-server.js';

let home: string;
let realHome: string | undefined;
beforeEach(() => {
  realHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'ui-settings-'));
  process.env['HOME'] = home;
});
afterEach(() => {
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe('normalizeUiSettings', () => {
  it('returns defaults for nothing and flags a non-object document', () => {
    expect(normalizeUiSettings(undefined)).toEqual({ settings: defaultUiSettings(), problems: [] });
    expect(normalizeUiSettings([]).problems).toEqual(['document must be a JSON object']);
  });

  it('clamps numbers, wraps hue, and drops (and reports) unknown or wrong-typed fields', () => {
    const { settings, problems } = normalizeUiSettings({
      appearance: { accentH: -10, accentL: 5, theme: 'neon', density: 'compact', bogus: 1 },
      layout: { sidebarWidth: 9999, resourcesOpen: 'yes', railExpanded: true },
      extra: {},
    });
    expect(settings.appearance).toMatchObject({ accentH: 350, accentL: 30, theme: 'system', density: 'compact' });
    expect(settings.layout).toMatchObject({ sidebarWidth: 360, resourcesOpen: true, railExpanded: true });
    expect(problems.sort()).toEqual([
      'invalid value for "appearance.theme"',
      'invalid value for "layout.resourcesOpen"',
      'unknown group "extra"',
      'unknown setting "appearance.bogus"',
    ]);
  });
});

describe('file round trip', () => {
  it('reads defaults when the file is absent, under the relocated HOME', () => {
    const read = readUiSettings();
    expect(read).toMatchObject({ exists: false, parsed: true, path: join(home, '.ashlr', 'ui.json') });
    expect(read.settings).toEqual(defaultUiSettings());
  });

  it('a UI write is visible to a reader and rewrites the whole file, no temp files left', () => {
    writeUiSettings({ appearance: { theme: 'dark' } });
    writeUiSettings({ layout: { sidebarWidth: 300 } });
    const onDisk = JSON.parse(readFileSync(uiSettingsPath(), 'utf8'));
    expect(onDisk.appearance.theme).toBe('dark'); // second write merged, not replaced
    expect(onDisk.layout.sidebarWidth).toBe(300);
    expect(onDisk.appearance.accentH).toBe(245); // complete document
    expect(readdirSync(join(home, '.ashlr'))).toEqual(['ui.json']);
  });

  it('an agent hand-edit is what the next read returns, with feedback on its mistakes', () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(uiSettingsPath(), JSON.stringify({ layout: { resourcesOpen: false, sidebarWidth: 1 }, nope: 1 }));
    const read = readUiSettings();
    expect(read.settings.layout).toMatchObject({ resourcesOpen: false, sidebarWidth: 240 });
    expect(read.problems).toEqual(['unknown group "nope"']);
  });

  it('survives a corrupt file: defaults on read, replaced by the next valid write', () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(uiSettingsPath(), '{ not json');
    expect(readUiSettings()).toMatchObject({ exists: true, parsed: false, settings: defaultUiSettings() });
    writeUiSettings({ appearance: { density: 'compact' } });
    expect(readUiSettings()).toMatchObject({ parsed: true, settings: { appearance: { density: 'compact' } } });
  });
});

// RQ-PHX-RECUTDESKS0C189 additions: the route wired through the real server
// mount (not just the handler), merge-not-replace writes, the 16 KiB body
// limit and the normalizer's wrap/merge edge cases.
describe('normalizeUiSettings recut edge cases', () => {
  it('wraps accent hue in both directions and merges a patch over a non-default base', () => {
    const base = defaultUiSettings();
    base.appearance['theme'] = 'dark';
    base.layout['sidebarWidth'] = 300;
    const { settings, problems } = normalizeUiSettings({ appearance: { accentH: 370 }, layout: { railExpanded: true } }, base);
    expect(settings.appearance['accentH']).toBe(10);
    expect(settings.appearance['theme']).toBe('dark'); // kept from base, not reset
    expect(settings.layout).toMatchObject({ sidebarWidth: 300, railExpanded: true });
    expect(problems).toEqual([]);
    const neg = normalizeUiSettings({ appearance: { accentH: -370 } });
    expect(neg.settings.appearance['accentH']).toBe(350);
  });

  it('reports a non-object group without touching other groups', () => {
    const { settings, problems } = normalizeUiSettings({ appearance: 'dark', layout: { resourcesOpen: false } });
    expect(problems).toEqual(['"appearance" must be an object']);
    expect(settings.appearance).toEqual(defaultUiSettings().appearance);
    expect(settings.layout['resourcesOpen']).toBe(false);
  });
});

describe('/api/ui-settings on the mounted server', () => {
  let handle: WebServerHandle;
  const start = async (allowDispatch: boolean) => {
    // The production mount lives in src/core/web/server.ts so the settings
    // modules stay out of the Tier-1 authority import closure. Booting the
    // real pipeline also exercises the host-header and read-session boundary.
    handle = await startServer({} as AshlrConfig, { port: 0, open: false, allowDispatch });
    return handle.url;
  };
  afterEach(async () => { await handle?.close(); });

  const get = (url: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/ui-settings`, { headers });
  const put = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/ui-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('GET is read-gated; PUT needs --allow-dispatch, then the mutation token', async () => {
    const url = await start(true);
    expect((await get(url)).status).toBe(401);
    const fresh = await (await get(url, { 'x-ashlr-token': handle.readToken })).json();
    expect(fresh.exists).toBe(false);
    expect((await put(url, { appearance: { theme: 'dark' } })).status).toBe(401);
    expect((await put(url, { appearance: { theme: 'dark' } }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect(readUiSettings().exists).toBe(false);

    const ok = await put(url, { appearance: { theme: 'dark', accentL: 99 }, bogus: {} }, { 'x-ashlr-token': handle.token });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.settings.appearance).toMatchObject({ theme: 'dark', accentL: 78 });
    expect(body.problems).toEqual(['unknown group "bogus"']);
    expect((await (await get(url, { 'x-ashlr-token': handle.readToken })).json()).settings.appearance.theme).toBe('dark');

    await handle.close();
    const ro = await start(false);
    expect((await put(ro, { appearance: { theme: 'dark' } }, { 'x-ashlr-token': handle.token })).status).toBe(404);
    expect((await get(ro, { 'x-ashlr-token': handle.readToken })).status).toBe(200);
  });

  it('PUT merges into the file instead of replacing it, end to end', async () => {
    const url = await start(true);
    const first = await put(url, { appearance: { theme: 'dark' } }, { 'x-ashlr-token': handle.token });
    expect(first.status).toBe(200);
    const second = await put(url, { layout: { sidebarWidth: 300 } }, { 'x-ashlr-token': handle.token });
    expect(second.status).toBe(200);
    const doc = JSON.parse(readFileSync(uiSettingsPath(), 'utf8'));
    expect(doc.appearance.theme).toBe('dark');
    expect(doc.layout.sidebarWidth).toBe(300);
    const read = await (await get(url, { 'x-ashlr-token': handle.readToken })).json();
    expect(read.settings.appearance.theme).toBe('dark');
  });

  it('rejects a malformed body (400), a non-JSON content type (415), an oversized body (400) and other methods (405)', async () => {
    const url = await start(true);
    const bad = await fetch(`${url}/api/ui-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ashlr-token': handle.token },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const wrongType = await fetch(`${url}/api/ui-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'x-ashlr-token': handle.token },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);
    const oversized = await fetch(`${url}/api/ui-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ashlr-token': handle.token },
      body: `{"appearance":{"theme":"${'x'.repeat(20 * 1024)}"}}`,
    });
    expect(oversized.status).toBe(400);
    expect((await fetch(`${url}/api/ui-settings`, { method: 'DELETE' })).status).toBe(405);
  });

  it('a non-object JSON body is reported as a problem, never crashes the write', async () => {
    const url = await start(true);
    const res = await put(url, ['not', 'an', 'object'], { 'x-ashlr-token': handle.token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.problems).toContain('document must be a JSON object');
    expect(body.settings).toEqual(defaultUiSettings());
  });
});
