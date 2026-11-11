import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import { setLeaderDraft, takeLeaderDraft } from './leader-draft-store.js';
import { clearLeaderReply, saveLeaderReply } from './leader-reply-keep.js';

beforeEach(() => { evictAll(); clearLeaderReply(localStorage); takeLeaderDraft(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

function serve(fail = false) {
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
  }, post: url => fail && url === '/api/verse/leader/inbox' ? new Response(JSON.stringify({ error: 'Refused' }), { status: 500 }) : undefined });
}

async function mount() {
  const view = render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  return { ...view, input: screen.getByRole('textbox', { name: 'Reply to the Leader' }) };
}

describe('Leader reply persistence', () => {
  it('restores text after unmount', async () => {
    serve();
    const first = await mount();
    fireEvent.change(first.input, { target: { value: 'Unsent reply' } });
    first.unmount();
    const second = await mount();
    expect(second.input).toHaveValue('Unsent reply');
  });

  it('clears a successful send', async () => {
    serve();
    const first = await mount();
    fireEvent.change(first.input, { target: { value: 'Send me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(first.input).toHaveValue(''));
    first.unmount();
    expect((await mount()).input).toHaveValue('');
  });

  it('keeps a rejected send', async () => {
    serve(true);
    const first = await mount();
    fireEvent.change(first.input, { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    first.unmount();
    expect((await mount()).input).toHaveValue('Keep me');
  });

  it('appends the Feed handoff to the restored text', async () => {
    serve();
    saveLeaderReply(localStorage, 'Restored');
    setLeaderDraft('From the Feed');
    expect((await mount()).input).toHaveValue('Restored\n\nFrom the Feed');
  });
});
