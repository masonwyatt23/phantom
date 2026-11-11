import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { leaderState } from '../../command/fixtures.test-support.js';
import { msg } from '../../leader/thread-fixtures.test-support.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { json, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { LeaderScreen } from './LeaderScreen.js';

beforeEach(() => setMutationToken(TOKEN));
afterEach(() => { clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest(); vi.unstubAllGlobals(); });

it('runs slash commands locally and sends ordinary messages', async () => {
  const send = vi.fn(() => json({ message: msg({ id: 'sent', from: 'mason', text: 'hello' }), reply: null }));
  stubFetch({
    'GET /api/verse/leader/thread': { messages: [] },
    'GET /api/verse/leader/directives': { directives: [], retired: [] },
    'GET /api/verse/leader': leaderState('live'),
    'GET /api/verse/comms/owner-thread/status': { schema: 'comms.owner-status.v1', text: 'All clear' },
    'POST /api/verse/leader/thread': send,
  });
  renderMobile(<><LeaderScreen /><MobileToasts /></>);
  const box = await screen.findByRole('textbox', { name: 'Message the Leader' });
  const user = userEvent.setup();
  await user.type(box, '/status');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('All clear')).toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  await waitFor(() => expect(box).toHaveValue(''));
  await user.type(box, 'hello');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
});
