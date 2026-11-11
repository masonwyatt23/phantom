/**
 * routes/verse/shell/side-dock-layout.ts — Phantom docked as a narrow window on
 * the right of the screen (about 420–640px).
 *
 * `sideDockLayout` is pure: the width decides the mode.
 *   full   > 760px      today's layout, unchanged.
 *   side   480–760px    the chat list collapses, the dock opens as an overlay
 *                       sheet over the chat (never a split that squeezes it),
 *                       and the chat column keeps the whole width.
 *   phone  < 480px      today's phone behaviour (bottom-sheet dock, floating list).
 *
 * `useSideDockLayout` binds it to matchMedia so dragging the window edge moves
 * the mode live. `onEnterSide` fires once on each ENTRY into side mode (and on
 * mount in it) — never while the mode holds — so a chat list the operator
 * re-opens by hand stays open until the mode changes again.
 */
import { useEffect, useRef, useState } from 'react';

export type SideDockMode = 'full' | 'side' | 'phone';

export interface SideDockLayout {
  mode: SideDockMode;
  sidebarCollapsed: boolean;
  dockAs: 'split' | 'overlay';
  /** Width for a dock opened wide (split workspace); null leaves the caller's default. */
  dockWidthPx: number | null;
}

export const SIDE_MIN_PX = 480;
export const SIDE_MAX_PX = 760;
/** Room left at the sheet's left edge so the chat behind it stays visible as a scrim. */
const SHEET_GUTTER_PX = 32;
const SHEET_MIN_PX = 320;

export function sideDockLayout(widthPx: number): SideDockLayout {
  if (!Number.isFinite(widthPx) || widthPx > SIDE_MAX_PX) return { mode: 'full', sidebarCollapsed: false, dockAs: 'split', dockWidthPx: null };
  if (widthPx < SIDE_MIN_PX) return { mode: 'phone', sidebarCollapsed: false, dockAs: 'overlay', dockWidthPx: null };
  return { mode: 'side', sidebarCollapsed: true, dockAs: 'overlay', dockWidthPx: Math.max(SHEET_MIN_PX, Math.floor(widthPx) - SHEET_GUTTER_PX) };
}

function readWidth(): number {
  return typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth;
}

// The two edges of side mode, as the media queries the rest of the shell uses.
const QUERIES = [`(max-width: ${SIDE_MIN_PX - 0.02}px)`, `(max-width: ${SIDE_MAX_PX}px)`] as const;

export function useSideDockLayout(onEnterSide?: () => void): SideDockLayout {
  const [layout, setLayout] = useState(() => sideDockLayout(readWidth()));
  const enter = useRef(onEnterSide);
  enter.current = onEnterSide;
  const prevMode = useRef<SideDockMode | null>(null);

  useEffect(() => {
    const sync = () => {
      const next = sideDockLayout(readWidth());
      // Same mode, same width-derived sheet: keep the object so nothing re-renders mid-drag.
      setLayout((prev) => (prev.mode === next.mode && prev.dockWidthPx === next.dockWidthPx ? prev : next));
    };
    sync();
    const lists = typeof window.matchMedia === 'function' ? QUERIES.map((q) => window.matchMedia(q)) : [];
    for (const list of lists) list.addEventListener?.('change', sync);
    window.addEventListener('resize', sync, { passive: true });
    return () => {
      for (const list of lists) list.removeEventListener?.('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  useEffect(() => {
    if (prevMode.current !== layout.mode && layout.mode === 'side') enter.current?.();
    prevMode.current = layout.mode;
  }, [layout.mode]);

  return layout;
}
