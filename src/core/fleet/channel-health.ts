/**
 * One-read channel health for the Slack and iMessage bridges. Composes existing
 * readers (Slack status + journal + send receipts, iMessage config + ack log +
 * last-send receipt) and a process check. It never sends, never reads a
 * credential value, and never infers liveness from prose: only receipts and a
 * process check count. Each source is injectable; a source that throws makes
 * the channel UNKNOWN rather than guessed.
 */
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isSlackChannelId, isSlackTs } from '../agents/slack-network.js';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../agents/slack-reply-binding.js';
import { buildSlackBridgeStatus } from '../agents/slack-status.js';
import { readSlackJournal } from '../agents/slack-journal.js';
import { ashlrHome } from '../cloud/store.js';
import { loadConfigReadOnlyStrict } from '../config.js';
import { readImessageAckEvidence } from '../comms/imessage-ack-evidence.js';
import { commsEnabled, readLastSend } from '../integrations/imessage.js';
import { readPrivateFileCapped } from '../verse/preferences.js';

export type ChannelName = 'slack' | 'imessage';
export type ChannelState = 'LIVE' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN';

export interface ChannelProof {
  /**
   * 'idle': no pending inbound inside the window -- a LIVE state then proves
   *   process and configuration health only, never that a request was answered.
   * 'unproven': pending inbound remains that no same-thread sent receipt could
   *   be bound to (or the source cannot bind replies at all).
   * 'verified': every recent request carried a validated identity and bound a
   *   distinct same-thread 'sent' receipt. Observed same-thread reply
   *   coverage only -- never named ownership, dispatch or completion.
   */
  requestCoverage: 'idle' | 'unproven' | 'verified';
  /** Receipt observations dated after `asOf`; excluded from evidence entirely. */
  futureDatedCount: number;
  /**
   * Durable bus-admission counts inside the recent inbound window. Present only
   * when the source returns per-row outcomes; absent means coverage is unknown,
   * never that admission succeeded. 'unverified' counts rows (e.g. legacy
   * journal entries) that carry no bus outcome and so prove nothing either way.
   */
  durableIngress?: DurableIngressCounts;
}

/** Per-row durable-admission tally; counts only, never identifiers or payloads. */
export interface DurableIngressCounts {
  posted: number;
  duplicate: number;
  failed: number;
  unverified: number;
}

/** Durable bus-post outcome recorded next to an ingested inbound row. */
export type InboundAdmission = 'posted' | 'duplicate' | 'failed';

/** One inbound observation; `admission` absent means durable admission is unproven. */
export interface InboundObservation {
  /** ISO receive time. */
  at: string;
  admission?: InboundAdmission;
  /**
   * Validated request identity when the observation store retains it (Slack
   * journal rows post-335). All three must validate for reply binding; rows
   * lacking them stay uncorrelated and can never be cleared by activity.
   */
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
}

export interface InboundEvidence {
  rows: InboundObservation[];
  /**
   * Observation-store coverage. 'missing' and 'unreadable' are evidence gaps:
   * they can never certify an idle healthy request path.
   */
  store: 'ok' | 'missing' | 'unreadable';
}

export interface ChannelHealth {
  channel: ChannelName;
  configured: boolean;
  processAlive: boolean | 'unknown';
  runtimeHost: string | null;
  lastInboundAt: string | null;
  lastReplyAt: string | null;
  unansweredCount: number;
  /** Additive proof metadata: separates observed activity from verified coverage. */
  proof: ChannelProof;
  state: ChannelState;
  missing: string[];
  /** ISO time every timestamp above was read at. */
  asOf: string;
}

export interface ChannelHealthReport { schemaVersion: 1; asOf: string; channels: ChannelHealth[] }

/** One channel's evidence; every field may throw (=> UNKNOWN). Missing names only, never values. */
export interface ChannelSource {
  /** Names of absent configuration pieces; empty array means configured. */
  configMissing(): Promise<string[]> | string[];
  processAlive(): Promise<boolean | 'unknown'> | boolean | 'unknown';
  /** Inbound receive times (ISO), any order. */
  inbound(): Promise<string[]> | string[];
  /**
   * Optional richer inbound read; when present it supersedes inbound(). Rows
   * carry durable-admission outcomes and `store` reports observation-store
   * coverage. Sources without it keep honest unknown coverage: no
   * durableIngress counts are invented for them.
   */
  inboundEvidence?(): Promise<InboundEvidence> | InboundEvidence;
  /** Reply receipt times (ISO), any order. Activity observations only -- replyReceipts() below is what binds a reply to a specific inbound. */
  replies(): Promise<string[]> | string[];
  /**
   * Optional richer reply read: per-receipt channel/thread/ts evidence for
   * one-to-one same-thread binding via bindSlackReplies. When present together
   * with inboundEvidence, requests carrying a validated identity are cleared
   * only by a distinct 'sent' receipt in their own thread; 'attempted',
   * top-level, wrong-thread and malformed receipts can never clear pending
   * work. Throwing marks the receipt source unreadable (UNKNOWN), same as
   * replies().
   */
  replyReceipts?(): Promise<SentReceipt[]> | SentReceipt[];
}

export interface ChannelHealthDeps {
  now?: () => Date;
  host?: string;
  sources?: Partial<Record<ChannelName, ChannelSource>>;
  runsDir?: string;
}

export const INBOUND_WINDOW_MS = 60 * 60_000;
export const REPLY_GRACE_MS = 10 * 60_000;

function pgrep(pattern: string): Promise<boolean | 'unknown'> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', pattern], { timeout: 2_000 }, (err) => {
      if (!err) return resolve(true);
      resolve((err as { code?: unknown }).code === 1 ? false : 'unknown');
    });
  });
}

const isoOrNull = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Raw rows of the Slack sent store `{version, messages: {<hash>: receipt}}`:
 * each receipt carries channel/thread/ts evidence set by deliverSlackEnvelope.
 * A missing store is empty evidence; a truncated or unparseable one is
 * unreadable and throws.
 */
function slackSendStoreRows(): unknown[] {
  const read = readPrivateFileCapped(join(ashlrHome(), 'fleet', 'slack-transport', 'messages.json'), 1024 * 1024);
  if (read === null) return [];
  if (read.truncated) throw new Error('slack-receipts-unreadable');
  const data = JSON.parse(read.text) as { messages?: Record<string, unknown> };
  return Object.values(data.messages ?? {});
}

/** Slack sent-receipt `ts` is epoch seconds; the store prunes after expiry, so this is recent evidence only. */
function slackReplyTimes(receipts: unknown[]): string[] {
  const out: string[] = [];
  for (const receipt of receipts) {
    const at = record(receipt) && receipt.state === 'sent' && typeof receipt.ts === 'string'
      ? isoOrNull(Number(receipt.ts) * 1000) : null;
    if (at) out.push(at);
  }
  return out;
}

/**
 * Reply receipts that pass the binder's own validation shape: a real channel,
 * an 'attempted'/'sent' state and well-formed optional thread/ts. Malformed
 * rows drop here exactly as bindSlackReplies would reject them.
 */
function slackReplyReceipts(receipts: unknown[]): SentReceipt[] {
  const out: SentReceipt[] = [];
  for (const receipt of receipts) {
    if (!record(receipt) || (receipt.state !== 'attempted' && receipt.state !== 'sent') ||
        !isSlackChannelId(receipt.channel) ||
        (receipt.ts !== undefined && !isSlackTs(receipt.ts)) ||
        (receipt.thread !== undefined && !isSlackTs(receipt.thread))) continue;
    out.push({
      channel: receipt.channel,
      state: receipt.state,
      ...(isSlackTs(receipt.thread) ? { thread: receipt.thread } : {}),
      ...(isSlackTs(receipt.ts) ? { ts: receipt.ts } : {}),
    });
  }
  return out;
}

/** Slack journal rows -> inbound evidence. Only ids/outcomes survive; text, authors and error payloads never reach this surface. */
function slackInboundEvidence(runsDir?: string): InboundEvidence {
  const journal = readSlackJournal({ ...(runsDir ? { runsDir } : {}), limit: 4096 });
  if (journal.state === 'degraded') return { store: 'unreadable', rows: [] };
  if (journal.state === 'missing') return { store: 'missing', rows: [] };
  return {
    store: 'ok',
    rows: journal.entries
      .filter((e) => e.decision === 'ingested')
      .map((e) => ({
        at: e.at,
        ...(e.bus ? { admission: e.bus } : {}),
        ...(e.channelId ? { channelId: e.channelId } : {}),
        ...(e.messageTs ? { messageTs: e.messageTs } : {}),
        ...(e.threadTs ? { threadTs: e.threadTs } : {}),
      })),
  };
}

/** Default Slack source; the sent store is read once per channel-health pass and shared between the activity and binding projections. */
function slackSource(runsDir?: string): ChannelSource {
  let rows: unknown[] | null = null;
  const storeRows = (): unknown[] => (rows ??= slackSendStoreRows());
  return {
    configMissing: () => {
      const status = buildSlackBridgeStatus(runsDir ? { runsDir } : {});
      const missing: string[] = [];
      if (status.config.state !== 'ok') missing.push('slack agent-network config');
      else if (status.slackSection !== 'ok') missing.push('slack config section');
      else {
        if (status.credentials.botTokenRef === null) missing.push('slack bot token reference');
        if (status.credentials.appTokenRef === null) missing.push('slack app token reference');
        if (status.mappings.length === 0) missing.push('slack channel mapping');
      }
      return missing;
    },
    processAlive: () => pgrep('channels slack run'),
    inbound: () => {
      const evidence = slackInboundEvidence(runsDir);
      if (evidence.store !== 'ok') throw new Error('slack-journal-unreadable');
      return evidence.rows.map((r) => r.at);
    },
    inboundEvidence: () => slackInboundEvidence(runsDir),
    replies: () => slackReplyTimes(storeRows()),
    replyReceipts: () => slackReplyReceipts(storeRows()),
  };
}

function defaultSources(runsDir?: string): Record<ChannelName, ChannelSource> {
  return {
    slack: slackSource(runsDir),
    imessage: {
      configMissing: () => (commsEnabled(loadConfigReadOnlyStrict()) ? [] : ['imessage comms configuration']),
      processAlive: () => pgrep('imessage (poll|watch|run)|ashlr-imessage|imsg|textbot'),
      inbound: async () => {
        const ev = await readImessageAckEvidence(4096, runsDir);
        if (ev.sourceState === 'unreadable') throw new Error('imessage-acks-unreadable');
        return ev.rows.filter((r) => r.status === 'accepted').map((r) => r.timestamp);
      },
      replies: () => {
        const last = readLastSend(runsDir);
        return last?.ok && last.at ? [last.at] : [];
      },
    },
  };
}

const ms = (iso: string): number => Date.parse(iso);

async function readOne(channel: ChannelName, src: ChannelSource, now: Date, host: string): Promise<ChannelHealth> {
  const asOf = now.toISOString();
  const base: ChannelHealth = {
    channel, configured: false, processAlive: 'unknown', runtimeHost: null,
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 },
    state: 'UNKNOWN', missing: [], asOf,
  };
  let configMissing: string[];
  try { configMissing = await src.configMissing(); } catch {
    return { ...base, missing: [`${channel} configuration unreadable`] };
  }
  if (configMissing.length) {
    return { ...base, state: 'BLOCKED', missing: configMissing.map((m) => `${m} not configured`) };
  }
  base.configured = true;
  try { base.processAlive = await src.processAlive(); } catch { base.processAlive = 'unknown'; }
  if (base.processAlive === false) {
    return { ...base, state: 'BLOCKED', missing: [`${channel} bridge process not running`] };
  }
  if (base.processAlive === true) base.runtimeHost = host;
  let inbound: number[], replies: number[], evidence: InboundEvidence | null = null;
  let receipts: SentReceipt[] | null = null;
  try {
    if (src.inboundEvidence) {
      evidence = await src.inboundEvidence();
      inbound = evidence.rows.map((r) => ms(r.at)).filter(Number.isFinite).sort((a, b) => a - b);
    } else {
      inbound = (await src.inbound()).map(ms).filter(Number.isFinite).sort((a, b) => a - b);
    }
    replies = (await src.replies()).map(ms).filter(Number.isFinite).sort((a, b) => a - b);
    receipts = src.replyReceipts ? await src.replyReceipts() : null;
  } catch {
    return { ...base, state: 'UNKNOWN', missing: [`${channel} receipt source unreadable`] };
  }
  const nowMs = now.getTime();
  const validInbound = inbound.filter((t) => t <= nowMs);
  const validReplies = replies.filter((t) => t <= nowMs);
  base.lastInboundAt = validInbound.length ? isoOrNull(validInbound[validInbound.length - 1]!) : null;
  base.lastReplyAt = validReplies.length ? isoOrNull(validReplies[validReplies.length - 1]!) : null;
  const observedReplies = validReplies.length;
  const futureDated = inbound.filter((t) => t > nowMs).length + replies.filter((t) => t > nowMs).length;
  // Timestamp order alone is activity evidence only. When the source returns
  // validated request identity plus reply receipts, bindSlackReplies clears
  // each recent request with a distinct later same-thread 'sent' receipt:
  // repeated deliveries of one message collapse into a single request and
  // rows without a usable identity stay uncorrelated rather than
  // disappearing. Future-dated observations are rejected as evidence.
  let pending: number[];
  let coverage: ChannelProof['requestCoverage'];
  let boundChecked = false;
  let awaitingReply = 0;
  let uncorrelated = 0;
  if (evidence !== null && evidence.store === 'ok' && receipts !== null) {
    boundChecked = true;
    const deduped = new Map<string, InboundRequest>();
    const legacyTimes: number[] = [];
    for (const row of evidence.rows) {
      const t = ms(row.at);
      if (!Number.isFinite(t) || t > nowMs || nowMs - t > INBOUND_WINDOW_MS) continue;
      const { channelId, messageTs, threadTs } = row;
      if (typeof channelId === 'string' && typeof messageTs === 'string' && typeof threadTs === 'string' &&
          isSlackChannelId(channelId) && isSlackTs(messageTs) && isSlackTs(threadTs)) {
        const key = `${channelId} ${threadTs} ${messageTs}`;
        const previous = deduped.get(key);
        if (previous === undefined) deduped.set(key, { at: row.at, channelId, messageTs, threadTs });
        else if (t < ms(previous.at)) previous.at = row.at;
      } else {
        legacyTimes.push(t);
      }
    }
    const binding = bindSlackReplies({ requests: [...deduped.values()], receipts, now });
    pending = binding.unanswered.map((r) => ms(r.at)).filter(Number.isFinite);
    awaitingReply = pending.length;
    uncorrelated = legacyTimes.length;
    pending.push(...legacyTimes);
    coverage = deduped.size + legacyTimes.length === 0 ? 'idle' : pending.length === 0 ? 'verified' : 'unproven';
  } else {
    pending = validInbound.filter((t) => nowMs - t <= INBOUND_WINDOW_MS);
    coverage = pending.length ? 'unproven' : 'idle';
  }
  base.unansweredCount = pending.length;
  const proof: ChannelProof = { requestCoverage: coverage, futureDatedCount: futureDated };
  // Durable-admission tally over the same recent window that can block LIVE.
  // Rows without an outcome (legacy) are 'unverified': they neither prove a
  // successful durable enqueue nor convict one. A 'failed' row is positive
  // evidence the running socket could not durably enqueue the request.
  let durableFailed = false;
  if (evidence !== null && evidence.store === 'ok') {
    const counts: DurableIngressCounts = { posted: 0, duplicate: 0, failed: 0, unverified: 0 };
    for (const row of evidence.rows) {
      const t = ms(row.at);
      if (!Number.isFinite(t) || t > nowMs || nowMs - t > INBOUND_WINDOW_MS) continue;
      if (row.admission === 'posted') counts.posted += 1;
      else if (row.admission === 'duplicate') counts.duplicate += 1;
      else if (row.admission === 'failed') { counts.failed += 1; durableFailed = true; }
      else counts.unverified += 1;
    }
    proof.durableIngress = counts;
  }
  base.proof = proof;
  // A missing or degraded observation store is an evidence gap, not an idle
  // healthy request path: it can never produce LIVE.
  if (evidence !== null && evidence.store !== 'ok') {
    return {
      ...base,
      state: 'UNKNOWN',
      missing: [evidence.store === 'missing' ? `${channel} inbound journal missing` : `${channel} receipt source unreadable`],
    };
  }
  if (base.processAlive === 'unknown') {
    return { ...base, state: 'UNKNOWN', missing: [`${channel} bridge process liveness unverifiable`] };
  }
  const reasons: string[] = [];
  if (awaitingReply && observedReplies) reasons.push(`${channel} request unanswered`);
  if ((boundChecked ? uncorrelated : pending.length) && observedReplies) reasons.push(`${channel} reply correlation unavailable`);
  if (futureDated) reasons.push(`${channel} future-dated receipt ignored`);
  if (durableFailed) reasons.push(`${channel} durable ingress failed`);
  if (pending.some((t) => nowMs - t > REPLY_GRACE_MS) || durableFailed) {
    return { ...base, state: 'DEGRADED', missing: reasons };
  }
  if (reasons.length) return { ...base, state: 'UNKNOWN', missing: reasons };
  return { ...base, state: 'LIVE' };
}

export async function readChannelHealth(deps: ChannelHealthDeps = {}): Promise<ChannelHealthReport> {
  const now = (deps.now ?? (() => new Date()))();
  const host = deps.host ?? hostname();
  const defaults = deps.sources && deps.sources.slack && deps.sources.imessage ? null : defaultSources(deps.runsDir);
  const channels: ChannelHealth[] = [];
  for (const channel of ['slack', 'imessage'] as const) {
    const src = deps.sources?.[channel] ?? defaults![channel];
    channels.push(await readOne(channel, src, now, host));
  }
  return { schemaVersion: 1, asOf: now.toISOString(), channels };
}
