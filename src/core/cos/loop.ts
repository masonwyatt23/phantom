import { sleepCancellable } from '../fleet/self-loop.js';
import { runCosWorkOnce, type CosWorkOptions, type CosWorkResult } from './worker.js';

export const COS_LOOP_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const COS_LOOP_DEFAULT_INTERVAL_MS = 30_000;
export const COS_LOOP_MIN_INTERVAL_MS = 5_000;
export const COS_LOOP_MAX_PASSES = 1_000;
export const COS_LOOP_BLOCKED_STREAK_LIMIT = 5;
export const COS_LOOP_DEFAULT_PASS_TIMEOUT_MS = 10 * 60 * 1000;

export type CosLoopWork = (options: CosWorkOptions) => Promise<CosWorkResult>;

export interface CosLoopPassEvent {
  pass: number;
  outcome: CosWorkResult['outcome'] | 'error';
  id?: string;
}

export type CosLoopObserver = (event: CosLoopPassEvent) => void | Promise<void>;

export interface CosLoopSummary {
  v: 1;
  passes: number;
  drafted: number;
  idle: number;
  paused: number;
  blocked: number;
  errors: number;
  termination: 'deadline' | 'max-passes' | 'signal' | 'blocked-streak';
    lastBlockedReason?: string;
}

export interface RunCosLoopOptions {
    durationMs: number;
    intervalMs?: number;
    maxPasses?: number;
    runsDir?: string;
    timeoutMs?: number;
    work?: CosLoopWork;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
    signal?: AbortSignal;
    onPass?: CosLoopObserver;
}

export async function runCosLoop(options: RunCosLoopOptions): Promise<CosLoopSummary> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepCancellable;
  const signal = options.signal ?? new AbortController().signal;
  const work = options.work ?? runCosWorkOnce;
  const intervalMs = options.intervalMs ?? COS_LOOP_DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? COS_LOOP_DEFAULT_PASS_TIMEOUT_MS;
  const deadline = now() + options.durationMs;
  const maxPasses = options.maxPasses;

  let passes = 0, drafted = 0, idle = 0, paused = 0, blocked = 0, errors = 0;
  let lastBlockedReason: string | undefined;
  let blockedStreak = 0, streakReason: string | undefined;
  let stopped = false;
  while (!signal.aborted && now() < deadline
    && (maxPasses === undefined || passes < maxPasses)) {
    let outcome: CosLoopPassEvent['outcome'];
    let id: string | undefined;
    try {
      const result = await work({
        ...(options.runsDir === undefined ? {} : { runsDir: options.runsDir }),
        timeoutMs,
        now,
      });
      outcome = result.outcome;
      if (result.outcome === 'drafted' || result.outcome === 'blocked') {
        id = result.id;
        if (result.outcome === 'blocked') lastBlockedReason = result.reason;
      }
    } catch {
      outcome = 'error';
    }
    passes += 1;
    if (outcome === 'drafted') drafted += 1;
    else if (outcome === 'idle') idle += 1;
    else if (outcome === 'paused') paused += 1;
    else if (outcome === 'blocked') {
      blocked += 1;
      if (lastBlockedReason === streakReason) blockedStreak += 1;
      else { streakReason = lastBlockedReason; blockedStreak = 1; }
    } else errors += 1;
    if (outcome !== 'blocked') { blockedStreak = 0; streakReason = undefined; }
    if (options.onPass) {
      await options.onPass({ pass: passes, outcome, ...(id === undefined ? {} : { id }) });
    }
    if (blockedStreak >= COS_LOOP_BLOCKED_STREAK_LIMIT) { stopped = true; break; }
    if (maxPasses !== undefined && passes >= maxPasses) break;
    const current = now();
    if (signal.aborted || current >= deadline) break;
    if (outcome !== 'drafted') {
      try {
        await sleep(Math.min(intervalMs, deadline - current), signal);
      } catch {
        break;
      }
    }
  }

  return {
    v: 1,
    passes,
    drafted,
    idle,
    paused,
    blocked,
    errors,
    termination: stopped ? 'blocked-streak'
      : signal.aborted ? 'signal'
        : (maxPasses !== undefined && passes >= maxPasses ? 'max-passes' : 'deadline'),
    ...(lastBlockedReason === undefined ? {} : { lastBlockedReason }),
  };
}
