import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { takeLeaderDraft } from './leader-draft-store.js';
import { UnansweredStrip } from './UnansweredStrip.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const runs = { inbox: [{ at: '2026-10-31 00:30', text: 'Phantom status', source: 'email' }], events: [] };

afterEach(() => { takeLeaderDraft(); });

describe('UnansweredStrip', () => {
  it('renders nothing without unanswered orders', () => {
    const { container } = render(<UnansweredStrip runs={{ inbox: [], events: [] }} nowMs={now} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the age and text and prepares a follow-up', () => {
    render(<UnansweredStrip runs={runs} nowMs={now} />);
    expect(screen.getByText('Waiting on the Leader (1)')).toBeInTheDocument();
    expect(screen.getByText('30 min · Phantom status')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(takeLeaderDraft()).toBe('Still unanswered after 30 min: Phantom status');
  });
});
