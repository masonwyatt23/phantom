import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SlackRepliesLine } from './SlackRepliesLine.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-13T12:00:00Z');

it('renders the line and sample rows for an ok payload', () => {
  const raw = { slackReplies: { state: 'ok', answered: 3, unanswered: 2, oldestUnansweredAt: '2026-11-13T11:46:00Z', uncertainSends: 1,
    sample: [{ channelId: 'C0FAKE0001', threadTs: '1731000000.000100', at: '2026-11-13T11:46:00Z' }] } };
  render(<SlackRepliesLine raw={raw} nowMs={NOW} />);
  expect(screen.getByText('Slack replies: 3 answered, 2 unanswered (oldest 14m ago), 1 send unconfirmed')).toBeInTheDocument();
  expect(screen.getByText('C0FAKE0001')).toBeInTheDocument();
  expect(screen.getByText('1731000000.000100')).toBeInTheDocument();
  expect(screen.getByText('14m ago')).toBeInTheDocument();
});

it('renders nothing when absent', () => {
  const { container } = render(<SlackRepliesLine raw={{}} nowMs={NOW} />);
  expect(container).toBeEmptyDOMElement();
});
