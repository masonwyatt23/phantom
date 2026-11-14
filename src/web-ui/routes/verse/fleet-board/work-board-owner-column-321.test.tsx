/**
 * work-board-owner-column-321.test.tsx — RQ-PHX-BOARDOWNERCOLUMN321. Owner and
 * Claim columns plus the owner-count note in the Fleet Board work section.
 * Fake ids only; everything is asserted as plain text.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBoardPane } from './FleetBoardPane.js';

const PROPS = { visible: true } as PaneProps;
const NOW = Date.now();
const asOf = new Date(NOW).toISOString();
const RECEIPT = 'receipt-fake-0123456789abcdef-FEDCBA9876543210';

function item(id: string, extra: Record<string, unknown> = {}) {
  return { id, channel: 'telegram', channelRef: 'ref-1', receivedAt: asOf, state: 'ASSIGNED', asOf, source: 'bus', missing: [], ...extra };
}

function show(items: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/fleet/work-board')) {
      return new Response(JSON.stringify({ items, inbox: 'ok', truncated: false, asOf }), { status: 200 });
    }
    return new Response(JSON.stringify({ schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null }), { status: 200 });
  }));
  render(<FleetBoardPane {...PROPS} />);
}

const rowOf = (idPrefix: string) => screen.getAllByRole('row').find((r) => within(r).queryByText(idPrefix))!;

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows owner and the last 16 chars of the claim, full receipt in title', async () => {
  show([item('wi-fake-owned-0001', { owner: 'devin-fake-1', claimReceipt: RECEIPT })]);
  await waitFor(() => expect(screen.getByText('wi-fake-owne')).toBeInTheDocument());
  const row = rowOf('wi-fake-owne');
  expect(within(row).getByText('devin-fake-1')).toBeInTheDocument();
  const claim = within(row).getByText(RECEIPT.slice(-16));
  expect(claim).toHaveAttribute('title', RECEIPT);
  expect(screen.getByRole('columnheader', { name: 'Owner' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Claim' })).toBeInTheDocument();
});

it('shows unknown / none for a null owner and claim', async () => {
  show([item('wi-fake-null-0002', { owner: null, claimReceipt: null })]);
  await waitFor(() => expect(screen.getByText('wi-fake-null')).toBeInTheDocument());
  const row = rowOf('wi-fake-null');
  expect(within(row).getByText('unknown')).toBeInTheDocument();
  expect(within(row).getAllByText('none')).toHaveLength(1); // channelRef is 'ref-1', so the only 'none' is the claim
});

it('renders a legacy payload without owner/claim keys as unknown', async () => {
  show([item('wi-fake-legacy-03', { channelRef: null })]);
  await waitFor(() => expect(screen.getByText('wi-fake-lega')).toBeInTheDocument());
  const row = rowOf('wi-fake-lega');
  expect(within(row).getByText('unknown')).toBeInTheDocument();
  expect(within(row).getAllByText('none')).toHaveLength(2); // channelRef null + claim absent
  expect(screen.getByText('No item has a named owner yet')).toBeInTheDocument();
});

it('counts named owners for mixed items', async () => {
  show([
    item('wi-fake-a-0001', { owner: 'devin-fake-1' }),
    item('wi-fake-b-0002', { owner: null }),
    item('wi-fake-c-0003'),
  ]);
  await waitFor(() => expect(screen.getByText('1 of 3 items have a named owner')).toBeInTheDocument());
});

it('prints the zero-owner note when no item has an owner', async () => {
  show([item('wi-fake-a-0001', { owner: null }), item('wi-fake-b-0002', { owner: '' })]);
  await waitFor(() => expect(screen.getByText('No item has a named owner yet')).toBeInTheDocument());
  expect(screen.queryByText(/items have a named owner/)).not.toBeInTheDocument();
});

it('renders an owner containing <script> as literal text', async () => {
  const evil = '<script>alert(1)</script>';
  show([item('wi-fake-evil-0004', { owner: evil })]);
  await waitFor(() => expect(screen.getByText(evil)).toBeInTheDocument());
  expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});
