/** One-read coordination check answering the Nov13 13:13 ET owner order:
 * sanitized runtime identity, a fresh claims/board read, the named owner of
 * the Dot bridge item, one already-claimed task with execution evidence, and
 * a REACHABLE/BLOCKED verdict naming exactly which piece is missing. Backs
 * `ashlr fleet coord-check [--json]`.
 *
 * Composes existing readers — runtime-identity, channel-health and the work
 * board — with every source injected so tests never touch the host. Read
 * only: it sends nothing, writes nothing and takes no lock. A source that
 * throws is reported null plus a reason; nothing is guessed. All output is
 * sanitized: the home directory and any /Users|/home path becomes `~`, IP
 * addresses are dropped, and board labels are capped at 120 chars. No
 * message body text is ever read: the board carries none. A claim or owner
 * label grants no authority. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listWorkBoard, WORK_BOARD_MAX_LIMIT, type WorkBoardItem, type WorkBoardResult } from '../comms/work-board.js';
import type { WorkItemState } from '../comms/work-item-state.js';
import { readChannelHealth, type ChannelHealthReport } from './channel-health.js';
import { defaultRuntimeIdentityDeps, readRuntimeIdentity, sanitizeIdentityText, type RuntimeIdentity } from './runtime-identity.js';

/** Fixed lowercase keywords matched against a board item's id, channel and
 * channel_ref to find the item that owns the Dot bridge. Substring match:
 * an item naming any of these counts as a bridge item. */
export const BRIDGE_KEYWORDS = ['dot', 'bridge', 'slack', 'imessage'] as const;
/** Channel health read deadline: the check answers in one bounded read. */
export const CHANNEL_TIMEOUT_MS = 3_000;
/** Board labels are untrusted; cap every copied string. */
const LABEL_MAX = 120;

export interface CoordCheckPart<T> {
  value: T | null;
  /** Why value is null; null when the read succeeded. */
  reason: string | null;
}

export interface CoordCheckClaims {
  asOf: string;
  total: number;
  byState: Record<WorkItemState, number>;
}

export interface CoordCheckBridgeOwner {
  id: string;
  owner: string;
  state: WorkItemState;
  receivedAt: string;
}

export interface CoordCheckTask {
  id: string;
  owner: string;
  state: WorkItemState;
  claimReceipt: string;
  /** The classified evidence source (e.g. `claim:bus-claim:...` or a runs ledger). */
  evidence: string;
  /** Evidence timestamp from the classifier. */
  at: string;
}

export interface CoordCheckReport {
  schemaVersion: 1;
  asOf: string;
  runtime: CoordCheckPart<RuntimeIdentity>;
  channels: CoordCheckPart<ChannelHealthReport>;
  claims: CoordCheckPart<CoordCheckClaims>;
  bridgeOwner: CoordCheckPart<CoordCheckBridgeOwner>;
  oneTask: CoordCheckPart<CoordCheckTask>;
  verdict: 'REACHABLE' | 'BLOCKED';
  /** Exact names of the pieces that failed, e.g. "fleet state stale 47m",
   * "work board unreadable", "slack bridge process not running". Empty on
   * REACHABLE. The verb never claims dispatch from this list. */
  missing: string[];
}

export interface CoordCheckDeps {
  now(): Date;
  /** Home directory, used only to redact paths in output. */
  homeDir(): string;
  /** Runtime identity read; throws count as unreadable. */
  readRuntime(): RuntimeIdentity;
  /** Slack/iMessage bridge health read; bounded by channelTimeoutMs. */
  readChannels(): Promise<ChannelHealthReport>;
  /** Work-board read over the durable bus inbox; throws count as unreadable. */
  listBoard(nowMs: number): WorkBoardResult;
  channelTimeoutMs?: number;
}

/** Live dependencies: the same readers the standalone verbs use. */
export function defaultCoordCheckDeps(): CoordCheckDeps {
  return {
    now: () => new Date(),
    homeDir: () => homedir(),
    readRuntime: () => readRuntimeIdentity(defaultRuntimeIdentityDeps()),
    readChannels: () => readChannelHealth(),
    listBoard: nowMs => listWorkBoard({ root: join(ashlrHome(), 'fleet'), now: nowMs, limit: WORK_BOARD_MAX_LIMIT }),
  };
}

const HOME_PATH = /\/(?:Users|home)\/[^/\s]+/g;
const label = (v: string): string => v.slice(0, LABEL_MAX);

/** Home -> ~, other /Users|/home paths -> ~, IPv4/IPv6 -> [ip]. */
function sanitizeText(value: string, home: string): string {
  return sanitizeIdentityText(value, home).replace(HOME_PATH, '~');
}

/** Every string headed for the report passes through the redactor. */
function deep<T>(value: T, home: string): T {
  if (typeof value === 'string') return sanitizeText(value, home) as T;
  if (Array.isArray(value)) return value.map(v => deep(v, home)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = deep(v, home);
    return out as T;
  }
  return value;
}

function timeout<T>(read: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('channel health read timed out')), ms);
    read.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/** Newest first; receivedAt is ISO so unparsable stamps sort last. */
function newestFirst(items: WorkBoardItem[]): WorkBoardItem[] {
  return [...items].sort((a, b) => (Date.parse(b.receivedAt) || 0) - (Date.parse(a.receivedAt) || 0));
}

function isBridgeItem(item: WorkBoardItem): boolean {
  const text = `${item.id} ${item.channel} ${item.channelRef ?? ''}`.toLowerCase();
  return BRIDGE_KEYWORDS.some(k => text.includes(k));
}

export async function buildCoordCheck(deps: CoordCheckDeps): Promise<CoordCheckReport> {
  const now = deps.now();
  let home = '';
  try { home = deps.homeDir(); } catch { /* paths then stay unredacted only where sanitize needs them */ }
  const missing: string[] = [];

  let runtime: RuntimeIdentity | null = null;
  let runtimeReason: string | null = null;
  try {
    runtime = deps.readRuntime();
    if (runtime.fleetState.stale === true) {
      const age = runtime.fleetState.ageSeconds;
      missing.push(`fleet state stale${typeof age === 'number' ? ` ${Math.floor(age / 60)}m` : ''}`);
    } else if (runtime.fleetState.stale === 'unknown') {
      missing.push('fleet state unreadable');
    }
  } catch {
    runtimeReason = 'runtime identity unreadable';
    missing.push(runtimeReason);
  }

  let channels: ChannelHealthReport | null = null;
  let channelsReason: string | null = null;
  try {
    channels = await timeout(deps.readChannels(), deps.channelTimeoutMs ?? CHANNEL_TIMEOUT_MS);
    for (const c of channels.channels) missing.push(...c.missing);
  } catch (err) {
    channelsReason = err instanceof Error && err.message === 'channel health read timed out'
      ? 'channel health read timed out' : 'channel health unreadable';
    missing.push(channelsReason);
  }

  let board: WorkBoardResult | null = null;
  try { board = deps.listBoard(now.getTime()); } catch { board = null; }
  let claims: CoordCheckClaims | null = null;
  let claimsReason: string | null = null;
  if (board === null || board.inbox !== 'ok') {
    claimsReason = 'work board unreadable';
    missing.push(claimsReason);
  } else {
    const byState: Record<WorkItemState, number> = { RECEIVED: 0, ASSIGNED: 0, RUNNING: 0, BLOCKED: 0, VERIFIED: 0 };
    for (const item of board.items) byState[item.state]++;
    claims = { asOf: now.toISOString(), total: board.items.length, byState };
  }

  const items = board === null || board.inbox !== 'ok' ? [] : newestFirst(board.items);
  const bridge = items.find(i => i.owner !== null && isBridgeItem(i));
  const bridgeOwner: CoordCheckPart<CoordCheckBridgeOwner> = bridge
    ? {
        value: { id: label(bridge.id), owner: label(bridge.owner!), state: bridge.state, receivedAt: bridge.receivedAt },
        reason: null,
      }
    : { value: null, reason: claimsReason ?? 'no named owner on the board' };

  const task = items.find(i =>
    (i.state === 'RUNNING' || i.state === 'VERIFIED')
    && i.owner !== null && i.claimReceipt !== null && i.source.trim() !== '');
  const oneTask: CoordCheckPart<CoordCheckTask> = task
    ? {
        value: {
          id: label(task.id), owner: label(task.owner!), state: task.state,
          claimReceipt: label(task.claimReceipt!), evidence: label(task.source), at: task.asOf,
        },
        reason: null,
      }
    : { value: null, reason: claimsReason ?? 'no owned task with execution evidence on the board' };

  return deep<CoordCheckReport>({
    schemaVersion: 1,
    asOf: now.toISOString(),
    runtime: { value: runtime, reason: runtimeReason },
    channels: { value: channels, reason: channelsReason },
    claims: { value: claims, reason: claimsReason },
    bridgeOwner, oneTask,
    verdict: missing.length === 0 ? 'REACHABLE' : 'BLOCKED',
    missing,
  }, home);
}
