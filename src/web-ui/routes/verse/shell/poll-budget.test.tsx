import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { resetVerseStore } from '../verse-store.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { VerseApp } from '../VerseApp.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

afterEach(() => {
  cleanup();
  resetActivityForTest();
  markCheckComplete(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps default desktop requests within visible and hidden polling budgets', async () => {
  localStorage.clear();
  window.history.replaceState(null, '', '/verse/');
  evictAll();
  resetVerseStore();
  resetVerseUi();
  resetActivityForTest();
  markCheckComplete(true);
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  const net = shellFetch(activity());
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') calls.push(new URL(input.toString(), 'http://localhost').pathname);
    const response = await net.fetch(input, init);
    const path = input.toString().split('?')[0];
    const fallback = path === '/api/runs' ? [] : path === '/api/verse/observe' ? { usage: { windows: [] } } : {};
    return response.status === 404 ? new Response(JSON.stringify(fallback), { headers: { 'content-type': 'application/json' } }) : response;
  }));
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibility === 'hidden');
  vi.useFakeTimers();
  render(<ToastProvider><VerseApp /></ToastProvider>);
  await act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(0); });
  async function advance() {
    for (let i = 0; i < 300; i++) await act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(1_000); });
  }
  await advance();
  expect(document.querySelector('[data-home-pane="leader-thread"]')).not.toBeNull();
  const visible = [...calls];
  visibility = 'hidden';
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  const boundary = calls.length;
  await advance();
  const hidden = calls.slice(boundary);
  const table = (paths: string[]) => Object.entries(paths.reduce<Record<string, number>>((counts, path) => {
    counts[path] = (counts[path] ?? 0) + 1;
    return counts;
  }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const report = `visible (${visible.length}):\n${table(visible).map(([path, count]) => `${path} → ${count}`).join('\n')}\nhidden (${hidden.length}):\n${table(hidden).map(([path, count]) => `${path} → ${count}`).join('\n')}`;

  expect(Math.max(0, ...table(visible).map(([, count]) => count)), report).toBeLessThanOrEqual(60);
  expect(visible.length, report).toBeLessThan(600);
  expect(hidden.length, report).toBeLessThan(60);
}, 60_000);

it.todo('reduce /api/verse/fleet/runs polling owned by LeaderThreadPane');
it.todo('reduce /api/verse/leader/thread polling owned by LeaderThreadPane');
it.todo('reduce /api/verse/comms/owner-thread polling owned by LeaderThreadPane');
it.todo('reduce /api/verse/fleet/control/lanes polling owned by LeaderThreadPane');
