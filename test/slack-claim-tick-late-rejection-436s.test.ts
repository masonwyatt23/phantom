/**
 * RQ-PHX-SLACKTICKREJECT436S — an aborted `maybeRun` caller returns
 * `aborted` promptly while the underlying pass keeps the single-flight guard
 * until it actually settles. A late pass rejection must not surface as an
 * unhandled rejection, and the next eligible pass must still run. Injected
 * clock, pass and kill switch: no real board, ledger, bus or network.
 */
import { describe, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import type { ClaimNoticePassResult } from '../src/core/fleet/claim-notice-send.js';

const result: ClaimNoticePassResult = { status: 'completed', baselined: false,
  planned: 0, sent: 1, skipped: 0, failed: 0, deliveries: [] };
const counts = { ran: true, sent: 1, deduped: 0, failed: 0 };

function deferred() {
  let resolve!: (value: ClaimNoticePassResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ClaimNoticePassResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Lets queued promise reactions run; deterministic, no timers. */
const turn = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

function watchUnhandled() {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  return {
    unhandled,
    stop: (): void => { process.removeListener('unhandledRejection', onUnhandled); },
  };
}

describe('claim tick late rejection after abort', () => {
  it('aborted caller + late pass rejection: aborted promptly, no unhandled rejection, guard held until settlement', async () => {
    const work = deferred();
    let clock = 0;
    let calls = 0;
    const tick = createClaimNoticeTick({ now: () => clock, intervalMs: 30_000,
      killed: () => false, pass: () => ++calls === 1 ? work.promise : Promise.resolve(result) });
    const watch = watchUnhandled();
    try {
      const controller = new AbortController();
      const first = tick.maybeRun(controller.signal);
      controller.abort();
      expect(await first).toEqual({ ran: false, reason: 'aborted' });
      expect(calls).toBe(1);

      // The pass still owns the guard: a new caller is fenced until it settles.
      clock += 30_000;
      expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'in-flight' });
      expect(calls).toBe(1);

      // The late rejection must not become an unhandled rejection.
      work.reject(new Error('fake late failure'));
      await turn();
      await turn();
      expect(watch.unhandled).toEqual([]);

      // Guard released only after settlement; the next eligible pass runs.
      expect(await tick.maybeRun()).toEqual(counts);
      expect(calls).toBe(2);
      await turn();
      expect(watch.unhandled).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('aborted caller + late pass fulfillment also stays clean and releases the guard', async () => {
    const work = deferred();
    let clock = 0;
    const tick = createClaimNoticeTick({ now: () => clock, intervalMs: 30_000,
      killed: () => false, pass: () => work.promise });
    const watch = watchUnhandled();
    try {
      const controller = new AbortController();
      const first = tick.maybeRun(controller.signal);
      controller.abort();
      expect(await first).toEqual({ ran: false, reason: 'aborted' });
      work.resolve(result);
      await turn();
      await turn();
      expect(watch.unhandled).toEqual([]);
      clock += 30_000;
      expect(await tick.maybeRun()).toEqual(counts);
    } finally {
      watch.stop();
    }
  });

  it('a synchronous pass throw reports pass-error and releases the guard', async () => {
    let clock = 0;
    let calls = 0;
    const tick = createClaimNoticeTick({ now: () => clock, intervalMs: 30_000,
      killed: () => false,
      pass: () => { calls++; if (calls === 1) throw new Error('fake sync failure'); return Promise.resolve(result); } });
    const watch = watchUnhandled();
    try {
      expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'pass-error' });
      await turn();
      expect(watch.unhandled).toEqual([]);
      clock += 30_000;
      expect(await tick.maybeRun()).toEqual(counts);
      expect(calls).toBe(2);
    } finally {
      watch.stop();
    }
  });

  it('a normal pass rejection without abort reports pass-error, fences the interval, then retries', async () => {
    const work = deferred();
    let clock = 0;
    let calls = 0;
    const tick = createClaimNoticeTick({ now: () => clock, intervalMs: 30_000,
      killed: () => false, pass: () => ++calls === 1 ? work.promise : Promise.resolve(result) });
    const watch = watchUnhandled();
    try {
      const first = tick.maybeRun();
      work.reject(new Error('fake failure'));
      expect(await first).toEqual({ ran: false, reason: 'pass-error' });
      await turn();
      await turn();
      expect(watch.unhandled).toEqual([]);
      expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'interval' });
      clock += 30_000;
      expect(await tick.maybeRun()).toEqual(counts);
      expect(calls).toBe(2);
    } finally {
      watch.stop();
    }
  });
});
