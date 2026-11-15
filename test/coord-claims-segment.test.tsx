import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CoordClaimsSegment, type CoordClaimsPayload } from '../src/web-ui/routes/verse/coord-claims-segment.js';
import { CoordAnswerStrip } from '../src/web-ui/routes/verse/fleet-board/CoordAnswerStrip.js';
import { evictAll } from '../src/web-ui/data/cache.js';
import { refetchQuery } from '../src/web-ui/data/cache.js';

const NOW = Date.parse('2026-11-14T19:00:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const claim = (n: number) => ({
  id: `fake-claim-${n}`, agent: `fake-agent-${n}`, repo: 'fake/repo', task: `PR #${n}`,
  claimedAt: at(-n), expiresAt: at(10),
});
const known = (claims: CoordClaimsPayload['claims'] = []): CoordClaimsPayload => ({ state: 'known', claims });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows a measured empty ledger as Claims 0', () => {
  render(<CoordClaimsSegment payload={known()} now={NOW} />);
  expect(screen.getByText('Claims 0')).toBeInTheDocument();
});

it.each([undefined, null, { state: 'unknown', reason: 'fake reader failed' }, { state: 'known' }])(
  'keeps unavailable or malformed payload %j unknown with a reason', (payload) => {
    render(<CoordClaimsSegment payload={payload} now={NOW} />);
    expect(screen.getByText('Claims ?')).toHaveAttribute('title');
    expect(screen.queryByText('Claims 0')).not.toBeInTheDocument();
    if (payload?.reason) expect(screen.getByText('Claims ?')).toHaveAttribute('title', payload.reason);
  },
);

it('counts four claims but shows only the three newest owners and PRs', () => {
  render(<CoordClaimsSegment payload={known([claim(4), claim(2), claim(1), claim(3)])} now={NOW} />);
  expect(screen.getByText('Claims 4')).toBeInTheDocument();
  expect(screen.getByText('fake-agent-1 → fake/repo#1 · claimed 1m ago')).toBeInTheDocument();
  expect(screen.getByText(/fake-agent-3 → fake\/repo#3/)).toBeInTheDocument();
  expect(screen.queryByText(/fake-agent-4/)).not.toBeInTheDocument();
});

it('mutes an expired lease and preserves tasks without a PR', () => {
  render(<CoordClaimsSegment payload={known([{ ...claim(1), task: 'fake task', expiresAt: at(-1) }])} now={NOW} />);
  expect(screen.getByText('fake-agent-1 → fake/repo · fake task · stale'))
    .toHaveAttribute('data-stale', 'true');
  expect(screen.getByText(/fake task · stale/)).toHaveStyle({ opacity: '0.55' });
});

it('ages a relative lease from the payload observation time', () => {
  render(<CoordClaimsSegment payload={{ ...known([{ ...claim(1), expiresAt: undefined, expiresInSeconds: 30 }]), generatedAt: at(-1) }} now={NOW} />);
  expect(screen.getByText(/fake-agent-1/)).toHaveAttribute('data-stale', 'true');
});

it('shows the newest qualified VERIFIED return from the existing board selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('coordination-claims')) return json(known());
    if (String(input).includes('work-board')) return json({ inbox: 'ok', items: [
      { id: 'fake-old', owner: 'fake-a', state: 'VERIFIED', claimReceipt: 'fake-receipt-a', asOf: at(-4) },
      { id: 'fake-new', owner: 'fake-b', state: 'VERIFIED', claimReceipt: 'fake-receipt-b', asOf: at(-2) },
      { id: 'fake-unclaimed', owner: 'fake-c', state: 'VERIFIED', asOf: at(-1) },
    ] });
    return json({}, 404);
  }));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  render(<CoordAnswerStrip visible />);
  await waitFor(() => expect(screen.getByText('Last VERIFIED fake-b → fake-new · 2m ago')).toBeInTheDocument());
  clock.mockRestore();
});

it.each([503, 'network'])('shows fetch failure %s as unknown even after a successful empty read', async (failure) => {
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes('coordination-claims')) return json({}, 404);
    if (!failed) return json(known());
    if (failure === 'network') throw new Error('fake network failure');
    return json({ error: 'fake unavailable' }, failure);
  }));
  render(<CoordAnswerStrip visible />);
  await waitFor(() => expect(screen.getByText('Claims 0')).toBeInTheDocument());
  failed = true;
  await refetchQuery('verse-fleet-coordination-claims');
  await waitFor(() => expect(screen.getByText('Claims ?')).toHaveAttribute('title'));
  expect(screen.queryByText('Claims 0')).not.toBeInTheDocument();
});
