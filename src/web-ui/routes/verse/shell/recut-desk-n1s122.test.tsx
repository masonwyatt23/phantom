import { expect, it } from 'vitest';
import { requestSteerFocus } from './steer-hotkey.js';
import { getVerseUiState, setVerseSection } from '../verse-ui-store.js';

it('keeps an unsent message in place when the steer shortcut is requested', () => {
  setVerseSection('chat');
  const draft = document.createElement('textarea');
  draft.value = 'An unsent message';
  document.body.append(draft);
  draft.focus();
  let notice = false;
  try {
    requestSteerFocus(false, () => { notice = true; });
    expect(notice).toBe(true);
    expect(draft.value).toBe('An unsent message');
    expect(document.activeElement).toBe(draft);
    expect(getVerseUiState().section).toBe('chat');
  } finally {
    draft.remove();
  }
});
