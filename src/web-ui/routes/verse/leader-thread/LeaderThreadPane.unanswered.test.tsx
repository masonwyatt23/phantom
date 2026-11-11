import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

beforeEach(() => {
  evictAll();
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
    '/api/verse/fleet/runs': { inbox: [{ at: '2020-01-01 00:00', text: 'Phantom status', source: 'email' }], events: [] },
  } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe('LeaderThreadPane unanswered orders', () => {
  it('shows the strip and puts the follow-up in the composer', async () => {
    render(<LeaderThreadPane visible />);
    expect(await screen.findByText('Waiting on the Leader (1)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Reply to the Leader' }).value).toMatch(/^Still unanswered after.*Phantom status$/);
  });
});
