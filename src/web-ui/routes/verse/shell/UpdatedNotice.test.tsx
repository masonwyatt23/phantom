import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { APP_VERSION } from '../sections/app-version.js';
import { UpdatedNotice } from './UpdatedNotice.js';
import { updatedNotice } from './updated-once-model.js';

beforeEach(() => localStorage.clear());
it('shows an upgrade and stays hidden after dismissal and remount', () => {
  updatedNotice(localStorage, '0.0.0');
  const view = render(<UpdatedNotice />);
  expect(screen.getByRole('status')).toHaveTextContent(`Phantom updated from 0.0.0 to ${APP_VERSION}`);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('status')).toBeNull();
  view.unmount();
  render(<UpdatedNotice />);
  expect(screen.queryByRole('status')).toBeNull();
});
