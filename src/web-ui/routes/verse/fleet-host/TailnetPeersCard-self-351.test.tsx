import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TailnetPeersBody } from './TailnetPeersCard.js';
import { isSelfPeer, type TailnetPeersView } from './tailnet-peers-model.js';

const view = (self: string, names: string[]): TailnetPeersView => ({
  asOf: '2026-11-14T11:57:00Z', self, dropped: 0, reasons: [],
  peers: names.map((name) => ({ name, os: 'macOS', online: true, lastSeen: 'x', ageSeconds: 5 })),
});
const rows = (c: HTMLElement) => Array.from(c.querySelectorAll('li'));

it('shows this computer', () => {
  render(<TailnetPeersBody view={view('mac-a', [])} />);
  expect(screen.getByText('This computer: mac-a')).toBeTruthy();
});
it('shows unknown self muted', () => {
  render(<TailnetPeersBody view={view('unknown', [])} />);
  const el = screen.getByText('This computer: unknown');
  expect(el.className).toContain('muted');
});
it('tags only the matching row', () => {
  const { container } = render(<TailnetPeersBody view={view('MAC-A', ['mac-a', 'mac-b'])} />);
  const [a, b] = rows(container);
  expect(a?.getAttribute('data-self')).toBe('true');
  expect(a?.textContent).toContain('this computer');
  expect(b?.getAttribute('data-self')).toBeNull();
  expect(b?.textContent).not.toContain('this computer');
});
it('matches on first DNS label', () => {
  const { container } = render(<TailnetPeersBody view={view('mac-a', ['mac-a.tail-fake.ts.net', 'mac-b.tail-fake.ts.net'])} />);
  expect(rows(container).map((r) => r.getAttribute('data-self'))).toEqual(['true', null]);
});
it("'unknown' never tags a row", () => {
  const { container } = render(<TailnetPeersBody view={view('unknown', ['unknown', 'mac-b'])} />);
  expect(rows(container).every((r) => r.getAttribute('data-self') === null)).toBe(true);
});
it('isSelfPeer unit cases', () => {
  expect(isSelfPeer('mac-a', 'MAC-A')).toBe(true);
  expect(isSelfPeer('mac-a.tail-fake.ts.net', 'mac-a')).toBe(true);
  expect(isSelfPeer('mac-a', 'mac-ab')).toBe(false);
  expect(isSelfPeer('unknown', 'unknown')).toBe(false);
  expect(isSelfPeer('', '')).toBe(false);
  expect(isSelfPeer('mac-a', '')).toBe(false);
});
