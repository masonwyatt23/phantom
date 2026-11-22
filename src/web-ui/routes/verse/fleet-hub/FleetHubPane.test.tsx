import type { FleetHealth, HealthDetail } from '../../../../core/fleet/health.js';
import { renderMobile, stubFetch } from '../mobile/mobile.test-support.js';
import { mockViewport } from '../shell/viewport.test-support.js';
import { HomeGlance } from '../mobile/screens/HomeGlance.js';
import { FleetScreen } from '../mobile/screens/FleetScreen.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { getDockState, resetDockStore, subscribeDockState } from '../dock/dock-store.js';
import { registerPane } from '../panes/pane-registry.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHubPane } from './FleetHubPane.js';
import '../fleet-lanes/fleet-lanes.pane.js';
import '../fleet-events/fleet-events.pane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: true, heldReason: 'Budget hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: Array.from({ length: 13 }, (_, i) => ({ job: `job-${i}`, repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: i })),
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [{ repo: 'example/repo', number: 12, title: 'Fleet view' }, { repo: 'unknown', number: 13, title: 'No owner' }] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => {
  localStorage.clear(); resetDockStore(); evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('opens a tile and lays out only registered fleet panes with one store update', async () => {
  render(<FleetHubPane visible />);
  await screen.findByText('1/2 · 1 held');
  fireEvent.click(screen.getByText('Lanes'));
  expect(getDockState().active).toBe('fleet-lanes');
  const listener = vi.fn();
  const unsubscribe = subscribeDockState(listener);
  fireEvent.click(screen.getByRole('button', { name: 'Open all fleet panes' }));
  expect(getDockState()).toMatchObject({ open: true, active: 'fleet-lanes', splitWith: 'fleet-events', tabs: ['fleet-lanes', 'fleet-events'] });
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  expect(screen.getByText('Inbox').closest('button')).toBeDisabled();
});

it('reacts to late registrations and uses the registered title', async () => {
  render(<FleetHubPane visible />);
  await screen.findByText('1/2 · 1 held');
  let unregister = () => {};
  act(() => { unregister = registerPane({ id: 'fleet-inbox', title: 'Fleet inbox', needsSession: false, icon: () => null, component: () => null }); });
  fireEvent.click(screen.getByRole('button', { name: 'Fleet inbox 0' }));
  expect(getDockState().active).toBe('fleet-inbox');
  act(() => unregister());
  expect(screen.getByText('Inbox').closest('button')).toBeDisabled();
});

it('refreshes counts while visible and stops polling when hidden', async () => {
  vi.useFakeTimers();
  const view = render(<FleetHubPane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(5_000); });
  const runsCalls = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/fleet/runs'));
  expect(runsCalls()).toHaveLength(2);
  view.rerender(<FleetHubPane visible={false} />);
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(runsCalls()).toHaveLength(2);
});

it('shows Not actually running immediately after health, only when the list is not empty', async () => {
  const view = render(<FleetHubPane visible />);
  await screen.findByText('1/2 · 1 held');
  expect(screen.queryByRole('region', { name: 'Not actually running' })).toBeNull();
  view.unmount(); evictAll();
  const notRunning = [
    { job_or_lane: 'grok-one', kind: 'held_launch' as const, reason: 'ultra reading older than 8h', since: new Date(Date.now() - 3 * 86_400_000).toISOString(), unblock: 'Record a current Grok usage percent' },
    { job_or_lane: 'cursor', kind: 'idle_lane' as const, reason: 'Lane held', since: null, unblock: 'unknown' },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...fixture, notRunning })));
  render(<FleetHubPane visible />);
  const group = await screen.findByRole('region', { name: 'Not actually running' });
  expect(group.parentElement?.firstElementChild).toBe(screen.getByRole('region', { name: 'Fleet health summary' }));
  expect(group.previousElementSibling).toHaveAttribute('aria-label', 'Fleet health summary');
  expect(group.textContent).toContain('Not actually running · 2');
  expect(group.textContent).toContain('grok-one · ultra reading older than 8h · for 3 d');
  expect(group.textContent).toContain('Next: Record a current Grok usage percent');
  expect(group.textContent).toContain('cursor · Lane heldNext: unknown');
});

const ids: HealthDetail[] = ['main', 'merges', 'pools', 'families', 'releases'];
const report: FleetHealth = { schema: 'fleet.health.v1', asOf: '2026-11-22T19:00:00Z', lines: ids.map(id => ({ id, text: `${id}: fixture answer.` })) };
afterEach(() => { evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('renders five wrapping answers at phone width and each opens its existing detail card', async () => {
  const viewport = mockViewport(390), opened: string[] = [];
  stubFetch({ 'GET /api/verse/fleet/health': report });
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { opened.push(this.id); });
  const { container } = renderMobile(<div style={{ width: 390 }}><FleetScreen /></div>);
  const summary = within(await screen.findByRole('region', { name: 'Fleet health summary' }));
  await summary.findByRole('button', { name: 'main: fixture answer.' });
  expect(summary.getAllByRole('listitem')).toHaveLength(5);
  for (const id of ids) { fireEvent.click(summary.getByRole('button', { name: `${id}: fixture answer.` })); expect(container.querySelector(`#health-${id}`)).toBeInTheDocument(); }
  expect(opened).toEqual(ids.map(id => `health-${id}`));
  expect(container.firstElementChild).toHaveStyle({ width: '390px' }); viewport.restore();
});
it('offers Fleet health in one tap from Home even before Home has loaded', () => {
  stubFetch({}); const { context } = renderMobile(<HomeGlance />);
  fireEvent.click(screen.getByRole('button', { name: 'Fleet health' })); expect(context.navigate).toHaveBeenCalledWith({ screen: 'fleet' });
});
it('shows the identical five answers first in desktop Fleet', async () => {
  stubFetch({ 'GET /api/verse/fleet/health': report }); renderMobile(<FleetHubPane visible />);
  const summary = await screen.findByRole('region', { name: 'Fleet health summary' });
  expect(await within(summary).findByRole('button', { name: 'main: fixture answer.' })).toBeInTheDocument();
  expect(within(summary).getAllByRole('button').map(button => button.textContent)).toEqual(report.lines.map(line => line.text));
});
it('retains five useful paths when the report fails', async () => {
  stubFetch({}); renderMobile(<FleetScreen />);
  const summary = within(await screen.findByRole('region', { name: 'Fleet health summary' }));
  await summary.findByRole('button', { name: /Main: unknown, because the health report could not be refreshed/ });
  expect(summary.getAllByRole('button')).toHaveLength(5);
});
