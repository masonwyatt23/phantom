import { afterEach, describe, expect, it, vi } from 'vitest';

import { activeVerseTurns, beginVerseTurn, waitForQuietTurns } from '../src/core/verse/self-update-restart-gate.js';

// The counter is process-local module state: every begin is released here so
// one case cannot leak a phantom in-flight turn into the next.
const releases: Array<() => void> = [];
const begin = (): () => void => {
  const release = beginVerseTurn();
  releases.push(release);
  return release;
};
afterEach(() => {
  while (releases.length > 0) releases.pop()!();
});

/** Fake clock + sleep: each sleep(ms) advances `now` by exactly ms. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number): Promise<void> => { sleeps.push(ms); now += ms; },
    sleeps,
  };
}

describe('self-update restart gate (RQ-PHX-UPDATERESTARTDEFER04)', () => {
  it('counts turns in flight and releases idempotently', () => {
    const base = activeVerseTurns();
    const a = begin();
    const b = begin();
    expect(activeVerseTurns()).toBe(base + 2);
    a();
    expect(activeVerseTurns()).toBe(base + 1);
    a(); // a second call does not decrement again
    expect(activeVerseTurns()).toBe(base + 1);
    b();
    expect(activeVerseTurns()).toBe(base);
  });

  it('resolves at once when no turn is in flight', async () => {
    const clock = fakeClock();
    const active = vi.fn(() => 0);
    const result = await waitForQuietTurns({ active, now: clock.now, sleep: clock.sleep });
    expect(result).toEqual({ waitedMs: 0, activeAtEnd: 0, timedOut: false });
    expect(clock.sleeps).toEqual([]);
  });

  it('waits for the in-flight turn, then resolves', async () => {
    const clock = fakeClock();
    const release = begin();
    const result = await waitForQuietTurns({
      pollMs: 10,
      now: clock.now,
      // The turn ends after the third poll: the waiter must see 1,1,1,0.
      sleep: async (ms: number) => {
        await clock.sleep(ms);
        if (clock.sleeps.length === 3) release();
      },
    });
    expect(result).toEqual({ waitedMs: 30, activeAtEnd: 0, timedOut: false });
    expect(clock.sleeps).toEqual([10, 10, 10]);
  });

  it('returns at the ceiling when a turn never releases', async () => {
    const clock = fakeClock();
    const result = await waitForQuietTurns({
      active: () => 1, maxWaitMs: 5_000, pollMs: 1_000, now: clock.now, sleep: clock.sleep,
    });
    expect(result).toEqual({ waitedMs: 5_000, activeAtEnd: 1, timedOut: true });
    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
  });

  it('caps the last sleep at the remaining budget so the resolve lands on the ceiling', async () => {
    const clock = fakeClock();
    const result = await waitForQuietTurns({
      active: () => 2, maxWaitMs: 2_500, pollMs: 1_000, now: clock.now, sleep: clock.sleep,
    });
    expect(result).toEqual({ waitedMs: 2_500, activeAtEnd: 2, timedOut: true });
    expect(clock.sleeps).toEqual([1_000, 1_000, 500]);
  });

  it('times out at once when the ceiling is already spent', async () => {
    const clock = fakeClock();
    const result = await waitForQuietTurns({
      active: () => 1, maxWaitMs: 0, now: clock.now, sleep: clock.sleep,
    });
    expect(result).toEqual({ waitedMs: 0, activeAtEnd: 1, timedOut: true });
    expect(clock.sleeps).toEqual([]);
  });

  it('treats a throwing active reader as quiet', async () => {
    const result = await waitForQuietTurns({
      active: () => { throw new Error('fixture reader failure'); },
      now: () => 0,
      sleep: async () => { throw new Error('sleep must never run for a throwing reader'); },
    });
    expect(result).toEqual({ waitedMs: 0, activeAtEnd: 0, timedOut: false });
  });

  it('uses the real counter by default', async () => {
    const release = begin();
    const result = await waitForQuietTurns({
      pollMs: 1,
      now: (() => { let t = 0; return () => (t += 1); })(),
      sleep: async () => { release(); },
    });
    expect(result.timedOut).toBe(false);
    expect(result.activeAtEnd).toBe(0);
  });
});
