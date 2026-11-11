import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

beforeEach(() => {
  evictAll(); clearMutationToken();
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: Array.from({ length: 250 }, (_, i) => msg({ id: `line-${i}`, text: `Window line ${i}` })) },
    '/api/verse/fleet/runs': { inbox: [] },
    '/api/verse/leader/directives': { directives: [] },
  } });
});
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('conversation window', () => {
  it('loads older rows on demand', async () => {
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    await within(log).findByText('Window line 249');
    expect(log.querySelectorAll('section[data-from]')).toHaveLength(200);
    fireEvent.click(within(log).getByRole('button', { name: 'Show older (50)' }));
    expect(log.querySelectorAll('section[data-from]')).toHaveLength(250);
    expect(within(log).queryByRole('button', { name: /Show older/ })).not.toBeInTheDocument();
  }, 15000);
  it('reveals an old find match', async () => {
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    await within(log).findByText('Window line 249');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in conversation' }), { target: { value: 'Window line 0' } });
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
    expect(within(log).getByText('Window line 0')).toBeInTheDocument();
  });
});
