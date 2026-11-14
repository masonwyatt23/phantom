import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LEADER_BRIDGE_ID } from '../agents/leader-network.js';
import type { LeaderRuntimeOptions } from '../agents/leader-network-runtime.js';
import { configuredSlackCall, readSlackDeliveryPolicy } from '../agents/slack-leader.js';
import { parseSlackThreadRef, type ParsedSlackThreadRef } from '../agents/slack-network.js';
import { deliverSlackEnvelope, type SlackCall } from '../agents/slack-transport.js';
import { readEmailDropConfig } from '../comms/email-drop-config.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';
import { postLeaderMessage } from '../vision/leader-thread.js';
import { validateBusEnvelope } from './bus-envelope.js';
import { appendBusInbox } from './bus-inbox.js';
import { CHANNEL_BUS_TTL_MS } from './channel-bus-publish.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';
import type { OrderTraceV1 } from './order-trace.js';

export interface OrderMergeNotice { key: string; entryId: string; jobId: string; channel: string; text: string;
  /** Leader-network request id when the order came from a legacy heading; lets a sender bind its own durable route. */
  requestId?: string }
export type OrderMergeNoticeSenders = Partial<Record<string, (notice: OrderMergeNotice) => Promise<void>>>;

export function orderSourceRoute(source: string): { channel: string; entryId: string } | null {
  const match = /^([a-z0-9._-]{1,32}) \(([A-Za-z0-9._:-]{1,64})\)$/.exec(source);
  return match ? { channel: match[1]!, entryId: match[2]! } : null;
}

const REQUEST_ID = /^[0-9a-f]{64}$/;
const CHANNEL_SLUG = /^[a-z0-9._-]{1,32}$/;
/** Legacy headings (e.g. `(Operator, slack)`) have no `channel (entryId)`
 * route but carry the leader-network request id, which is a durable identity
 * for the same channel's own route record. The derived entry id keeps the
 * `${entryId}:${jobId}` ledger key so each job's notice is still sent once. */
function orderRequestRoute(order: { source: string; requestId?: string }): { channel: string; entryId: string; requestId: string } | null {
  if (typeof order.requestId !== 'string' || !REQUEST_ID.test(order.requestId) || !CHANNEL_SLUG.test(order.source)) return null;
  return { channel: order.source, entryId: `ln-${order.requestId.slice(0, 24)}`, requestId: order.requestId };
}

export function planOrderMergeNotices(trace: OrderTraceV1, sent: ReadonlySet<string>): OrderMergeNotice[] {
  const seen = new Set(sent);
  const notices: OrderMergeNotice[] = [];
  for (const order of trace.orders) {
    const route = orderSourceRoute(order.source) ?? orderRequestRoute(order);
    if (!route) continue;
    for (const job of order.jobs) {
      if (job.state !== 'merged') continue;
      for (const channel of new Set([route.channel, ...(order.alsoChannels ?? [])])) {
        const key = `${route.entryId}:${job.id}${channel === route.channel ? '' : `:${channel}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        notices.push({ ...route, channel, key, jobId: job.id,
          text: scrubSecrets(`Merged: ${job.id} for your ${order.key} order${job.url ? ` (${job.url})` : ''}.`).slice(0, 200) });
      }
    }
  }
  return notices;
}

/** Malformed rows are ignored; skipped routes are terminal just like successful sends. */
export function readOrderNoticeLedger(root: string): Set<string> {
  let text: string;
  try { text = readFileSync(join(root, 'queue', 'order-notices.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && 'key' in row && typeof row.key === 'string'
        && 'status' in row && (row.status === 'sent' || row.status === 'skipped')) seen.add(row.key);
    } catch { /* Partial or malformed rows do not prevent retries. */ }
  }
  return seen;
}

const postBusNotice = async (notice: OrderMergeNotice): Promise<void> => {
  const id = createHash('sha256').update(notice.key).digest('hex').slice(0, 32);
  const result = appendBusInbox({ id: `order-merged-${id}`, from: 'planner', to: 'mason', priority: 'P2',
    ttl: 7 * 24 * 60 * 60 * 1000, body: { kind: 'order-merged', channel: notice.channel, text: notice.text } });
  if (result.status !== 'posted' && result.status !== 'duplicate') throw new Error('bus unavailable');
};

/**
 * Queues the notice as a `*.reply.eml` in the email-drop outbox; delivery (and
 * its recipient allowlist) stays with `ashlr fleet email-outbox --send`.
 * Throws unless the saved config names exactly one allowed sender, so the
 * notice is counted failed and retried instead of being marked skipped.
 */
export function createEmailNoticeSender(runsDir: string = join(homedir(), '.ashlr-runs')): (notice: OrderMergeNotice) => Promise<void> {
  return async notice => {
    const { config } = await readEmailDropConfig(runsDir);
    if (!config || config.from.length !== 1) throw new Error('email-drop config needs exactly one allowed sender');
    const outbox = config.outboxDir ?? join(config.inboxDir, '..', 'outbox');
    ensurePrivateDirectory(outbox);
    const name = `order-merged-${createHash('sha256').update(notice.key).digest('hex').slice(0, 32)}.reply.eml`;
    const tmp = join(outbox, `.${name}.${process.pid}.tmp`);
    const text = notice.text.replace(/[\r\n]+/g, ' ');
    try {
      writeFileSync(tmp, `To: ${config.from[0]}\r\nSubject: Phantom: merged for your order\r\n\r\n${text}\r\n`, { mode: 0o600 });
      renameSync(tmp, join(outbox, name));
    } catch (error) { rmSync(tmp, { force: true }); throw error; }
  };
}

const NETWORK_STATE_MAX_BYTES = 8 * 1024 * 1024;
/** The same request-key formula leader-network.ts computes for route keys:
 * sha256 of the JSON [channel, envelope.id] pair, recomputed so a stored
 * route must prove it owns the request id. */
const leaderRequestKey = (channel: string, envelopeId: string): string =>
  createHash('sha256').update(JSON.stringify([channel, envelopeId])).digest('hex');

/** requestId → its Slack thread ref, from the durable leader-network route
 * state at `<runsDir>/leader/network-state.json`. Read-only: takes no lock,
 * writes nothing. A missing file, an unreadable state or a route that cannot
 * recompute the request id resolves nothing rather than guessing a thread
 * from timing. */
function slackOrderThreadBinding(runsDir: string, requestId: string): { channelRef: string; ref: ParsedSlackThreadRef } | undefined {
  let routes: Record<string, unknown> = {};
  try {
    const text = readFileSync(join(runsDir, 'leader', 'network-state.json'), 'utf8');
    if (Buffer.byteLength(text, 'utf8') <= NETWORK_STATE_MAX_BYTES) {
      const state = JSON.parse(text) as { version?: unknown; routes?: unknown };
      if (state.version === 1 && state.routes !== null && typeof state.routes === 'object' && !Array.isArray(state.routes)) {
        routes = state.routes as Record<string, unknown>;
      }
    }
  } catch { return undefined; }
  if (!Object.hasOwn(routes, requestId)) return undefined;
  const route = routes[requestId];
  if (route === null || typeof route !== 'object' || Array.isArray(route)) return undefined;
  const record = route as { channel?: unknown; channelRef?: unknown; message?: unknown };
  if (record.channel !== 'slack' || typeof record.channelRef !== 'string') return undefined;
  const checked = validateBusEnvelope(record.message);
  if (!checked.ok || checked.value.channel !== 'slack' || checked.value.channel_ref !== record.channelRef) return undefined;
  if (leaderRequestKey(checked.value.channel, checked.value.id) !== requestId) return undefined;
  const ref = parseSlackThreadRef(record.channelRef);
  return ref === undefined ? undefined : { channelRef: record.channelRef, ref };
}

export interface SlackOrderNoticeSenderOptions {
  /** Runs dir holding `leader/network-state.json`; also the slack-transport send store root. */
  runsDir?: string;
  /** Owner config dir for agent-network.toml/comms.toml; the trusted host default otherwise. */
  configDir?: string;
  /** Test seam; production resolves the configured credential itself. */
  call?: SlackCall;
  signal?: AbortSignal;
}

/**
 * Same-thread Slack reply for a legacy-heading order: the request's durable
 * leader-network route binds the Slack channel id and thread ts, then the
 * existing delivery path posts through every audience/outbound gate
 * (`slackSendDecision`, `slackOutboundPlan`). No binding, no policy, a gate
 * refusal or an `uncertain` result all throw so the notice counts as failed
 * and is retried — a Slack notice is never ledgered `skipped` and never
 * falls back to a channel top-level post. A `duplicate` delivery counts as
 * sent, so a proved post is never repeated when the ledger write was lost.
 */
export function createSlackOrderNoticeSender(options: SlackOrderNoticeSenderOptions = {}): (notice: OrderMergeNotice) => Promise<void> {
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  const leaderOptions: LeaderRuntimeOptions = {
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  return async notice => {
    if (typeof notice.requestId !== 'string' || !REQUEST_ID.test(notice.requestId)) throw new Error('Slack notice has no leader-network request id.');
    const binding = slackOrderThreadBinding(runsDir, notice.requestId);
    if (!binding) throw new Error('No durable Slack thread binding for the order request.');
    const policy = readSlackDeliveryPolicy(leaderOptions);
    if (!policy || options.signal?.aborted) throw new Error('Slack delivery policy is unavailable.');
    const route = policy.config.map.find(mapping => mapping.channel === binding.ref.channelId);
    if (binding.ref.teamId !== policy.config.teamId || !route) throw new Error('Slack binding is outside the configured route.');
    // Stay below the existing Leader delivery boundary's thirty-second limit.
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000);
    const transport = options.call ?? configuredSlackCall(policy.config, signal);
    const call: SlackCall = (method, input, credential) => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('slack-session-expired')); return; }
      const abort = (): void => reject(new Error('slack-session-expired'));
      signal.addEventListener('abort', abort, { once: true });
      void transport(method, input, credential).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    const result = await deliverSlackEnvelope({
      id: `order-merged-${createHash('sha256').update(notice.key).digest('hex').slice(0, 32)}`,
      from: 'leader', to: route.topic, priority: 'P2', ttl: CHANNEL_BUS_TTL_MS,
      body: { kind: 'note', text: notice.text, thread: binding.channelRef },
      channel: 'slack', channel_ref: binding.channelRef,
      sender: { agent_id: 'leader', vendor: 'phantom', human: false, team: true },
      external: false, origin_bridge: LEADER_BRIDGE_ID,
    }, {
      ...policy, call, signal,
      stateRoot: join(runsDir, 'slack-transport'),
      readPolicy: () => readSlackDeliveryPolicy(leaderOptions),
    });
    if (result.status !== 'sent' && result.status !== 'duplicate') throw new Error(`Slack notice ${result.status}: ${result.reason}`);
  };
}

const defaultSenders: OrderMergeNoticeSenders = {
  email: createEmailNoticeSender(),
  desktop: postBusNotice, phone: postBusNotice, page: postBusNotice,
  telegram: async notice => { postLeaderMessage({ channel: 'telegram', kind: 'update', text: notice.text }); },
  slack: createSlackOrderNoticeSender(),
};

export async function sendOrderMergeNotices(root: string, notices: readonly OrderMergeNotice[],
  senders?: OrderMergeNoticeSenders): Promise<{ sent: number; skipped: number; failed: number }> {
  const counts = { sent: 0, skipped: 0, failed: 0 };
  if (!notices.length) return counts;
  // The Slack sender binds the same runs dir the ledger lives under.
  const resolved = senders ?? { ...defaultSenders, slack: createSlackOrderNoticeSender({ runsDir: root }) };
  const ledger = join(root, 'queue', 'order-notices.jsonl');
  try {
    ensurePrivateDirectory(dirname(ledger));
    const acquired = acquireLocalStoreLockWithOutcome(`${ledger}.lock`, 0);
    if (acquired.state !== 'acquired') return counts;
    try {
      const seen = readOrderNoticeLedger(root);
      // A newline also isolates any truncated final row from the next record.
      for (const notice of notices) {
        if (seen.has(notice.key)) continue;
        const send = Object.hasOwn(resolved, notice.channel) ? resolved[notice.channel] : undefined;
        try {
          if (send) await send(notice);
          const status = send ? 'sent' : 'skipped';
          appendFileSync(ledger, `\n${JSON.stringify({ key: notice.key, status,
            ...(!send ? { reason: 'channel has no sender' } : {}) })}\n`, { mode: 0o600 });
          seen.add(notice.key);
          counts[status]++;
        } catch { counts.failed++; }
      }
    } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { counts.failed++; }
  return counts;
}
