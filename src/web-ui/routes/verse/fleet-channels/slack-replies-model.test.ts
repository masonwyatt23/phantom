import { expect, it } from 'vitest';
import { narrowSlackReplies, slackRepliesLine } from './slack-replies-model.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const row = (i: number) => ({ channelId: `C0FAKE000${i}`, threadTs: `1731000000.00010${i}`, at: '2026-11-13T11:50:00Z' });
const ok = (over: Record<string, unknown> = {}) => ({ slackReplies: { state: 'ok', answered: 3, unanswered: 2, oldestUnansweredAt: '2026-11-13T11:46:00Z', uncertainSends: 1, sample: [row(1)], ...over }, sources: { slackReplies: 'healthy' } });

it('renders nothing when the field is absent', () => {
  expect(narrowSlackReplies({ channelHealth: {} })).toEqual({ kind: 'absent' });
  expect(narrowSlackReplies(undefined)).toEqual({ kind: 'absent' });
  expect(slackRepliesLine({ kind: 'absent' }, NOW)).toBeNull();
});

it('is unavailable for null or a degraded source', () => {
  expect(slackRepliesLine(narrowSlackReplies({ slackReplies: null }), NOW)).toBe('Slack replies: unavailable');
  expect(slackRepliesLine(narrowSlackReplies(ok({}) && { ...ok(), sources: { slackReplies: 'degraded' } }), NOW)).toBe('Slack replies: unavailable');
});

it('says none recorded when missing', () => {
  expect(slackRepliesLine(narrowSlackReplies(ok({ state: 'missing', answered: 0, unanswered: 0 })), NOW)).toBe('Slack replies: none recorded');
});

it('reports unanswered with oldest age and unconfirmed sends', () => {
  expect(slackRepliesLine(narrowSlackReplies(ok()), NOW)).toBe('Slack replies: 3 answered, 2 unanswered (oldest 14m ago), 1 send unconfirmed');
  expect(slackRepliesLine(narrowSlackReplies(ok({ uncertainSends: 2 })), NOW)).toContain('2 sends unconfirmed');
});

it('omits oldest when nothing is unanswered', () => {
  expect(slackRepliesLine(narrowSlackReplies(ok({ unanswered: 0, oldestUnansweredAt: null, uncertainSends: 0 })), NOW)).toBe('Slack replies: 3 answered, 0 unanswered');
});

it('marks a degraded state as a partial read', () => {
  expect(slackRepliesLine(narrowSlackReplies(ok({ state: 'degraded', uncertainSends: 0 })), NOW)).toBe('Slack replies: 3 answered, 2 unanswered (oldest 14m ago) (partial read)');
});

it('clamps garbage counts to 0', () => {
  const view = narrowSlackReplies(ok({ answered: -4, unanswered: Number.NaN, uncertainSends: 'x' }));
  expect(view).toMatchObject({ kind: 'ok', answered: 0, unanswered: 0, uncertainSends: 0 });
});

it('caps the sample at 5 and drops malformed rows', () => {
  const sample = [...[1, 2, 3, 4, 5, 6, 7].map(row), { channelId: 5, threadTs: 'x', at: 'y' }, null];
  const view = narrowSlackReplies(ok({ sample }));
  expect(view.kind === 'ok' && view.sample).toHaveLength(5);
  const bad = narrowSlackReplies(ok({ sample: [{ channelId: 5, threadTs: 'x', at: 'y' }, row(1)] }));
  expect(bad.kind === 'ok' && bad.sample).toEqual([row(1)]);
});
