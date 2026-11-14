/** RQ-PHX-ORDERSTRIPEVIDENCE362 — evidence source per row and source-health notes. Fake ids only. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { OrderStateStrip } from './OrderStateStrip.js';

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const mk = (over: Record<string, unknown> = {}) => ({
  at: '2026-11-13T17:13:00.000Z', source: 'slack', key: 'order-fake-1', state: 'RUNNING',
  asOf: '2026-11-13T17:14:00.000Z', evidenceSource: 'ledger', missing: [], pr: null, ...over,
});
const body = (extra: Record<string, unknown> = {}, orders: unknown[] = [mk()]) =>
  ({ v: 1, asOf: '2026-11-13T17:15:00.000Z', sources: {}, orders, ...extra });
const show = async (b: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(b), { status: 200 })));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your orders' })).toBeInTheDocument());
  await screen.findAllByText('RUNNING');
};

it('notes degraded sources only', async () => {
  await show(body({ sources: { inbox: 'healthy', prompts: 'degraded' } }));
  expect(screen.getByText('sources degraded: prompts=degraded')).toBeInTheDocument();
});

it('says nothing when all sources are healthy', async () => {
  await show(body({ sources: { inbox: 'healthy' } }));
  expect(screen.queryByText(/not checked|degraded/)).toBeNull();
});

it('notes RUNNING not checked when live is unavailable, nothing when absent', async () => {
  await show(body({ live: 'unavailable' }));
  expect(screen.getByText('RUNNING not checked')).toBeInTheDocument();
  cleanup(); evictAll();
  await show(body());
  expect(screen.queryByText(/not checked/)).toBeNull();
});

it('notes BLOCKED not checked when queue is unavailable', async () => {
  await show(body({ queue: 'unavailable' }));
  expect(screen.getByText('BLOCKED not checked')).toBeInTheDocument();
  expect(screen.queryByText('RUNNING not checked')).toBeNull();
});

it('renders the evidence source, unknown when empty', async () => {
  await show(body({}, [mk({ evidenceSource: 'live-worker RQ-PHX-X1' }), mk({ key: 'order-fake-2', evidenceSource: '  ' })]));
  expect(screen.getByText('live-worker RQ-PHX-X1')).toBeInTheDocument();
  expect(screen.getByText('unknown')).toBeInTheDocument();
});

it('cuts a 200-char evidence source to 60', async () => {
  await show(body({}, [mk({ evidenceSource: 'a'.repeat(200) })]));
  expect(screen.getByText('a'.repeat(60))).toBeInTheDocument();
  expect(screen.queryByText('a'.repeat(61))).toBeNull();
});
