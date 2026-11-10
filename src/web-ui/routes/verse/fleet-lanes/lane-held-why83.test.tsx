import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetLanesPane } from './FleetLanesPane.js';

const UNTIL = '2099-01-01T00:00:00Z';
const SLOTS_REASON = 'autobackoff fake job=RQ-FAKE-1 until=2099-01-01T00:00:00Z src=fake';
const CREDITS_REASON = 'credits exhausted (fake-window 2026-11-10 01:23)';
const UNTIL_TEXT = `until ${new Date(UNTIL).toLocaleString()}`;

const lane = (name: string, held: boolean, heldReason: string | null) =>
  ({ lane: name, running: 0, target: 2, queued: 1, held, heldReason, tokensLastHour: null, merged24h: null, mergeRate24h: null });

const runs: FleetRuns = {
  v: 1, generatedAt: '2026-11-10T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [lane('devin', true, 'usage_limit'), lane('codex-cmp', true, null), lane('gemini', true, null), lane('zai', false, null)],
  workers: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

const targetRow = (name: string, held: boolean, heldReason: string | null, heldUntil: string | null) =>
  ({ lane: name, target: 2, floor: 0, ceiling: 10, held, heldReason, heldUntil, lastChange: null, changedBy: null });
const targets = {
  v: 1, generatedAt: '2026-11-10T12:00:00Z', sourceState: 'healthy',
  lanes: [
    targetRow('devin', true, SLOTS_REASON, UNTIL),
    targetRow('codex-cmp', true, CREDITS_REASON, null),
    targetRow('gemini', true, null, null),
    targetRow('zai', false, null, null),
  ],
};

const serve = (runsBody: unknown, targetsBody: unknown = targets) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/control/lanes') ? targetsBody : runsBody)));
const laneItem = async (name: string) => (await screen.findByText(name, { selector: 'strong' })).closest('li')!;

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows the verbatim held reason and the recorded lift time for a held lane', async () => {
  serve(runs); render(<FleetLanesPane visible />);
  const item = await within(await laneItem('devin')).findByText(`Held: ${SLOTS_REASON} · ${UNTIL_TEXT}`);
  expect(item).toHaveAttribute('title', SLOTS_REASON);
});

it('shows no lift time recorded for a held lane whose state row has no held_until', async () => {
  serve(runs); render(<FleetLanesPane visible />);
  await within(await laneItem('codex-cmp')).findByText(`Held: ${CREDITS_REASON} · no lift time recorded`);
});

it('shows Held and no lift time recorded for a held lane with no reason and no until', async () => {
  serve(runs); render(<FleetLanesPane visible />);
  const item = await within(await laneItem('gemini')).findByTestId('lane-held-line');
  expect(item).toHaveTextContent(/^Held/);
  expect(item).toHaveTextContent('no lift time recorded');
});

it('renders no held text for an unheld lane', async () => {
  serve(runs); render(<FleetLanesPane visible />);
  const item = within(await laneItem('zai'));
  expect(item.queryByTestId('lane-held-line')).toBeNull();
  expect(item.queryByText(/no lift time recorded|until /)).toBeNull();
});

it('shortens a long held reason to 80 chars and keeps the full text in the tooltip', async () => {
  const long = 'r'.repeat(120);
  serve({ ...runs, lanes: [lane('devin', true, 'usage_limit')] },
    { ...targets, lanes: [targetRow('devin', true, long, UNTIL)] });
  render(<FleetLanesPane visible />);
  const item = await within(await laneItem('devin')).findByText(`Held: ${'r'.repeat(79)}… · ${UNTIL_TEXT}`);
  expect(item).toHaveAttribute('title', long);
});
