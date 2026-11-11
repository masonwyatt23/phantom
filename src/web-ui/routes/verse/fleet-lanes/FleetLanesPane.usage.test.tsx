import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { FleetLanesPane } from './FleetLanesPane.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); evictAll(); });
it('shows the shared personal usage reading in its lane', async () => {
  evictAll();
  const now = Date.now();
  const fixture = fleetRunsFixture({ codexPersonal: { usedPct: 42, asOf: new Date(now).toISOString(), resetsAt: new Date(now + 7_200_000).toISOString() } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
  render(<FleetLanesPane visible />);
  const lane = (await screen.findByText('codex-personal')).closest('li')!;
  expect(within(lane).getByText(/42% used · resets in/)).toBeInTheDocument();
});
