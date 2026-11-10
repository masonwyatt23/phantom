/**
 * POST/GET /api/verse/fleet/runs/channel-test (RQ-PHX-CHANNELTESTSEND97).
 *
 * The Channels pane's "Test round trip" action. POST sends exactly
 * CHANNEL_TEST_TEXT through one channel's existing owner transport, addressed
 * only to that channel's verified Mason identity — the body names a channel,
 * never a recipient — and records a pending round-trip entry carrying a
 * correlation id. GET reports each owner channel's pending entry, the inbound
 * owner times the existing intake already logged, and the send gate a row's
 * disabled state needs. One send per channel per CHANNEL_TEST_COOLDOWN_MS.
 *
 * Same gates as the other console mutations: 404 unless allowDispatch, then
 * the shared token + JSON Content-Type gate. Owner ids, times and the
 * correlation id are the only fields that leave the process; message bodies
 * never do.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { checkSendPolicy } from '../agents/channel-policy.js';
import { isOwnerChannel, ownerChannelToBus, OWNER_CHANNELS, type OwnerChannel } from '../comms/leader-mailbox.js';
import {
  adapterStatus,
  fixedOwnerConfigDir,
  fixedOwnerRunsDir,
  loadOwnerThreadSettings,
  type OwnerChannelTransport,
  type OwnerThreadSettings,
} from '../comms/owner-channel.js';
import { liveOwnerTransports } from '../comms/owner-live-transport.js';
import { readOwnerThread, type OwnerThreadMessage, type OwnerThreadOptions } from '../comms/owner-thread.js';
import { isPaused } from '../comms/pause.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import type { ApiModule } from '../verse/api-modules.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { passesMutationGate, readBody, sendJson } from './api.js';

export const VERSE_CHANNEL_TEST_SEND_PATH = '/api/verse/fleet/runs/channel-test';
/**
 * The exact probe text Mason asked for (t1627u). It is NOT OWNER_HELLO_TEXT —
 * that greeting carries a trailing period this line deliberately drops.
 */
export const CHANNEL_TEST_TEXT = 'Leader is live here, reply to talk to me';
/** One recorded send per channel inside this window refuses the next. */
export const CHANNEL_TEST_COOLDOWN_MS = 5 * 60 * 1000;
const INBOUND_TIMES_CAP = 50;

interface ChannelTestEntry { sentAt: number; correlationId: string }
type ChannelTestMap = Partial<Record<OwnerChannel, ChannelTestEntry>>;

export interface ChannelTestSendDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
  /** Default: the fixed owner config dir. */
  configDir?: string;
  /** Settings seam; default reloads owner config per request so revocations apply. */
  settings?: () => OwnerThreadSettings;
  /** Transport seam; tests never touch a real channel. */
  transports?: (settings: OwnerThreadSettings, runsDir: string) => Partial<Record<OwnerChannel, OwnerChannelTransport>>;
  /** Owner-thread seam; default is the durable thread read. */
  thread?: (options: OwnerThreadOptions) => OwnerThreadMessage[];
  halted?: () => boolean;
  paused?: () => boolean;
  now?: () => number;
  /** Correlation-id mint; a fresh UUID per send by default. */
  mintId?: () => string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function testsFile(runsDir: string): string {
  return join(runsDir, 'leader', 'channel-tests.json');
}

function validEntry(value: unknown): value is ChannelTestEntry {
  return record(value) && Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.sentAt) && (value.sentAt as number) >= 0 &&
    typeof value.correlationId === 'string' && value.correlationId.length >= 8 && value.correlationId.length <= 80;
}

/** Latest pending entry per channel. Missing file is an empty map; a corrupt one throws. */
function readChannelTests(runsDir: string): ChannelTestMap {
  const file = testsFile(runsDir);
  try { lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Channel test store unavailable');
  }
  const directory = join(runsDir, 'leader');
  const result = readStableRegularFile(file, { anchorPath: directory, maxFileBytes: 64 * 1024, remainingBytes: 64 * 1024 });
  if (!result.ok) throw new Error('Channel test store unavailable');
  const parsed: unknown = JSON.parse(result.text);
  if (!record(parsed) || parsed.v !== 1 || !record(parsed.tests)) throw new Error('Channel test store unavailable');
  const out: ChannelTestMap = {};
  for (const [channel, entry] of Object.entries(parsed.tests)) {
    if (!isOwnerChannel(channel) || !validEntry(entry)) throw new Error('Channel test store unavailable');
    out[channel] = { sentAt: entry.sentAt, correlationId: entry.correlationId };
  }
  return out;
}

function writeChannelTests(runsDir: string, tests: ChannelTestMap): void {
  const directory = join(runsDir, 'leader');
  ensurePrivateDirectory(runsDir);
  ensurePrivateDirectory(directory);
  writePrivateFileAtomically(join(directory, `.${randomUUID()}.tmp`), testsFile(runsDir), JSON.stringify({ v: 1, tests }), {
    anchorPath: directory, label: 'Channel test store',
  });
}

/** Inbound owner times (epoch-ms, ascending) per channel from the durable thread. */
function inboundByChannel(messages: readonly OwnerThreadMessage[]): Record<OwnerChannel, number[]> {
  const grouped: Record<OwnerChannel, number[]> = { desktop: [], telegram: [], email: [], imessage: [], slack: [] };
  for (const message of messages) {
    if (message.direction !== 'inbound' || !isOwnerChannel(message.channel)) continue;
    const at = Date.parse(message.at);
    if (Number.isSafeInteger(at) && at >= 0) grouped[message.channel].push(at);
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => a - b);
    if (list.length > INBOUND_TIMES_CAP) list.splice(0, list.length - INBOUND_TIMES_CAP);
  }
  return grouped;
}

interface SendGate { enabled: boolean; reason: string }

/** The one decision both halves share: verified owner + confirmed policy + live transport. */
function sendGate(
  channel: OwnerChannel,
  settings: OwnerThreadSettings,
  transports: Partial<Record<OwnerChannel, OwnerChannelTransport>>,
  halted: boolean,
  paused: boolean,
): SendGate {
  const gate = adapterStatus(channel, settings, halted, paused);
  if (!gate.enabled) return { enabled: false, reason: gate.reason };
  const ownerId = settings.owners[channel];
  if (!ownerId) return { enabled: false, reason: 'Disabled until an owner identity is configured.' };
  if (!transports[channel]) return { enabled: false, reason: 'No live transport is attached for this channel.' };
  const policy = checkSendPolicy({
    channel: ownerChannelToBus(channel), recipients: [ownerId], teamIdentities: settings.team,
    external: false, confirmedByMason: settings.confirmed,
  });
  if (policy.status !== 'sent') return { enabled: false, reason: policy.reason };
  if (!settings.team.some(identity => identity.channel === ownerChannelToBus(channel) && identity.id === ownerId)) {
    return { enabled: false, reason: 'Recipient is not an explicitly allowlisted team identity.' };
  }
  return { enabled: true, reason: 'Verified owner and live transport.' };
}

function runtime(deps: ChannelTestSendDeps): { runsDir: string; settings: OwnerThreadSettings; transports: Partial<Record<OwnerChannel, OwnerChannelTransport>>; thread: OwnerThreadMessage[] } {
  const runsDir = deps.runsDir ?? fixedOwnerRunsDir();
  const settings = (deps.settings ?? (() => loadOwnerThreadSettings(deps.configDir ?? fixedOwnerConfigDir())))();
  const transports = (deps.transports ?? ((s, dir) => liveOwnerTransports(s, dir)))(settings, runsDir);
  const options: OwnerThreadOptions = { runsDir, settings, ...(deps.now ? { now: deps.now } : {}) };
  const thread = deps.thread ? deps.thread(options) : readOwnerThread(options).messages;
  return { runsDir, settings, transports, thread };
}

function parsePostBody(raw: string): { channel: OwnerChannel } | null {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!record(body) || Object.keys(body).length !== 1 || typeof body.channel !== 'string' || !isOwnerChannel(body.channel)) return null;
  return { channel: body.channel };
}

/** The latest inbound ref on this channel, for transports that need a thread to answer in (Slack DM). */
function lastChannelRef(thread: readonly OwnerThreadMessage[], channel: OwnerChannel): string | undefined {
  for (let index = thread.length - 1; index >= 0; index--) {
    const message = thread[index]!;
    if (message.direction === 'inbound' && message.channel === channel && message.channelRef) return message.channelRef;
  }
  return undefined;
}

export function createChannelTestSendApi(deps: ChannelTestSendDeps = {}): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_CHANNEL_TEST_SEND_PATH) return false;
    if (method !== 'GET' && method !== 'POST') {
      sendJson(res, 405, { error: 'Use GET for state or POST to send a channel test.' });
      return true;
    }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    const now = (deps.now ?? Date.now)();
    const halted = (deps.halted ?? killSwitchOn)();
    const paused = (deps.paused ?? isPaused)();

    if (method === 'GET') {
      try {
        const { runsDir, settings, transports, thread } = runtime(deps);
        const tests = readChannelTests(runsDir);
        const inbound = inboundByChannel(thread);
        const channels: Record<string, unknown> = {};
        for (const channel of OWNER_CHANNELS) {
          const entry = tests[channel] ?? null;
          channels[channel] = {
            sentAtMs: entry?.sentAt ?? null,
            correlationId: entry?.correlationId ?? null,
            inbound: inbound[channel],
            sendable: sendGate(channel, settings, transports, halted, paused),
          };
        }
        sendJson(res, 200, { v: 1, channels });
      } catch { sendJson(res, 503, { code: 'CHANNEL_TEST_UNAVAILABLE' }); }
      return true;
    }

    if (!passesMutationGate(req, res, ctx.token)) return true;
    let raw: string;
    try { raw = await readBody(req); } catch { sendJson(res, 413, { error: 'Request body too large.' }); return true; }
    const input = parsePostBody(raw);
    if (!input) { sendJson(res, 400, { v: 1, status: 'invalid' }); return true; }
    const { channel } = input;
    try {
      const { runsDir, settings, transports, thread } = runtime(deps);
      const gate = sendGate(channel, settings, transports, halted, paused);
      if (!gate.enabled) { sendJson(res, 403, { v: 1, status: 'refused', reason: gate.reason }); return true; }
      const ownerId = settings.owners[channel]!;
      const directory = join(runsDir, 'leader');
      ensurePrivateDirectory(runsDir);
      ensurePrivateDirectory(directory);
      const acquired = acquireLocalStoreLockWithOutcome(join(directory, 'channel-tests.lock'), 0, { anchorPath: directory });
      if (acquired.state !== 'acquired') { sendJson(res, 503, { v: 1, status: 'unavailable', reason: 'Channel test store is busy.' }); return true; }
      try {
        const tests = readChannelTests(runsDir);
        const last = tests[channel];
        if (last && last.sentAt > now - CHANNEL_TEST_COOLDOWN_MS) {
          sendJson(res, 429, { v: 1, status: 'rate-limited', retryAfterMs: Math.max(0, CHANNEL_TEST_COOLDOWN_MS - (now - last.sentAt)), reason: 'One test per channel per five minutes.' });
          return true;
        }
        const correlationId = (deps.mintId ?? randomUUID)();
        const channelRef = lastChannelRef(thread, channel);
        const result = await transports[channel]!.deliver({
          idempotencyKey: `channel-test-${correlationId}`.slice(0, 80),
          text: CHANNEL_TEST_TEXT,
          ownerId,
          ...(channelRef ? { channelRef } : {}),
        });
        if (result.status !== 'sent' && result.status !== 'duplicate') {
          sendJson(res, 403, { v: 1, status: 'refused', reason: 'Channel transport refused the test send.' });
          return true;
        }
        tests[channel] = { sentAt: now, correlationId };
        writeChannelTests(runsDir, tests);
        sendJson(res, 200, { v: 1, status: 'sent', channel, sentAtMs: now, correlationId });
        return true;
      } finally { releaseLocalStoreLock(acquired.lock); }
    } catch { sendJson(res, 503, { v: 1, status: 'unavailable' }); }
    return true;
  };
}

export const handleChannelTestSendApi: ApiModule = createChannelTestSendApi();
