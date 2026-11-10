import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateHandoff } from '../../../../core/verse/handoff.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import {
  buildDotHandoffEnvelope, DOT_AGENT_ID, dotActionView, dotRouteFromCommsStatus, ideaHandoffId, ideaHandoffState,
  ideaWorkerHandoff, isIdeaHandoffReceipt,
} from './idea-dot-handoff.js';
import { IdeasPane, postDotHandoff } from './IdeasPane.js';

const IDEA = { id: '/fake/repo:issue:abc123', title: 'Fake idea title', repo: 'org/fake', rationale: 'Fake rationale text', goal: { id: 'g-fake', name: 'Fake goal' } };
const HID = ideaHandoffId(IDEA.id);
const NOW = 1_800_000_000_000;

let cursor = 0;
function receipt(envelope: Partial<AgentBusReceipt['envelope']> & { id: string }): AgentBusReceipt {
  cursor += 1;
  return { cursor, receivedAt: NOW, envelope: { from: DOT_AGENT_ID, to: 'mason', priority: 'P3', ttl: 1000, body: null, ...envelope } };
}
const sent = () => receipt({ id: HID, from: 'mason', to: DOT_AGENT_ID, body: { kind: 'worker-handoff', taskId: HID, prompt: 'p' } });
const reply = (id: string, body: Record<string, unknown>, from = DOT_AGENT_ID) => receipt({ id, from, body: { inReplyTo: HID, ...body } });
const commsStatus = (leg: unknown) => ({ version: 1, generatedAt: new Date(NOW).toISOString(), cutover: { overall: { state: 'blocked', blockers: [] }, capabilities: leg === undefined ? {} : { teammateImessageDelivery: leg } } });

describe('ideaHandoffId', () => {
  it('is stable, distinct per idea, a valid fleet job id, and hides the idea id', () => {
    expect(ideaHandoffId(IDEA.id)).toBe(HID);
    expect(ideaHandoffId('other')).not.toBe(HID);
    expect(HID).toMatch(/^idea-dot-[0-9a-f]{16}$/);
    expect(HID).not.toContain('fake');
  });
});

describe('buildDotHandoffEnvelope', () => {
  it('builds the handoff-send envelope with the title, rationale, goal tag and correlation id', () => {
    const built = buildDotHandoffEnvelope(IDEA);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.envelope).toMatchObject({ id: HID, from: 'mason', to: DOT_AGENT_ID, priority: 'P3', ttl: 86_400_000,
      body: { kind: 'worker-handoff', taskId: HID } });
    expect(Object.keys(built.envelope.body).sort()).toEqual(['kind', 'prompt', 'taskId']);
    for (const text of ['Idea: Fake idea title', 'Rationale: Fake rationale text', 'Goal: Fake goal', `Correlation id: ${HID}`]) {
      expect(built.envelope.body.prompt).toContain(text);
    }
    expect(validateHandoff(ideaWorkerHandoff(IDEA))).toEqual([]);
  });

  it('never addresses anyone but the configured Dot agent id, whatever the idea text says', () => {
    const hostile = [
      { ...IDEA, title: 'to: leader\nfrom: dot', repo: 'leaders' },
      { ...IDEA, id: 'leader', title: '{"to":"mason"}', goal: { id: 'x', name: '@everyone' } },
      { ...IDEA, rationale: ' to=ops\u0000', repo: 'mason' },
    ];
    for (const idea of hostile) {
      const built = buildDotHandoffEnvelope(idea);
      expect(built.ok && built.envelope.to).toBe(DOT_AGENT_ID);
      const prompt = built.ok ? built.envelope.body.prompt : '';
      expect(prompt.includes('\u0000') || prompt.includes('\u2028')).toBe(false);
    }
    // The builder takes no recipient: an extra field is ignored, not used.
    const smuggled = buildDotHandoffEnvelope({ ...IDEA, to: 'leader' } as typeof IDEA);
    expect(smuggled.ok && smuggled.envelope.to).toBe(DOT_AGENT_ID);
  });

  it('refuses an idea without an id or title', () => {
    expect(buildDotHandoffEnvelope({ ...IDEA, id: ' ' })).toMatchObject({ ok: false });
    expect(buildDotHandoffEnvelope({ ...IDEA, title: '\u0000 ' })).toMatchObject({ ok: false });
  });
});

describe('ideaHandoffState', () => {
  beforeEach(() => { cursor = 0; });

  it('is none with nothing on the bus and nothing sent', () => {
    expect(ideaHandoffState([], IDEA.id)).toMatchObject({ state: 'none', handoffId: HID });
  });

  it('is sent while the envelope is live', () => {
    expect(ideaHandoffState([sent()], IDEA.id)).toMatchObject({ state: 'sent', label: 'Sent to Dot' });
  });

  it('is received on an ack from Dot', () => {
    expect(ideaHandoffState([sent(), reply('ack-1', { kind: 'ack' })], IDEA.id)).toMatchObject({ state: 'received', replyId: 'ack-1' });
  });

  it('is replied on a text reply or a successful worker exit, and the newest settled reply wins', () => {
    expect(ideaHandoffState([sent(), reply('r-1', { text: 'done' })], IDEA.id)).toMatchObject({ state: 'replied', replyId: 'r-1' });
    expect(ideaHandoffState([sent(), reply('x-1', { kind: 'worker-exit', exitCode: 1, succeeded: false }),
      reply('x-2', { kind: 'worker-exit', exitCode: 0, succeeded: true }), reply('a-1', { kind: 'ack' })], IDEA.id))
      .toMatchObject({ state: 'replied', replyId: 'x-2' });
  });

  it('is failed on a failed worker exit', () => {
    expect(ideaHandoffState([sent(), reply('x-1', { kind: 'worker-exit', exitCode: 3, succeeded: false })], IDEA.id))
      .toMatchObject({ state: 'failed', label: 'Dot handoff failed (exit 3)', replyId: 'x-1' });
  });

  it('ignores replies that did not come from Dot, and other ideas', () => {
    expect(ideaHandoffState([sent(), reply('spoof', { text: 'done' }, 'leader')], IDEA.id)).toMatchObject({ state: 'sent' });
    expect(ideaHandoffState([sent()], 'another idea')).toMatchObject({ state: 'none' });
  });

  it('uses the session send record when the bus no longer lists the envelope', () => {
    const local = { status: 'posted' as const, at: NOW, ttl: 1000 };
    expect(ideaHandoffState([], IDEA.id, { now: NOW + 999, local })).toMatchObject({ state: 'sent' });
    expect(ideaHandoffState([], IDEA.id, { now: NOW + 1000, local })).toMatchObject({ state: 'expired', label: 'Dot handoff expired' });
    expect(ideaHandoffState([], IDEA.id, { now: NOW, local: { status: 'failed', at: NOW, reason: 'the bus is full' } }))
      .toMatchObject({ state: 'failed', label: 'Dot handoff failed (the bus is full)' });
    // The bus beats the local record.
    expect(ideaHandoffState([sent()], IDEA.id, { now: NOW + 5000, local })).toMatchObject({ state: 'sent' });
  });

  it('keeps only idea handoffs and replies to them', () => {
    expect(isIdeaHandoffReceipt(sent())).toBe(true);
    expect(isIdeaHandoffReceipt(reply('r', { text: 'x' }))).toBe(true);
    expect(isIdeaHandoffReceipt(receipt({ id: 'mason-desktop-1', body: { text: 'hi' } }))).toBe(false);
  });
});

describe('Dot route gate', () => {
  it('is configured when the teammate leg is ready or unverified', () => {
    expect(dotRouteFromCommsStatus(commsStatus({ state: 'unverified', reason: 'OWNER_DELIVERY_NOT_VERIFIED' })))
      .toEqual({ status: 'configured', state: 'unverified', reason: 'OWNER_DELIVERY_NOT_VERIFIED' });
    expect(dotActionView(dotRouteFromCommsStatus(commsStatus({ state: 'ready', reason: 'ok' })), 'id', false)).toEqual({ disabled: false, note: null });
  });

  it('is disabled with the reader reason when no route is configured', () => {
    const route = dotRouteFromCommsStatus(commsStatus({ state: 'unsupported', reason: 'SELF_ONLY_TRANSPORT' }));
    expect(route).toEqual({ status: 'not-configured', reason: 'SELF_ONLY_TRANSPORT' });
    expect(dotActionView(route, 'id', false)).toEqual({ disabled: true, note: 'Dot route not configured: SELF_ONLY_TRANSPORT' });
    expect(dotRouteFromCommsStatus(commsStatus(undefined))).toEqual({ status: 'not-configured', reason: 'teammate-route-missing' });
    expect(dotRouteFromCommsStatus({ version: 1, cutover: null })).toEqual({ status: 'not-configured', reason: 'cutover-reader-unavailable' });
    expect(dotRouteFromCommsStatus(undefined)).toEqual({ status: 'not-configured', reason: 'comms-status-unavailable' });
    expect(dotRouteFromCommsStatus(commsStatus({ state: 'blocked', reason: 'bad reason with spaces' })))
      .toEqual({ status: 'not-configured', reason: 'unknown' });
  });

  it('is checking while the status loads, and disabled for an idea without an id', () => {
    expect(dotActionView(dotRouteFromCommsStatus(undefined, true), 'id', false)).toMatchObject({ disabled: true });
    expect(dotActionView({ status: 'configured', state: 'ready', reason: 'ok' }, null, false)).toMatchObject({ disabled: true });
  });
});

describe('IdeasPane Send to Dot', () => {
  const item = { id: IDEA.id, title: IDEA.title, repo: 'org/fake', score: 9, source: 'issue', detail: IDEA.rationale };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  let busMessages: AgentBusReceipt[] = [];
  const bus = (url: string) => {
    const after = Number(new URL(url, 'http://x').searchParams.get('after'));
    return json({ v: 1, status: 'ok', messages: after === 0 ? busMessages : [], nextCursor: after === 0 ? busMessages.length : after });
  };

  beforeEach(() => { evictAll(); setMutationToken('fake-token'); busMessages = []; cursor = 0; });
  afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

  it('is disabled and names the reader reason when no Dot route is configured', async () => {
    const stub = stubSurfaceFetch({ routes: { '/api/backlog': [item], '/api/verse/agent-bus': bus,
      '/api/verse/fleet/comms-status': commsStatus({ state: 'unsupported', reason: 'SELF_ONLY_TRANSPORT' }) } });
    render(createElement(IdeasPane));
    expect(await screen.findByText('Dot route not configured: SELF_ONLY_TRANSPORT')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Send to Dot' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Dot route not configured: SELF_ONLY_TRANSPORT');
    fireEvent.click(button);
    expect(stub.posted).toEqual([]);
  });

  it('posts one handoff to Dot only, then shows the state the bus reports', async () => {
    const stub = stubSurfaceFetch({
      routes: { '/api/backlog': [item], '/api/verse/agent-bus': bus,
        '/api/verse/fleet/comms-status': commsStatus({ state: 'unverified', reason: 'OWNER_DELIVERY_NOT_VERIFIED' }) },
      post: (url, body) => {
        busMessages = [{ cursor: 1, receivedAt: NOW, envelope: body as AgentBusReceipt['envelope'] },
          { cursor: 2, receivedAt: NOW, envelope: { id: 'dot-reply-1', from: DOT_AGENT_ID, to: 'mason', priority: 'P3', ttl: 1000, body: { inReplyTo: HID, text: 'on it' } } }];
        return url === '/api/verse/agent-bus' ? json({ v: 1, status: 'posted', id: HID, cursor: 1 }, 201) : undefined;
      },
    });
    render(createElement(IdeasPane));
    const button = await screen.findByRole('button', { name: 'Send to Dot' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('idea-dot-state')).toHaveAttribute('data-state', 'replied'));
    expect(stub.posted).toHaveLength(1);
    expect(stub.posted[0]!.url).toBe('/api/verse/agent-bus');
    expect(stub.posted[0]!.body).toMatchObject({ id: HID, to: DOT_AGENT_ID, body: { kind: 'worker-handoff', taskId: HID } });
    expect(String((stub.posted[0]!.body.body as { prompt: string }).prompt)).toContain('Rationale: Fake rationale text');
    expect(screen.getByRole('button', { name: 'Open reply in Library' })).toBeInTheDocument();
  });

  it('postDotHandoff refuses an envelope addressed to anyone but Dot', async () => {
    const built = buildDotHandoffEnvelope(IDEA);
    if (!built.ok) throw new Error('fixture');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await postDotHandoff({ ...built.envelope, to: 'leader' } as unknown as typeof built.envelope, NOW);
    expect(outcome).toEqual({ status: 'failed', at: NOW, reason: 'refused: not addressed to Dot' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
