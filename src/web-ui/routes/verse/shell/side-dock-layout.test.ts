import { describe, expect, it } from 'vitest';
import { sideDockLayout } from './side-dock-layout.js';

describe('sideDockLayout', () => {
  it('420 is a phone: today\'s behaviour, nothing collapsed for it', () => {
    expect(sideDockLayout(420)).toEqual({ mode: 'phone', sidebarCollapsed: false, dockAs: 'overlay', dockWidthPx: null });
  });
  it('480 is the first side width', () => {
    expect(sideDockLayout(480)).toMatchObject({ mode: 'side', sidebarCollapsed: true, dockAs: 'overlay' });
  });
  it('560 collapses the list and opens the dock as a sheet nearly the window wide', () => {
    expect(sideDockLayout(560)).toEqual({ mode: 'side', sidebarCollapsed: true, dockAs: 'overlay', dockWidthPx: 528 });
  });
  it('760 is still side; 761 is full and split', () => {
    expect(sideDockLayout(760).mode).toBe('side');
    expect(sideDockLayout(761)).toEqual({ mode: 'full', sidebarCollapsed: false, dockAs: 'split', dockWidthPx: null });
  });
  it('1400 is full', () => {
    expect(sideDockLayout(1400)).toEqual({ mode: 'full', sidebarCollapsed: false, dockAs: 'split', dockWidthPx: null });
  });
  it('a sheet is never narrower than the dock floor', () => {
    expect(sideDockLayout(480).dockWidthPx).toBeGreaterThanOrEqual(320);
  });
});
