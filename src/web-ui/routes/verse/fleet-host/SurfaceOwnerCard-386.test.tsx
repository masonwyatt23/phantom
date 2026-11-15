import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { FleetHostPane } from './FleetHostPane.js';
import { SurfaceOwnerCard } from './SurfaceOwnerCard.js';
import { surfaceOwnerRows, type SurfaceOwnersResponse } from './surface-owner-query.js';

const claim = { id: 'claim-fake-1', agent: 'agent-fake-1', expiresInSeconds: 600 };
const surface: SurfaceOwnersResponse['surfaces'][number] = {
  surface: 'dot-handoff', owner: 'agent-fake-1', ownerSource: 'advisory-claim', liveClaims: [claim],
  lastLanded: { jobId: 'RQ-PHX-FAKEJOB1', pr: 123, date: '2026-11-14T12:00:00Z', path: 'fake/history.jsonl' },
  asOf: '2026-11-14T12:00:00Z', reasons: [],
};
const payload = { v: 1, authority: 'none', generatedAt: surface.asOf, surfaces: [surface] };
const rowsFor = (overrides: Record<string, unknown> = {}) => surfaceOwnerRows({ ...payload, surfaces: [{ ...surface, ...overrides }] });

beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows one advisory claim, its expiry and the last landed job', () => {
  expect(rowsFor().rows[0]).toEqual({
    surface: 'dot-handoff', ownerText: 'agent-fake-1 · expires in 10m', tone: 'ok',
    landedText: 'last landed RQ-PHX-FAKEJOB1 #123 2026-11-14',
  });
  expect(rowsFor({ liveClaims: [{ ...claim, expiresInSeconds: 7200 }] }).rows[0]?.ownerText).toBe('agent-fake-1 · expires in 2h');
});

it('shows no live owner with the first reason and no landed history', () => {
  expect(rowsFor({ owner: 'none', ownerSource: 'none', liveClaims: [], reasons: ['no matching claim', 'later reason'], lastLanded: null }).rows[0]).toEqual({
    surface: 'dot-handoff', ownerText: 'no live owner (no matching claim)', tone: 'unknown', landedText: 'no landed history',
  });
});

it('warns when two live claims contest the surface', () => {
  expect(rowsFor({ liveClaims: [claim, { ...claim, id: 'claim-fake-2' }] }).rows[0]).toMatchObject({ ownerText: '2 live claims (contested)', tone: 'warn' });
});

it('does not invent a PR number when the last landed PR is unknown', () => {
  expect(rowsFor({ lastLanded: { ...surface.lastLanded, pr: null } }).rows[0]?.landedText).toBe('last landed RQ-PHX-FAKEJOB1 2026-11-14');
});

it.each([
  { owner: 7 }, { liveClaims: 'wrong' }, { liveClaims: [null] },
  { liveClaims: [{ ...claim, agent: 7 }] }, { liveClaims: [{ ...claim, expiresInSeconds: '600' }] },
  { liveClaims: [{ ...claim, expiresInSeconds: -1 }] }, { ownerSource: 'wrong' },
])('keeps malformed ownership unknown: %j', (overrides) => {
  expect(rowsFor(overrides).rows[0]).toMatchObject({ ownerText: 'unknown', tone: 'unknown' });
});

it.each([null, 7, {}, { surfaces: null }, { surfaces: [null, 7, {}] }])('handles malformed responses without throwing: %j', (resp) => {
  const result = surfaceOwnerRows(resp);
  expect(JSON.stringify(result)).toContain('unknown');
  expect(JSON.stringify(result)).not.toContain('no live owner');
});

it('distinguishes loading, a missing route and a failed read, including failed refreshes', () => {
  expect(surfaceOwnerRows(undefined).note).toBe('Owners: reading…');
  expect(surfaceOwnerRows(undefined, new ApiError('missing', 404, '/fake')).note).toBe('Owners: not served by this build');
  expect(surfaceOwnerRows(undefined, new Error('fake')).note).toBe('Owners: read failed (The request failed.)');
  expect(surfaceOwnerRows(payload, new TypeError('fake'))).toEqual({ rows: [], note: 'Owners: read failed (The server did not answer.)' });
});

it('renders the dot-handoff owner from the surface-owner route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
  await act(async () => { render(<SurfaceOwnerCard visible />); });
  const section = screen.getByRole('region', { name: 'Owners' });
  expect(within(section).getByText('agent-fake-1 · expires in 10m')).toBeInTheDocument();
  expect(within(section).getByText('dot-handoff').nextElementSibling).toHaveTextContent('agent-fake-1');
  expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/runtime-identity/surface-owner', expect.objectContaining({ method: 'GET' }));
});

it('renders the Owners section in FleetHostPane', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/verse/fleet/runtime-identity/surface-owner') return Response.json(payload);
    if (String(input) === '/api/verse/fleet/runs') return Response.json({
      v: 1, generatedAt: surface.asOf,
      sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
      lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, claudeLane: null,
      orchestratorAgents: null, codexPersonal: null, drop: null, lanes: [], workers: [], leaders: [],
      switches: [], publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], inbox: [],
    });
    return Response.json({}, { status: 404 });
  }));
  render(<FleetHostPane visible />);
  const section = await screen.findByRole('region', { name: 'Owners' });
  expect(await within(section).findByText('agent-fake-1 · expires in 10m')).toBeInTheDocument();
});

it('polls at 30 seconds and stops when hidden', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
  const view = render(<SurfaceOwnerCard visible />);
  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<SurfaceOwnerCard visible={false} />);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
});
