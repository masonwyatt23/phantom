import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { BridgeCheckCard } from './BridgeCheckCard.js';
import { bridgeCheckHeadline, parseBridgeCheck } from './bridge-check-model.js';

const env = (check: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', check: { verdict: 'READY', asOf: '2026-11-15T12:00:00Z', missing: [], ...check }, ...over,
});
const ready = () => env({
  runtime: { status: 'ok', asOf: '2026-11-15T12:00:00Z' },
  claims: { status: 'ok', state: 'known', live: 3, newestAgeSec: 10 },
  peers: { status: 'ok' },
});
const blocked = () => env({
  verdict: 'BLOCKED', missing: ['runtime.fleet-state-stale', 'claims'],
  runtime: { status: 'ok', reason: 'fleet-state-stale', asOf: '2026-11-15T12:00:00Z' },
  claims: { status: 'unavailable', state: 'unknown', live: null, newestAgeSec: null },
});

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('model: READY', () => {
  expect(bridgeCheckHeadline(parseBridgeCheck(ready()))).toEqual({ text: 'Bridge: READY · 3 live claims', tone: 'ok' });
});
it('model: BLOCKED names both missing parts', () => {
  expect(bridgeCheckHeadline(parseBridgeCheck(blocked()))).toEqual({
    text: 'Bridge: BLOCKED · missing runtime.fleet-state-stale, claims', tone: 'danger',
  });
});
it('model: READY verdict with missing parts is never READY', () => {
  const h = bridgeCheckHeadline(parseBridgeCheck(env({ missing: ['peers'] })));
  expect(h.text).toBe('Bridge: BLOCKED · missing peers');
  expect(h.tone).toBe('danger');
});
it('model: invalid authority, version, verdict and asOf', () => {
  for (const bad of [env({}, { authority: 'dispatch' }), env({}, { v: 2 }), env({ verdict: 'MAYBE' }), env({ asOf: 'nope' }), null, 'x']) {
    const parsed = parseBridgeCheck(bad);
    expect(parsed).toEqual({ kind: 'invalid' });
    expect(bridgeCheckHeadline(parsed)).toEqual({ text: 'Bridge: unknown (invalid response)', tone: 'unknown' });
  }
});
it('model: caps missing at 16 entries of 64 chars', () => {
  const parsed = parseBridgeCheck(env({ verdict: 'BLOCKED', missing: Array.from({ length: 40 }, () => 'x'.repeat(100)) }));
  expect(parsed.kind === 'ok' && parsed.missing.length).toBe(16);
  expect(parsed.kind === 'ok' && parsed.missing.every(m => m.length === 64)).toBe(true);
});
it('model: strips control characters from missing names', () => {
  const parsed = parseBridgeCheck(env({ verdict: 'BLOCKED', missing: ['run\u0000time\u001b[31m\n'] }));
  expect(parsed.kind === 'ok' && parsed.missing).toEqual(['runtime[31m']);
});

const serve = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

it('card: READY', async () => {
  serve(200, ready());
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText(/Bridge: READY · 3 live claims/)).toBeTruthy();
  expect(screen.getByText('claims: ok · 3 live')).toBeTruthy();
});
it('card: BLOCKED names missing parts', async () => {
  serve(200, blocked());
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText(/Bridge: BLOCKED · missing runtime\.fleet-state-stale, claims/)).toBeTruthy();
  expect(screen.getByText('runtime: ok · fleet-state-stale')).toBeTruthy();
});
it('card: 404 stays visible', async () => {
  serve(404, {});
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText('Bridge check: not served by this build (update Phantom)')).toBeTruthy();
});
it('card: read error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText('Bridge check unknown: read failed')).toBeTruthy();
});
