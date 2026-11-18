import { apiGet, ApiError } from '../../../data/client.js';
import { narrowSlackTrace, type SlackTraceView } from './slack-trace-model.js';

// Same patterns as isSlackTs / isSlackChannelId in src/core/agents/slack-network.ts, which pulls in
// node-only imports and cannot be bundled for the browser. The test pins both against the server.
export const SLACK_TS_RE = /^\d{1,20}\.\d{1,10}$/;
export const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]{2,32}$/;
export const DEFAULT_LOOKUP_MAX_AGE_SECONDS = 900;

export interface SlackTraceLookupInput { thread: string; channel?: string; message?: string; maxAgeSeconds?: number | string }

/** Same rules as GET /api/verse/fleet/control/slack-trace. Returns the URL, or `{ error }`. */
export function buildSlackTraceLookupUrl(input: SlackTraceLookupInput): string | { error: string } {
  const thread = input.thread.trim(), channel = input.channel?.trim() || undefined, message = input.message?.trim() || undefined;
  if (!SLACK_TS_RE.test(thread)) return { error: 'thread ts must look like 1700000000.000100' };
  if (channel !== undefined && !SLACK_CHANNEL_ID_RE.test(channel)) return { error: 'channel id must look like C00000000' };
  if (message !== undefined && channel === undefined) return { error: 'message ts requires a channel id' };
  if (message !== undefined && !SLACK_TS_RE.test(message)) return { error: 'message ts must look like 1700000000.000100' };
  const rawAge = input.maxAgeSeconds;
  const age = rawAge === undefined || rawAge === '' ? DEFAULT_LOOKUP_MAX_AGE_SECONDS
    : typeof rawAge === 'number' ? rawAge : /^[0-9]+$/.test(rawAge.trim()) ? Number(rawAge.trim()) : NaN;
  if (!Number.isSafeInteger(age) || age <= 0) return { error: 'max age must be a positive whole number of seconds' };
  const params = new URLSearchParams({ thread });
  if (channel !== undefined) params.set('channel', channel);
  if (message !== undefined) params.set('message', message);
  params.set('maxAgeSeconds', String(age));
  return `/api/verse/fleet/control/slack-trace?${params.toString()}`;
}

export type SlackFreshnessVerdict = 'fresh' | 'stale' | 'unknown';
export interface SlackTraceLookupView extends SlackTraceView {
  freshness: { verdict: SlackFreshnessVerdict; maxAgeSeconds: number } | null;
  /** The server's scope disclaimer, capped at 300 chars. */
  scope: string;
  /** True when the server echoed a channel+message selection. */
  selected: boolean;
}

export function narrowSlackTraceLookup(raw: unknown): SlackTraceLookupView | null {
  try {
    const base = narrowSlackTrace(raw);
    if (!base) return null;
    const r = raw as Record<string, unknown>;
    const f = r.freshness;
    const fresh = f !== null && typeof f === 'object' && !Array.isArray(f) ? f as Record<string, unknown> : null;
    const verdict: SlackFreshnessVerdict = fresh?.verdict === 'fresh' || fresh?.verdict === 'stale' ? fresh.verdict : 'unknown';
    const age = fresh && typeof fresh.maxAgeSeconds === 'number' && Number.isSafeInteger(fresh.maxAgeSeconds) && fresh.maxAgeSeconds > 0 ? fresh.maxAgeSeconds : 0;
    const sel = r.selection;
    return {
      ...base,
      freshness: fresh ? { verdict, maxAgeSeconds: age } : null,
      scope: typeof r.scope === 'string' ? r.scope.slice(0, 300) : '',
      selected: sel !== null && typeof sel === 'object' && !Array.isArray(sel),
    };
  } catch { return null; }
}

const STATUS_TEXT: Record<number, string> = { 400: 'invalid lookup', 404: 'not in this build', 503: 'trace unavailable' };

export type SlackTraceLookupResult = { ok: true; view: SlackTraceLookupView } | { ok: false; error: string };

/** GET only. Never throws. */
export async function fetchSlackTraceLookup(input: SlackTraceLookupInput, signal?: AbortSignal): Promise<SlackTraceLookupResult> {
  const url = buildSlackTraceLookupUrl(input);
  if (typeof url !== 'string') return { ok: false, error: url.error };
  try {
    const view = narrowSlackTraceLookup(await apiGet<unknown>(url, signal));
    return view ? { ok: true, view } : { ok: false, error: 'unreadable response' };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error: STATUS_TEXT[error.status] ?? `lookup failed (HTTP ${error.status})` };
    return { ok: false, error: 'trace unavailable' };
  }
}
