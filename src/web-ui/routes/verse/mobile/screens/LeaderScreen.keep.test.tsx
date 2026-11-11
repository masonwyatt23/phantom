import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { leaderState } from '../../command/fixtures.test-support.js';
import { msg, threadMessages, QUESTION_TEXT } from '../../leader/thread-fixtures.test-support.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { json, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { LeaderScreen } from './LeaderScreen.js';
import { clearPhoneLeaderDraft, loadPhoneLeaderDraft } from './leader-draft-keep.js';

const THREAD = '/api/verse/leader/thread';
const composer = () => screen.getByRole('textbox', { name: /Message the Leader|Answer the Leader/ });
function setup(fail = false) {
  stubFetch({
    [`GET ${THREAD}`]: () => json({ messages: threadMessages() }),
    'GET /api/verse/leader/directives': { directives: [], retired: [] },
    'GET /api/verse/leader': () => json(leaderState('live')),
    [`POST ${THREAD}`]: () => fail ? json({ error: 'Offline' }, 503) : json({ message: msg({ id: 'new', from: 'mason', text: 'Hello' }), reply: null }),
  });
  return renderMobile(<><LeaderScreen /><MobileToasts /></>);
}
beforeEach(() => { clearPhoneLeaderDraft(localStorage); setMutationToken(TOKEN); });
afterEach(() => { cleanup(); clearPhoneLeaderDraft(localStorage); clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('restores typed text after remount', async () => {
  const view = setup();
  await screen.findByText(QUESTION_TEXT);
  fireEvent.change(composer(), { target: { value: 'Hello' } });
  view.unmount();
  renderMobile(<LeaderScreen />);
  expect(await screen.findByRole('textbox', { name: 'Message the Leader' })).toHaveValue('Hello');
});

it('flushes immediately when the page becomes hidden', async () => {
  setup();
  await screen.findByText(QUESTION_TEXT);
  fireEvent.change(composer(), { target: { value: 'Hidden draft' } });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  expect(loadPhoneLeaderDraft(localStorage)).toBe('Hidden draft');
});

it.each([false, true])('clears only after a successful send (failure: %s)', async (fail) => {
  setup(fail);
  await screen.findByText(QUESTION_TEXT);
  fireEvent.change(composer(), { target: { value: 'Hello' } });
  fireEvent(window, new Event('pagehide'));
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  if (fail) {
    await screen.findByText(/Offline|HTTP 503/);
    expect(loadPhoneLeaderDraft(localStorage)).toBe('Hello');
    expect(composer()).toHaveValue('Hello');
  } else {
    await waitFor(() => expect(composer()).toHaveValue(''));
    expect(loadPhoneLeaderDraft(localStorage)).toBe('');
  }
});
