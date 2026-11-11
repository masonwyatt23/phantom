/**
 * Workspace.side-dock.test.tsx — Phantom docked as a ~560px window on the
 * right of the screen: the chat list steps aside once, the thread and the
 * steer box stay, the dock is an overlay sheet, and widening restores the split.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../data/cache.js';
import { openDockPane, resetDockStore } from './dock/dock-store.js';
import { bootstrap, CLAUDE_SEAT, LOCAL_SEAT, ev, session } from './fixtures.test-support.js';
import { mockViewport, type ViewportMock } from './shell/viewport.test-support.js';
import { useVerseSession } from './useVerseSession.js';
import { resetVerseStore, seedVerseSession } from './verse-store.js';
import { Workspace } from './Workspace.js';

let toggles = 0;
function Harness() {
  const view = useVerseSession('vs_1');
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Workspace view={view} seats={[CLAUDE_SEAT, LOCAL_SEAT]} projects={bootstrap().projects} dispatchEnabled locked={false} hasAnySessions
      onSend={vi.fn(async () => true)} onStop={vi.fn()} onRename={vi.fn(async () => true)} onRequestDelete={vi.fn()}
      onSeatChange={vi.fn()} onNew={vi.fn()} onRetry={vi.fn()} sidebarCollapsed={collapsed}
      onToggleSidebar={() => { toggles += 1; setCollapsed((c) => !c); }}
      handoffOpen={false} onHandoffOpenChange={vi.fn()} otherRunning={[]} />
  );
}

let vp: ViewportMock | null = null;
beforeEach(() => {
  toggles = 0;
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetDockStore();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource);
  seedVerseSession('vs_1', session({ id: 'vs_1', status: 'idle', turnCount: 1 }), [
    ev(1, 'user-message', { turnId: 't1', text: 'see https://github.com/ashlrai/phantom/pull/4778' }),
    ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
    ev(3, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1000 }),
  ]);
});
afterEach(() => {
  vp?.restore();
  vp = null;
  vi.unstubAllGlobals();
});

describe('Workspace at a right-docked width', () => {
  it('560px: the list collapses once, the steer box stays, the dock is an overlay; 1200px brings the split back', async () => {
    vp = mockViewport(560);
    render(<Harness />);
    const region = screen.getByRole('textbox', { name: 'Message' }).closest('section')!;
    expect(screen.getByRole('textbox', { name: 'Message' }).tagName).toBe('TEXTAREA');
    expect(region).toHaveAttribute('data-dock-layout', 'side');
    expect(screen.getByRole('button', { name: 'Show chat list' })).toHaveAttribute('aria-pressed', 'false');
    expect(toggles).toBe(1);

    act(() => openDockPane('tasks'));
    expect(region).toHaveAttribute('data-dock-as', 'overlay');

    // Mason opens the list by hand: staying in side mode must not collapse it again.
    act(() => screen.getByRole('button', { name: 'Show chat list' }).click());
    expect(toggles).toBe(2);
    act(() => vp!.setWidth(600));
    expect(toggles).toBe(2);
    expect(screen.getByRole('button', { name: 'Chat list' })).toBeInTheDocument();

    act(() => vp!.setWidth(1200));
    await waitFor(() => expect(region).toHaveAttribute('data-dock-as', 'split'));
    expect(region).toHaveAttribute('data-dock-layout', 'full');

    // Narrowing again is a new entry into side mode: the list steps aside again.
    act(() => vp!.setWidth(540));
    await waitFor(() => expect(toggles).toBe(3));
  });
});
