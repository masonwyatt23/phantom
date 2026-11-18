import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isSlackChannelId, isSlackTs } from '../../../../core/agents/slack-network.js';
import { buildSlackTraceLookupUrl, narrowSlackTraceLookup, SLACK_CHANNEL_ID_RE, SLACK_TS_RE } from './slack-trace-lookup.js';
import { SlackTraceLookup } from './SlackTraceLookup.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const TS = '1700000000.000100';
const bundle = (over: object = {}) => ({
  asOf: '2026-11-15T12:00:00.000Z',
  rows: [{ at: '2026-11-15T11:59:00.000Z', channelId: 'C00000000', threadTs: TS, messageTs: TS, ingress: 'posted', outcome: 'answered', replyTs: '1700000001.000200' }],
  counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 },
  sources: { journal: 'ok', sends: 'ok' }, truncated: false,
  scope: 'Only this message in this channel.', selection: { channelId: 'C00000000', messageTs: TS },
  freshness: { maxAgeSeconds: 900, verdict: 'fresh', basis: 'journal' }, ...over });
const stubFetch = (status: number, body: unknown) => {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
};
async function lookup() {
  const user = userEvent.setup();
  render(<SlackTraceLookup />);
  await user.type(screen.getByLabelText(/Thread ts/), TS);
  await user.type(screen.getByLabelText(/Channel id/), 'C00000000');
  await user.type(screen.getByLabelText(/Message ts/), TS);
  await user.click(screen.getByRole('button', { name: 'Look up' }));
}

it('builds URLs by the server rules', () => {
  expect(buildSlackTraceLookupUrl({ thread: TS })).toBe(`/api/verse/fleet/control/slack-trace?thread=${encodeURIComponent(TS)}&maxAgeSeconds=900`);
  const u = buildSlackTraceLookupUrl({ thread: TS, channel: 'C00000000', message: TS, maxAgeSeconds: 60 }) as string;
  expect(new URL(u, 'http://x').searchParams.get('message')).toBe(TS);
  for (const bad of [{ thread: '' }, { thread: 'abc' }, { thread: TS, message: TS }, { thread: TS, channel: 'c0' },
    { thread: TS, channel: 'C00000000', message: 'x' }, { thread: TS, maxAgeSeconds: 0 }, { thread: TS, maxAgeSeconds: '1e3' },
    { thread: TS, maxAgeSeconds: -5 }, { thread: TS, maxAgeSeconds: 1.5 }]) {
    expect(buildSlackTraceLookupUrl(bad)).toHaveProperty('error');
  }
});

it('pins the client validators to the server functions', () => {
  for (const v of [TS, '1.1', '1700000000', '.1', 'a.b', '', ' 1.1', '1'.repeat(21) + '.1', '1.' + '1'.repeat(11)]) expect(SLACK_TS_RE.test(v)).toBe(isSlackTs(v));
  for (const v of ['C00000000', 'D123', 'G12', 'U00000000', 'C1', 'c00000000', 'C' + 'A'.repeat(33), 'C' + 'A'.repeat(32), '']) expect(SLACK_CHANNEL_ID_RE.test(v)).toBe(isSlackChannelId(v));
});

it('narrows freshness, scope and selection', () => {
  expect(narrowSlackTraceLookup(bundle())).toMatchObject({ freshness: { verdict: 'fresh', maxAgeSeconds: 900 }, selected: true, scope: 'Only this message in this channel.' });
  expect(narrowSlackTraceLookup(bundle({ freshness: { verdict: 'all-good', maxAgeSeconds: 5 } }))!.freshness!.verdict).toBe('unknown');
  const { freshness: _f, selection: _s, scope: _c, ...bare } = bundle();
  expect(narrowSlackTraceLookup(bare)).toMatchObject({ freshness: null, selected: false, scope: '' });
  expect(narrowSlackTraceLookup(bundle({ scope: 'x'.repeat(500) }))!.scope).toHaveLength(300);
  expect(narrowSlackTraceLookup(null)).toBeNull();
  expect(narrowSlackTraceLookup({ rows: 1 })).toBeNull();
});

it('renders a fresh result with scope note', async () => {
  const fn = stubFetch(200, bundle());
  await lookup();
  expect(await screen.findByText(/freshness: FRESH \(max 900 s\)/)).toBeInTheDocument();
  expect(screen.getByText('ANSWERED')).toBeInTheDocument();
  expect(screen.getByText('Only this message in this channel.')).toBeInTheDocument();
  expect(String((fn.mock.calls[0] as unknown[])[0])).toContain('/slack-trace?thread=');
  expect(((fn.mock.calls[0] as unknown[])[1] as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
});

it('renders a stale verdict', async () => {
  stubFetch(200, bundle({ freshness: { verdict: 'stale', maxAgeSeconds: 900, basis: 'journal' } }));
  await lookup();
  expect(await screen.findByText(/freshness: STALE/)).toBeInTheDocument();
});

it('shows zero rows as no evidence, never an all-clear', async () => {
  stubFetch(200, bundle({ rows: [], counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 }, freshness: { verdict: 'unknown', maxAgeSeconds: 900, basis: 'none' } }));
  await lookup();
  expect(await screen.findByText('No evidence for this request')).toBeInTheDocument();
  expect(screen.getByText(/freshness: UNKNOWN/)).toBeInTheDocument();
  expect(screen.queryByText(/all answered|all clear/i)).toBeNull();
});

it('maps 503 to trace unavailable', async () => {
  stubFetch(503, { error: 'down' });
  await lookup();
  expect(await screen.findByText('trace unavailable')).toBeInTheDocument();
});

it('maps 400 and 404', async () => {
  stubFetch(400, {});
  await lookup();
  expect(await screen.findByText('invalid lookup')).toBeInTheDocument();
  cleanup();
  stubFetch(404, {});
  await lookup();
  await waitFor(() => expect(screen.getByText('not in this build')).toBeInTheDocument());
});

it('disables the button on invalid input', async () => {
  const user = userEvent.setup();
  const fn = stubFetch(200, bundle());
  render(<SlackTraceLookup />);
  const button = screen.getByRole('button', { name: 'Look up' });
  expect(button).toBeDisabled();
  await user.type(screen.getByLabelText(/Thread ts/), TS);
  expect(button).toBeEnabled();
  await user.type(screen.getByLabelText(/Message ts/), TS); // message without channel
  expect(button).toBeDisabled();
  expect(fn).not.toHaveBeenCalled();
});
