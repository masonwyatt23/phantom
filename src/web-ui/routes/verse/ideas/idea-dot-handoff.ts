/**
 * routes/verse/ideas/idea-dot-handoff.ts: pure model for the Ideas row
 * "Send to Dot" action. No React, no fetch, no clock reads.
 *
 * Send: the envelope is the exact one `ashlr fleet handoff-send --apply`
 * appends (src/cli/fleet-handoff-send.ts): a WorkerHandoff checked with
 * validateHandoff, rendered with renderHandoff, then wrapped as
 * `{ kind: 'worker-handoff', taskId, prompt }` at P3 with a one-day TTL. The
 * pane posts it to the existing POST /api/verse/agent-bus, so
 * handoff-receive/handoff-reply accept it unchanged. There is no new transport.
 *
 * Target: always DOT_AGENT_ID. No builder takes a recipient, and the pane's
 * poster refuses any envelope addressed elsewhere.
 *
 * Correlation: one stable id per idea (`idea-dot-<fnv64>`). It is the envelope
 * id and the handoff taskId, a re-send dedupes on the bus, and Dot's reply
 * carries it as `inReplyTo`.
 *
 * State: ideaHandoffState reads the existing bus reader page
 * (GET /api/verse/agent-bus). Replies count only when they come from
 * DOT_AGENT_ID, so another agent cannot mark an idea as answered.
 *
 * Route: the gate is the comms-status reader's teammate delivery capability
 * (cutover.capabilities.teammateImessageDelivery). That is the same reader the
 * Dot resource row uses. 'unsupported', 'blocked' or an unreadable status
 * disables the action, and the reader's reason code is shown as it is.
 *
 * Idea text is untrusted backlog data. It is flattened and capped, and the
 * prompt it builds is data for Dot, never a command.
 */
import { renderHandoff, validateHandoff, type WorkerHandoff } from '../../../../core/verse/handoff.js';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';

/** The fleet's id for Dot (Ashlr.): the `dot` lane and resource id. The only recipient. */
export const DOT_AGENT_ID = 'dot';
/** The desktop speaks as Mason on the bus, the same as the bus post box. */
export const DOT_HANDOFF_SENDER = 'mason';
/** handoff-send's priority and TTL, kept so both paths make the same envelope. */
export const DOT_HANDOFF_PRIORITY = 'P3';
export const DOT_HANDOFF_TTL_MS = 86_400_000;
export const DOT_HANDOFF_PREFIX = 'idea-dot-';
export const DOT_ROUTE_CAPABILITY = 'teammateImessageDelivery';

const TITLE_MAX = 200;
const RATIONALE_MAX = 1200;
const GOAL_MAX = 120;
const REPO_MAX = 120;

// eslint-disable-next-line no-control-regex -- matching control bytes is the point.
const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
const capped = (value: string | undefined, max: number): string => oneLine(value ?? '').slice(0, max).trim();

// FNV-1a 64-bit over UTF-8 (the bus post box's hash). The id then exposes no
// part of the idea id, which can hold an absolute repo path.
function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

/** The correlation id for one idea. It is also a valid fleet job id, which handoff-receive requires. */
export function ideaHandoffId(ideaId: string): string {
  return `${DOT_HANDOFF_PREFIX}${fnv64(ideaId)}`;
}

export interface DotHandoffIdea {
  id: string;
  title: string;
  repo: string;
  rationale?: string;
  goal?: { id: string; name: string };
}

export interface DotHandoffEnvelope {
  id: string;
  from: typeof DOT_HANDOFF_SENDER;
  to: typeof DOT_AGENT_ID;
  priority: typeof DOT_HANDOFF_PRIORITY;
  ttl: number;
  body: { kind: 'worker-handoff'; taskId: string; prompt: string };
}

export type DotHandoffBuild = { ok: true; envelope: DotHandoffEnvelope } | { ok: false; problem: string };

/** The handoff for one idea: title, rationale and goal tag, with the correlation id. */
export function ideaWorkerHandoff(idea: DotHandoffIdea): WorkerHandoff {
  const id = ideaHandoffId(idea.id);
  const title = capped(idea.title, TITLE_MAX);
  const rationale = capped(idea.rationale, RATIONALE_MAX);
  const goal = idea.goal ? capped(idea.goal.name || idea.goal.id, GOAL_MAX) : '';
  const repo = capped(idea.repo, REPO_MAX);
  return {
    id,
    task: [
      `Idea: ${title}`,
      `Rationale: ${rationale || 'none recorded in the backlog'}`,
      `Goal: ${goal || 'none'}`,
      `Repository: ${repo || 'unassigned'}`,
      `Correlation id: ${id}`,
    ].join('\n'),
    files: [{ path: '.', why: `root of ${repo || 'the repository'}; find the code from the idea` }],
    constraints: [
      { rule: `Put ${id} as inReplyTo on every reply`, reason: 'the Ideas row matches replies to this idea by that id' },
      { rule: 'Propose only: open a PR or report findings; do not merge, push to master or change permissions',
        reason: 'Mason approves what lands; a handoff is not authority' },
    ],
    check: `A reply with inReplyTo ${id} that links a PR or states the findings.`,
  };
}

/** The same checks handoff-send runs, then its envelope. Addressed to Dot, always. */
export function buildDotHandoffEnvelope(idea: DotHandoffIdea): DotHandoffBuild {
  if (!idea.id.trim()) return { ok: false, problem: 'This idea has no id, so a handoff could not be matched to it.' };
  if (!capped(idea.title, TITLE_MAX)) return { ok: false, problem: 'This idea has no title.' };
  const handoff = ideaWorkerHandoff(idea);
  const problems = validateHandoff(handoff);
  if (problems.length) return { ok: false, problem: `Handoff is invalid: ${problems[0]!.field} ${problems[0]!.detail}` };
  return { ok: true, envelope: {
    id: handoff.id, from: DOT_HANDOFF_SENDER, to: DOT_AGENT_ID, priority: DOT_HANDOFF_PRIORITY, ttl: DOT_HANDOFF_TTL_MS,
    body: { kind: 'worker-handoff', taskId: handoff.id, prompt: renderHandoff(handoff) },
  } };
}

// ---- route gate -----------------------------------------------------------

export type DotRoute =
  | { status: 'checking' }
  | { status: 'configured'; state: string; reason: string }
  | { status: 'not-configured'; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const reasonCode = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : null;

/**
 * The Dot route from the raw GET /api/verse/fleet/comms-status body. The
 * teammate leg reports 'unverified' when the reader saw a transport it cannot
 * prove. That is configured: the reader never reports it as 'ready'.
 */
export function dotRouteFromCommsStatus(raw: unknown, loading = false): DotRoute {
  if (raw === undefined) return loading ? { status: 'checking' } : { status: 'not-configured', reason: 'comms-status-unavailable' };
  if (!isRecord(raw) || raw.version !== 1) return { status: 'not-configured', reason: 'comms-status-unreadable' };
  const cutover = raw.cutover;
  if (!isRecord(cutover) || !isRecord(cutover.capabilities)) return { status: 'not-configured', reason: 'cutover-reader-unavailable' };
  const leg = cutover.capabilities[DOT_ROUTE_CAPABILITY];
  if (!isRecord(leg) || typeof leg.state !== 'string') return { status: 'not-configured', reason: 'teammate-route-missing' };
  const reason = reasonCode(leg.reason) ?? 'unknown';
  return leg.state === 'ready' || leg.state === 'unverified'
    ? { status: 'configured', state: leg.state, reason }
    : { status: 'not-configured', reason };
}

export interface DotActionView {
  disabled: boolean;
  /** Text next to the button; null when there is nothing to say. */
  note: string | null;
}

export function dotActionView(route: DotRoute, ideaId: string | null, sending: boolean): DotActionView {
  if (route.status === 'checking') return { disabled: true, note: 'Checking the Dot route…' };
  if (route.status === 'not-configured') return { disabled: true, note: `Dot route not configured: ${route.reason}` };
  if (ideaId === null) return { disabled: true, note: 'This idea has no id to correlate a handoff.' };
  return { disabled: sending, note: null };
}

// ---- state from the bus reader --------------------------------------------

export type IdeaHandoffStateName = 'none' | 'sent' | 'received' | 'replied' | 'failed' | 'expired';

/** What this session saw when it posted; the bus reader stays the authority. */
export type LocalDotSend =
  | { status: 'posted' | 'duplicate'; at: number; ttl: number }
  | { status: 'failed'; at: number; reason: string };

export interface IdeaHandoffState {
  state: IdeaHandoffStateName;
  handoffId: string;
  /** Short text for the row. */
  label: string;
  /** Envelope id of the reply that settled the state, for the Library link. */
  replyId?: string;
}

const LABEL: Record<IdeaHandoffStateName, string> = {
  none: 'Not sent to Dot', sent: 'Sent to Dot', received: 'Dot received it', replied: 'Dot replied',
  failed: 'Dot handoff failed', expired: 'Dot handoff expired',
};
const RECEIVED_KINDS = new Set(['ack', 'received', 'receipt']);

type Reply = { state: 'received' | 'replied' | 'failed'; id: string; cursor: number; detail?: string };

function classifyReply(row: AgentBusReceipt): Reply | null {
  const body = row.envelope.body;
  if (!isRecord(body)) return null;
  const base = { id: row.envelope.id, cursor: row.cursor };
  if (body.kind === 'worker-exit') {
    // context-result-bus: { inReplyTo, kind: 'worker-exit', exitCode, succeeded }.
    return body.succeeded === true ? { ...base, state: 'replied' }
      : { ...base, state: 'failed', detail: Number.isSafeInteger(body.exitCode) ? `exit ${String(body.exitCode)}` : 'worker did not succeed' };
  }
  if (typeof body.kind === 'string' && RECEIVED_KINDS.has(body.kind)) return { ...base, state: 'received' };
  // `phm comms bus reply` sends { inReplyTo, text }: a written answer.
  return { ...base, state: 'replied' };
}

/**
 * The handoff state of one idea, from bus receipts (any order). A settled reply
 * (replied or failed, newest wins) beats received, received beats sent. When
 * the envelope is gone from the live page, the bus has dropped it as expired,
 * so this session's own send record decides between expired and sent.
 */
export function ideaHandoffState(
  handoffs: readonly AgentBusReceipt[], ideaId: string,
  options: { now?: number; local?: LocalDotSend } = {},
): IdeaHandoffState {
  const handoffId = ideaHandoffId(ideaId);
  const view = (state: IdeaHandoffStateName, extra: { detail?: string; replyId?: string } = {}): IdeaHandoffState => ({
    state, handoffId, label: extra.detail ? `${LABEL[state]} (${extra.detail})` : LABEL[state],
    ...(extra.replyId ? { replyId: extra.replyId } : {}),
  });

  const replies = handoffs
    .filter(row => row.envelope.from === DOT_AGENT_ID && isRecord(row.envelope.body) && row.envelope.body.inReplyTo === handoffId)
    .map(classifyReply)
    .filter((reply): reply is Reply => reply !== null)
    .sort((a, b) => b.cursor - a.cursor);
  const settled = replies.find(reply => reply.state !== 'received');
  if (settled) return view(settled.state, { replyId: settled.id, ...(settled.detail ? { detail: settled.detail } : {}) });
  if (replies[0]) return view('received', { replyId: replies[0].id });

  const live = handoffs.some(row => row.envelope.id === handoffId && row.envelope.to === DOT_AGENT_ID
    && isRecord(row.envelope.body) && row.envelope.body.kind === 'worker-handoff');
  if (live) return view('sent');

  const local = options.local;
  if (!local) return view('none');
  if (local.status === 'failed') return view('failed', { detail: local.reason });
  const now = options.now ?? local.at;
  return now >= local.at + local.ttl ? view('expired') : view('sent');
}

/** Only the receipts the Ideas pane needs: its own handoffs and Dot's replies to them. */
export function isIdeaHandoffReceipt(row: AgentBusReceipt): boolean {
  const { id, body } = row.envelope;
  if (id.startsWith(DOT_HANDOFF_PREFIX)) return true;
  return isRecord(body) && typeof body.inReplyTo === 'string' && body.inReplyTo.startsWith(DOT_HANDOFF_PREFIX);
}
