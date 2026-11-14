import { formatRelative } from '../autonomy/format.js';

// View of `slackReplies` / `sources.slackReplies` on GET /api/verse/fleet/comms-status.
// Declared locally: the web bundle never imports server code. Every field is narrowed
// because an older or partial server may send anything.
export type SlackRepliesState = 'ok' | 'missing' | 'degraded';
export interface SlackReplySample { channelId: string; threadTs: string; at: string }
export type SlackRepliesView =
  | { kind: 'absent' }
  | { kind: 'unavailable' }
  | {
    kind: 'ok'; state: SlackRepliesState; answered: number; unanswered: number;
    oldestUnansweredAt: string | null; uncertainSends: number; sample: SlackReplySample[];
  };

const SAMPLE_CAP = 5;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

function narrowSample(raw: unknown): SlackReplySample | null {
  if (!isRecord(raw)) return null;
  const { channelId, threadTs, at } = raw;
  return typeof channelId === 'string' && typeof threadTs === 'string' && typeof at === 'string' ? { channelId, threadTs, at } : null;
}

/** Read `raw.slackReplies`: absent (older server) renders nothing; null or degraded source is unavailable. */
export function narrowSlackReplies(raw: unknown): SlackRepliesView {
  if (!isRecord(raw)) return { kind: 'absent' };
  const sources = isRecord(raw.sources) ? raw.sources : {};
  const field = raw.slackReplies;
  if (field === undefined && sources.slackReplies === undefined) return { kind: 'absent' };
  if (sources.slackReplies === 'degraded' || !isRecord(field)) return { kind: 'unavailable' };
  const state: SlackRepliesState = field.state === 'ok' || field.state === 'missing' ? field.state : 'degraded';
  const oldest = typeof field.oldestUnansweredAt === 'string' && field.oldestUnansweredAt !== '' ? field.oldestUnansweredAt : null;
  const sample = (Array.isArray(field.sample) ? field.sample : []).flatMap(r => { const s = narrowSample(r); return s ? [s] : []; }).slice(0, SAMPLE_CAP);
  return { kind: 'ok', state, answered: count(field.answered), unanswered: count(field.unanswered), oldestUnansweredAt: oldest, uncertainSends: count(field.uncertainSends), sample };
}

/** "Slack replies: 3 answered, 2 unanswered (oldest 14m ago), 1 send unconfirmed". */
export function slackRepliesLine(view: SlackRepliesView, nowMs: number): string | null {
  if (view.kind === 'absent') return null;
  if (view.kind === 'unavailable') return 'Slack replies: unavailable';
  if (view.state === 'missing') return 'Slack replies: none recorded';
  const oldest = view.unanswered > 0 && view.oldestUnansweredAt !== null ? ` (oldest ${formatRelative(view.oldestUnansweredAt, nowMs)})` : '';
  const sends = view.uncertainSends > 0 ? `, ${view.uncertainSends} send${view.uncertainSends === 1 ? '' : 's'} unconfirmed` : '';
  return `Slack replies: ${view.answered} answered, ${view.unanswered} unanswered${oldest}${sends}${view.state === 'degraded' ? ' (partial read)' : ''}`;
}
