/**
 * RQ-PHX-TGSTATUSTEXT143 — a plain "Phantom status" text on Telegram gets the
 * same five-line owner digest Slack answers with (owner-status-reply.ts).
 *
 * Module under test: src/core/comms/telegram-inbox-bridge.ts.
 *
 * A verified Mason text that satisfies isOwnerStatusRequest — and is not the
 * /fleet-status slash command — is answered on the same chat as a reply to
 * the inbound message, and is not recorded to MASON-INBOX (a question
 * answered, not work queued). The composer is an injected seam: the real
 * composeOwnerStatusReply reads fleet state and GitHub release facts, so
 * these tests fake it; send is a fake transport — no network, no gh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTelegramToInbox } from '../src/core/comms/telegram-inbox-bridge.js';
import type { InboundEvent, TelegramSendOpts, TelegramSendResult } from '../src/core/integrations/telegram.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { AshlrConfig } from '../src/core/types.js';

const OWNER = 1234567;
const CHAT = String(OWNER);
const AT = new Date('2026-11-11T15:30:00.000Z');
const DIGEST = [
  'Phantom status, 10:30 ET',
  'App: installed 1.2.3 · published 1.2.3 · up to date',
  'Merges: 1 in the last hour · 4 in the last 24h',
  'Lanes: devin 3/6',
  'Needs Mason: none waiting',
  'Top P0: none in the inbox',
].join('\n');

function cfg(): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-status-143', chatId: CHAT } } } as AshlrConfig;
}

function textEvent(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    updateId: 1, kind: 'text', text: 'Phantom status', fromChatId: CHAT,
    senderUserId: OWNER, privateChat: true, messageId: 55, ...over,
  };
}

type FakeSend = ReturnType<typeof vi.fn<(text: string, opts?: TelegramSendOpts, cfg?: AshlrConfig) => Promise<TelegramSendResult>>>;
type FakeCompose = ReturnType<typeof vi.fn<(runsDir: string, now: Date) => Promise<string>>>;

let runsDir = '';
let send: FakeSend;
let composeStatus: FakeCompose;

const inboxPath = () => join(runsDir, 'leader', 'MASON-INBOX.md');

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'tg-status-text-'));
  send = vi.fn(async (): Promise<TelegramSendResult> => ({ ok: true, messageId: 9000 }));
  composeStatus = vi.fn(async () => DIGEST);
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

describe('plain owner status ask on Telegram', () => {
  it.each(['Phantom status', 'status', '/status'])('verified Mason %j: one digest reply, no inbox write', async text => {
    const result = await recordTelegramToInbox(textEvent(), text, cfg(), { send, runsDir, now: () => AT, composeStatus });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });

    expect(composeStatus).toHaveBeenCalledTimes(1);
    expect(composeStatus).toHaveBeenCalledWith(runsDir, AT);

    expect(send).toHaveBeenCalledTimes(1);
    const [body, opts, passedCfg] = send.mock.calls[0]!;
    expect(body).toBe(DIGEST);
    expect(opts).toEqual({ replyToMessageId: 55 });
    expect(passedCfg).toEqual(cfg());
    expect(existsSync(inboxPath())).toBe(false);
  });

  it('/fleet-status keeps the fleet projection and never calls the status composer', async () => {
    const runsState: FleetRunsDirState = {
      v: 1, generatedAt: AT.toISOString(), runsDirPresent: true, sourceState: 'healthy',
      sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
      lastTick: '2026-11-11T15:29:00.000Z', paused: false, memFreePct: 60, diskFreeGb: 100,
      lanes: [], switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [],
      drop: { pending: [], done: 0 },
    };
    const workers: LiveWorkersSnapshot = { v: 1, generatedAt: AT.toISOString(), sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 };
    const result = await recordTelegramToInbox(textEvent(), '/fleet-status', cfg(), {
      send, runsDir, now: () => AT, composeStatus,
      readRuns: async () => runsState,
      readWorkers: async () => workers,
      readSupply: async () => { throw new Error('no supply fixture'); },
      readQuota: () => [],
    });
    expect(result).toEqual({ ok: false, reason: 'status-replied' });
    expect(composeStatus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const [body, opts] = send.mock.calls[0]!;
    expect(body).toContain(`Fleet status at ${AT.toISOString()}`);
    expect(opts).toEqual({ replyToMessageId: 55 });
    expect(existsSync(inboxPath())).toBe(false);
  });

  it('a long ask containing "status" stays on the ordinary inbox path', async () => {
    const text = 'status of PR #12 and the updater feed, please look at both today';
    const result = await recordTelegramToInbox(textEvent(), text, cfg(), { send, runsDir, now: () => AT, composeStatus });
    expect(result).toMatchObject({ ok: true, ack: { channel: 'telegram', status: 'accepted' } });
    expect(composeStatus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toContain(`Inbox: ${text.slice(0, 60)}`);
    expect(readFileSync(inboxPath(), 'utf8')).toContain(text);
  });

  it('send failure: status-send-failed, no throw', async () => {
    send.mockResolvedValue({ ok: false });
    const result = await recordTelegramToInbox(textEvent(), 'Phantom status', cfg(), { send, runsDir, now: () => AT, composeStatus });
    expect(result).toEqual({ ok: false, reason: 'status-send-failed' });
    expect(composeStatus).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(existsSync(inboxPath())).toBe(false);
  });

  it.each([
    { name: 'missing senderUserId', over: { senderUserId: undefined } },
    { name: 'not a private chat', over: { privateChat: false } },
    { name: 'foreign sender id', over: { senderUserId: 7654321 } },
  ])('unverified/foreign "status" ($name): no compose, no send', async ({ over }) => {
    const result = await recordTelegramToInbox(textEvent(over), 'status', cfg(), { send, runsDir, now: () => AT, composeStatus });
    expect(result).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(composeStatus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(inboxPath())).toBe(false);
  });
});
