import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { resetDockStore } from '../dock/dock-store.js';
import { VerseApp } from '../VerseApp.js';
import { resetVerseStore } from '../verse-store.js';
import { openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import { resetCommandBus } from './command-bus.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

beforeEach(() => {
  localStorage.clear(); evictAll(); resetVerseStore(); resetVerseUi(); resetDockStore();
  resetCommandBus(); resetActivityForTest(); markCheckComplete(true);
  vi.stubGlobal('EventSource', MockEventSource);
});
afterEach(() => { markCheckComplete(false); resetActivityForTest(); vi.unstubAllGlobals(); });

function setup(items: { id: string; text: string }[] | null) {
  const net = shellFetch(activity({ needsYou: [] }));
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/verse/agent-bus/needs-mason') return Promise.resolve(items === null ? new Response('', { status: 500 }) : Response.json({ items }));
    if (String(input) === '/api/verse/fleet/runs') return Promise.resolve(new Response('', { status: 404 }));
    return net.fetch(input, init);
  }));
  render(<ToastProvider><VerseApp /></ToastProvider>);
}

it('counts only hard limits in the rail and drawer', async () => {
  setup([{ id: '1', text: 'Approve the fake $40 plan change' }, { id: '2', text: 'Email the fake list' },
    ...['3', '4', '5'].map(id => ({ id, text: `unpark RQ-FAKE-${id}` }))]);
  const rail = await screen.findByRole('navigation', { name: 'Phantom sections' });
  expect(await within(rail).findByRole('button', { name: 'Needs you, 2' }, { timeout: 20_000 })).toBeInTheDocument();
  act(() => openVerseNeedsYou({ split: 'all' }));
  expect(await screen.findByText('Approve the fake $40 plan change', {}, { timeout: 20_000 })).toBeInTheDocument();
  expect(screen.queryByText('All clear')).not.toBeInTheDocument();
}, 60_000);

it('adds zero for ordinary lines', async () => {
  setup([{ id: '1', text: 'unpark RQ-FAKE-1' }]);
  const rail = await screen.findByRole('navigation', { name: 'Phantom sections' });
  expect(await within(rail).findByRole('button', { name: 'Needs you, 0' }, { timeout: 20_000 })).toBeInTheDocument();
}, 60_000);

it('does not claim all clear when the read fails', async () => {
  setup(null);
  act(() => openVerseNeedsYou({ split: 'all' }));
  expect(await screen.findByText(/Needs Mason failed to answer/i, {}, { timeout: 20_000 })).toBeInTheDocument();
  expect(screen.queryByText('All clear')).not.toBeInTheDocument();
}, 60_000);
