/** fleet_email_outbox_await — bounded wait for one named reply artifact to
 * leave `queued` through the isolated fleet MCP server, so a Comms agent can
 * block on its own reply instead of spending tool calls on fleet_email_outbox
 * snapshots. Results carry name, state, fixed reason, timedOut/cancelled and
 * source availability only — evidence only, never permission to send. */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEmailDropConfig } from '../core/comms/email-drop-config.js';
import { awaitEmailOutbox, type AwaitResult } from '../core/comms/email-outbox-await.js';
import type { EmailOutboxStuckReason } from '../core/comms/email-outbox.js';

export const MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS = 300_000;
export const MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS = 100;
export const MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS = 10_000;
export const DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS = 1_000;

export interface FleetEmailOutboxAwaitArgs {
  /** Exact artifact file name ending in .reply.eml; never a path. */
  name: string;
  timeoutMs: number;
  pollMs?: number;
}

export type FleetEmailOutboxAwaitSourceState = 'ok' | 'missing-config' | 'invalid-config' | 'missing-outbox' | 'unreadable-outbox' | 'unobserved';

export interface FleetEmailOutboxAwaitReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** 'ok' once the saved config resolved to a stat-able outbox directory. */
  sourceState: FleetEmailOutboxAwaitSourceState;
  name: string;
  state: 'queued' | 'drafted' | 'sent' | 'stuck' | null;
  reason: EmailOutboxStuckReason | 'source-failure' | null;
  timedOut: boolean;
  cancelled: boolean;
}

export interface FleetEmailOutboxAwaitDeps {
  /** Email-drop config root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  readConfig?: typeof readEmailDropConfig;
  await?: typeof awaitEmailOutbox;
}

/** Parse and validate fleet email outbox await arguments; rejects unknown
 * keys and out-of-range numeric bounds. */
export function parseFleetEmailOutboxAwaitArgs(args: Record<string, unknown>): FleetEmailOutboxAwaitArgs | null {
  const { name, timeoutMs, pollMs } = args;
  if (Object.keys(args).some(key => !['name', 'timeoutMs', 'pollMs'].includes(key)) ||
    typeof name !== 'string' || !name.toLowerCase().endsWith('.reply.eml') ||
    name.includes('..') || /[/\\\0]/.test(name) ||
    typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 || timeoutMs > MAX_FLEET_EMAIL_OUTBOX_AWAIT_MS ||
    (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isSafeInteger(pollMs) ||
      pollMs < MIN_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS || pollMs > MAX_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS))) return null;
  return { name, timeoutMs, ...(pollMs === undefined ? {} : { pollMs: pollMs as number }) };
}

/** Missing/invalid config and missing/unreadable outbox each report their own
 * sourceState with a source-failure reason — never an invented observation.
 * The outbox resolves like the CLI: `outboxDir`, else `inboxDir`'s sibling. */
export async function readFleetEmailOutboxAwait(
  input: FleetEmailOutboxAwaitArgs,
  signal?: AbortSignal,
  deps: FleetEmailOutboxAwaitDeps = {},
): Promise<FleetEmailOutboxAwaitReport> {
  const started = Date.now();
  const readConfig = deps.readConfig ?? readEmailDropConfig;
  const awaitPoll = deps.await ?? awaitEmailOutbox;
  const base = {
    schemaVersion: 1 as const,
    snapshotKind: 'local-persisted' as const,
    authority: 'none' as const,
    generatedAt: new Date().toISOString(),
    name: input.name,
  };
  const report = (sourceState: FleetEmailOutboxAwaitSourceState, extra: Partial<FleetEmailOutboxAwaitReport>): FleetEmailOutboxAwaitReport =>
    ({ ...base, sourceState, state: null, reason: null, timedOut: false, cancelled: false, ...extra });

  if (signal?.aborted) return report('unobserved', { cancelled: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<'cancelled' | 'timedOut'>((resolve) => {
    onAbort = () => resolve('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => resolve('timedOut'), Math.max(0, input.timeoutMs - (Date.now() - started)));
  });
  let config: Awaited<ReturnType<typeof readEmailDropConfig>> | 'cancelled' | 'timedOut';
  try {
    config = await Promise.race([
      Promise.resolve().then(() => readConfig(deps.runsDir ?? join(homedir(), '.ashlr-runs'))),
      boundary,
    ]);
  } catch {
    if (signal?.aborted) return report('unobserved', { cancelled: true });
    if (Date.now() - started >= input.timeoutMs) return report('unobserved', { timedOut: true });
    return report('invalid-config', { reason: 'source-failure' });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted || config === 'cancelled') return report('unobserved', { cancelled: true });
  if (config === 'timedOut' || Date.now() - started >= input.timeoutMs) return report('unobserved', { timedOut: true });
  if (config.state !== 'ok' || !config.config) {
    return report(config.state === 'missing' ? 'missing-config' : 'invalid-config', { reason: 'source-failure' });
  }
  const outboxDir = config.config.outboxDir ?? join(config.config.inboxDir, '..', 'outbox');
  let sourceState: FleetEmailOutboxAwaitSourceState;
  try {
    sourceState = statSync(outboxDir).isDirectory() ? 'ok' : 'unreadable-outbox';
  } catch (error) {
    sourceState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-outbox' : 'unreadable-outbox';
  }
  if (sourceState !== 'ok') return report(sourceState, { reason: 'source-failure' });

  if (signal?.aborted) return report('unobserved', { cancelled: true });
  const remaining = input.timeoutMs - (Date.now() - started);
  if (remaining <= 0) return report('unobserved', { timedOut: true });
  const result: AwaitResult = await awaitPoll({
    dir: outboxDir,
    name: input.name,
    timeoutMs: remaining,
    pollMs: input.pollMs ?? DEFAULT_FLEET_EMAIL_OUTBOX_AWAIT_POLL_MS,
    signal: signal ?? new AbortController().signal,
  });
  if (result.reason === 'source-failure') return report(sourceState, { reason: 'source-failure' });
  return report('ok', {
    state: result.state ?? null,
    reason: result.reason ?? null,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
  });
}
