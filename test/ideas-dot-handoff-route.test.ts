/**
 * RQ-PHX-DOTHANDOFFSEND97: the Ideas "Send to Dot" envelope goes through the
 * real agent-bus POST into a temp bus root. The test then reads the stored
 * file back and sends the same envelope through the handoff receiver's checks
 * and the bus reader. Fake ids only; nothing reads the real home directory.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { isFleetJobId } from '../src/core/fleet/runs-job-detail.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  buildDotHandoffEnvelope, DOT_AGENT_ID, ideaHandoffId, ideaHandoffState,
} from '../src/web-ui/routes/verse/ideas/idea-dot-handoff.js';

const PATH = '/api/verse/agent-bus';
const TOKEN = 'fake-token';
const IDEA = { id: '/fake/repo:goal-drift:f00d', title: 'Fake idea for Dot', repo: 'fake-org/fake-repo',
  rationale: 'Fake rationale', goal: { id: 'g-fake', name: 'Fake goal' } };

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function spool(): string { const dir = mkdtempSync(join(tmpdir(), 'ideas-dot-handoff-')); roots.push(dir); return dir; }

function handler(root: string) {
  return createAgentBusApi({ append: value => appendBusInbox(value, { root }),
    list: (after, limit) => listBusInboxAfter(after, limit, { root }), mirrorToInbox: async () => null });
}

async function call(api: ReturnType<typeof createAgentBusApi>, method: 'GET' | 'POST', url: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
  req.url = url;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN };
  let status = 0, wire: Record<string, unknown> = {};
  const res = { writeHead(code: number) { status = code; }, end(text: string) { wire = JSON.parse(text) as Record<string, unknown>; } } as unknown as ServerResponse;
  const ctx = { token: TOKEN, allowDispatch: true, readSession: { expiresAt: Date.now() + 60_000 } } as unknown as VerseApiContext;
  await api(ctx, req, res, url.split('?')[0]!, method);
  return { status, wire };
}

describe('Ideas Send to Dot through the real bus send path', () => {
  it('writes the handoff file with the correlation id, addressed to Dot, in the receiver schema', async () => {
    const root = spool();
    const api = handler(root);
    const built = buildDotHandoffEnvelope(IDEA);
    if (!built.ok) throw new Error(built.problem);
    const correlation = ideaHandoffId(IDEA.id);

    // The same canonical checks handoff-send applies before it appends.
    expect(validateBusEnvelope(built.envelope).ok).toBe(true);
    expect(isFleetJobId(built.envelope.body.taskId)).toBe(true);

    expect(await call(api, 'POST', PATH, built.envelope)).toMatchObject({ status: 201, wire: { status: 'posted', id: correlation } });
    // A second click dedupes on the correlation id instead of sending twice.
    expect(await call(api, 'POST', PATH, built.envelope)).toMatchObject({ status: 200, wire: { status: 'duplicate', id: correlation } });

    const stored = JSON.parse(readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8')) as unknown;
    const text = JSON.stringify(stored);
    expect(text).toContain(correlation);
    const page = listBusInboxAfter(0, 100, { root });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') return;
    expect(page.messages).toHaveLength(1);
    const envelope = page.messages[0]!.envelope;
    expect(envelope).toMatchObject({ id: correlation, from: 'mason', to: DOT_AGENT_ID, priority: 'P3' });
    // Exactly the body handoff-receive/handoff-reply accept: { kind, taskId, prompt }.
    expect(envelope.body).toEqual({ kind: 'worker-handoff', taskId: correlation, prompt: expect.stringContaining(`Correlation id: ${correlation}`) });
    const prompt = (envelope.body as { prompt: string }).prompt;
    for (const part of ['Idea: Fake idea for Dot', 'Rationale: Fake rationale', 'Goal: Fake goal']) expect(prompt).toContain(part);
  });

  it('reads the state back through the bus reader: sent, then replied from Dot only', async () => {
    const root = spool();
    const api = handler(root);
    const built = buildDotHandoffEnvelope(IDEA);
    if (!built.ok) throw new Error(built.problem);
    const correlation = ideaHandoffId(IDEA.id);
    await call(api, 'POST', PATH, built.envelope);

    const read = async () => {
      const got = await call(api, 'GET', `${PATH}?after=0&limit=100`);
      expect(got.status).toBe(200);
      return got.wire.messages as Parameters<typeof ideaHandoffState>[0];
    };
    expect(ideaHandoffState(await read(), IDEA.id)).toMatchObject({ state: 'sent', handoffId: correlation });

    // A non-Dot sender cannot settle the idea.
    appendBusInbox({ id: 'fake-spoof-1', from: 'fake-other-agent', to: 'mason', priority: 'P3', ttl: 60_000,
      body: { inReplyTo: correlation, kind: 'worker-exit', exitCode: 0, succeeded: true } }, { root });
    expect(ideaHandoffState(await read(), IDEA.id)).toMatchObject({ state: 'sent' });

    // The worker-exit reply handoff-reply publishes, routed Dot -> sender.
    appendBusInbox({ id: 'fake-dot-exit-1', from: DOT_AGENT_ID, to: 'mason', priority: 'P3', ttl: 60_000,
      body: { inReplyTo: correlation, kind: 'worker-exit', exitCode: 0, succeeded: true } }, { root });
    expect(ideaHandoffState(await read(), IDEA.id)).toMatchObject({ state: 'replied', replyId: 'fake-dot-exit-1' });
  });
});
