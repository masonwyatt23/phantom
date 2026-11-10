import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { IdeasPane } from './IdeasPane.js';

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

it('shows queued work only beside its matching idea', async () => {
  stubSurfaceFetch({ routes: {
    '/api/backlog': [{ id: 'a', title: 'First idea', repo: 'org/repo' }, { id: 'b', title: 'Other idea', repo: 'org/repo' }],
    '/api/verse/fleet/live/drop-jobs': { v: 1, items: [{ id: 'RQ-ONE', lane: 'claude', tier: 'work', title: 'First idea', bytes: 10, ageSeconds: 1 }] },
    '/api/verse/fleet/runs': { workers: [], mergesLastHour: { items: [] } },
  } });
  render(<IdeasPane />);
  expect(await screen.findByText('Queued as RQ-ONE')).toBeInTheDocument();
  const other = screen.getByText('Other idea').closest('li');
  expect(other).not.toBeNull();
  expect(within(other!).queryByText(/Queued as|Running as|Merged in/)).toBeNull();
});
