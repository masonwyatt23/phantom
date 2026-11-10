/**
 * POST/GET /api/verse/fleet/runs/channel-test (RQ-PHX-CHANNELTESTSEND97):
 * the Channels pane "Test round trip" route. Fake ids, a fake transport, a
 * throwaway runs dir — nothing touches a real channel, config or home.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerDelivery, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import type { OwnerThreadMessage } from '../src/core/comms/owner-thread.js';
import {
  CHANNEL_TEST_COOLDOWN_MS,
  CHANNEL_TEST_TEXT,
  createChannelTestSendApi,
  VERSE_CHANNEL_TEST_SEND_PATH as PATH,
} from '../src/core/web/channel-test-send.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const TOKEN = 't'.repeat(64);
const T = Date.parse('2026-11-10T12:00:00Z');
/** The verified Mason id — the only recipient the transport may ever see. */
const OWNER = '7654321';
const CORRELATION = 'fake-correlation-id-01';

function baseSettings(overrides: Partial<OwnerThreadSettings> = {}): OwnerThreadSettings {
  return {
    owners: { desktop: OWNER },
    secretHandles: {},
    imessageBridge: 'off',
    confirmed: true,
    team: [{ channel: 'bus', id: OWNER }],
    ...overrides,
  };
}

function setup(opts: {
  settings?: OwnerThreadSettings;
  transports?: Partial<Record<'desktop', { pull(): Promise<never[]>; deliver(input: OwnerDelivery): Promise<{ status: 'sent' | 'duplicate' | 'refused'; reason: string }> }>>;
  thread?: OwnerThreadMessage[];
  halted?: boolean;
  now?: number;
} = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'phm-channel-test-'));
  const deliver = vi.fn(async (_input: OwnerDelivery) => ({ status: 'sent' as const, reason: 'ok' }));
  const api = createChannelTestSendApi({
    runsDir,
    settings: () => opts.settings ?? baseSettings(),
    transports: () => opts.transports === undefined ? { desktop: { pull: async () => [], deliver } } : opts.transports,
    thread: () => opts.thread ?? [],
    halted: () => opts.halted ?? false,
    paused: () => false,
    now: () => opts.now ?? T,
    mintId: () => CORRELATION,
  });
  return { api, deliver, runsDir };
}

interface CallResult { handled: boolean; status: number; body: Record<string, unknown> | null }

async function call(
  api: ReturnType<typeof createChannelTestSendApi>,
  opts: {
    method?: string;
    body?: unknown;
    token?: string;
    contentType?: string;
    allowDispatch?: boolean;
    path?: string;
  } = {},
): Promise<CallResult> {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? PATH;
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), {
    url: path, method,
    headers: {
      ...(opts.token === null ? {} : { 'x-ashlr-token': opts.token ?? TOKEN }),
      'content-type': opts.contentType ?? 'application/json',
      host: 'localhost',
    },
  }) as unknown as IncomingMessage;
  req.end(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {}));
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() {},
    end(b?: string) { text = b ?? ''; },
  } as unknown as ServerResponse;
  const ctx = { cfg: {}, allowDispatch: opts.allowDispatch ?? true, token: TOKEN } as VerseApiContext;
  const handled = await api(ctx, req, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('channel test-send route', () => {
  it('does not claim other paths', async () => {
    const { api } = setup();
    let status = 0;
    const res = { writeHead(c: number) { status = c; return this; }, end() {} } as unknown as ServerResponse;
    const req = Object.assign(new PassThrough(), { method: 'POST', headers: {} }) as unknown as IncomingMessage;
    req.end('{}');
    expect(await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, '/api/verse/fleet/runs', 'POST')).toBe(false);
    expect(status).toBe(0);
  });

  it('405 on methods that are neither GET nor POST', async () => {
    const { api } = setup();
    expect((await call(api, { method: 'DELETE' })).status).toBe(405);
    expect((await call(api, { method: 'PUT' })).status).toBe(405);
  });

  it('404 when dispatch is disabled, for both methods', async () => {
    const { api, deliver } = setup();
    expect((await call(api, { allowDispatch: false, method: 'GET' })).status).toBe(404);
    expect((await call(api, { allowDispatch: false, body: { channel: 'desktop' } })).status).toBe(404);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('401 without the console token — the existing mutation gate', async () => {
    const { api, deliver } = setup();
    expect((await call(api, { body: { channel: 'desktop' }, token: 'wrong' })).status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('415 on a non-JSON body — the CSRF half of the mutation gate', async () => {
    const { api, deliver } = setup();
    expect((await call(api, { body: '{"channel":"desktop"}', contentType: 'text/plain' })).status).toBe(415);
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', 'nope'],
    ['array', []],
    ['empty object', {}],
    ['unknown channel', { channel: 'page' }],
    ['non-owner channel', { channel: 'mobile' }],
    ['extra recipient', { channel: 'desktop', to: '+15555550100' }],
    ['extra owner key', { channel: 'desktop', ownerId: '+15555550100' }],
  ])('400 on %s', async (_name, body) => {
    const { api, deliver } = setup();
    expect((await call(api, { body })).status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('403 refused when no verified Mason id is configured', async () => {
    const { api, deliver } = setup({ settings: baseSettings({ owners: {} }) });
    const r = await call(api, { body: { channel: 'desktop' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ v: 1, status: 'refused', reason: 'Disabled until an owner identity is configured.' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('403 refused when no live transport is attached', async () => {
    const { api } = setup({ transports: {} });
    const r = await call(api, { body: { channel: 'desktop' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ v: 1, status: 'refused', reason: 'No live transport is attached for this channel.' });
  });

  it('403 refused when Mason confirmation is not set', async () => {
    const { api, deliver } = setup({ settings: baseSettings({ confirmed: false }) });
    const r = await call(api, { body: { channel: 'desktop' } });
    expect(r.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('403 refused when the kill switch is engaged', async () => {
    const { api, deliver } = setup({ halted: true });
    const r = await call(api, { body: { channel: 'desktop' } });
    expect(r.status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('sends exactly the leader line to the verified Mason id and records the pending entry', async () => {
    const { api, deliver, runsDir } = setup();
    const r = await call(api, { body: { channel: 'desktop' } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, status: 'sent', channel: 'desktop', sentAtMs: T, correlationId: CORRELATION });
    expect(deliver).toHaveBeenCalledTimes(1);
    const input = deliver.mock.calls[0]![0];
    expect(input).toEqual({ idempotencyKey: `channel-test-${CORRELATION}`, text: CHANNEL_TEST_TEXT, ownerId: OWNER });
    expect(input.text).toBe('Leader is live here, reply to talk to me');
    const stored = JSON.parse(readFileSync(join(runsDir, 'leader', 'channel-tests.json'), 'utf8')) as { v: number; tests: Record<string, { sentAt: number; correlationId: string }> };
    expect(stored).toEqual({ v: 1, tests: { desktop: { sentAt: T, correlationId: CORRELATION } } });
  });

  it('refuses a second send inside the five-minute window, then allows it after', async () => {
    const { api, deliver } = setup();
    expect((await call(api, { body: { channel: 'desktop' } })).status).toBe(200);
    const again = await call(api, { body: { channel: 'desktop' } });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ v: 1, status: 'rate-limited', retryAfterMs: CHANNEL_TEST_COOLDOWN_MS });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('does not record a pending entry when the transport refuses', async () => {
    const deliver = vi.fn(async (_input: OwnerDelivery) => ({ status: 'refused' as const, reason: 'no' }));
    const { api, runsDir } = setup({ transports: { desktop: { pull: async () => [], deliver } } });
    const r = await call(api, { body: { channel: 'desktop' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ v: 1, status: 'refused' });
    const state = await call(api, { method: 'GET' });
    const channels = state.body!.channels as Record<string, Record<string, unknown>>;
    expect(channels.desktop!.sentAtMs).toBeNull();
    expect(() => readFileSync(join(runsDir, 'leader', 'channel-tests.json'), 'utf8')).toThrow();
  });

  it('GET reports the pending entry, the channel-scoped inbound times, and the send gate', async () => {
    const inbound: OwnerThreadMessage[] = [
      { seq: 1, id: 'm1', idempotencyKey: 'k1', channel: 'desktop', senderId: OWNER, direction: 'inbound', at: new Date(T + 60_000).toISOString(), text: 'fake reply' },
      { seq: 2, id: 'm2', idempotencyKey: 'k2', channel: 'telegram', senderId: '999', direction: 'inbound', at: new Date(T + 120_000).toISOString(), text: 'other channel' },
    ];
    const { api } = setup({ thread: inbound });
    await call(api, { body: { channel: 'desktop' } });
    const r = await call(api, { method: 'GET' });
    expect(r.status).toBe(200);
    const channels = r.body!.channels as Record<string, Record<string, unknown>>;
    expect(channels.desktop).toMatchObject({
      sentAtMs: T,
      correlationId: CORRELATION,
      inbound: [T + 60_000],
      sendable: { enabled: true },
    });
    expect(channels.telegram!.inbound).toEqual([T + 120_000]);
    expect(channels.email!.sendable).toMatchObject({ enabled: false, reason: 'Disabled until the Phantom Secrets handle is named.' });
  });
});
