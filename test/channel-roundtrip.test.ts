/** channelRoundTrip: the Channels pane's pure "Test round trip" row state. */
import { describe, expect, it } from 'vitest';
import { channelRoundTrip, CHANNEL_ROUNDTRIP_TIMEOUT_MS } from '../src/core/agents/channel-roundtrip.js';

const T = Date.parse('2026-11-10T12:00:00Z');
const MIN = 60 * 1000;

describe('channelRoundTrip', () => {
  it.each([
    ['absent', null],
    ['undefined', undefined],
    ['a non-integer', T + 0.5],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['a string', `${T}`],
  ])('is idle when the send time is %s', (_name, sentAt) => {
    expect(channelRoundTrip(sentAt, [T + MIN], T)).toEqual({ state: 'idle' });
  });

  it('waits inside the reply window and reports the send age', () => {
    expect(channelRoundTrip(T - 2 * MIN, [], T)).toEqual({ state: 'waiting', sentAt: T - 2 * MIN, ageMs: 2 * MIN });
  });

  it('completes on the first inbound after the send, with that latency', () => {
    expect(channelRoundTrip(T - 10 * MIN, [T - MIN], T)).toEqual({ state: 'ok', sentAt: T - 10 * MIN, latencyMs: 9 * MIN });
  });

  it('takes the earliest inbound after the send, not the latest and not an unordered one', () => {
    const inbound = [T - 2 * MIN, T - 8 * MIN, T - 4 * MIN];
    expect(channelRoundTrip(T - 10 * MIN, inbound, T)).toEqual({ state: 'ok', sentAt: T - 10 * MIN, latencyMs: 2 * MIN });
  });

  it('does not count inbound at or before the send as the reply', () => {
    expect(channelRoundTrip(T, [T, T - 1], T + MIN)).toEqual({ state: 'waiting', sentAt: T, ageMs: MIN });
  });

  it('ignores inbound on other channels by construction — the caller scopes the list', () => {
    // The function sees only one channel's inbound times; a foreign channel's
    // times never enter the list, so they cannot complete the trip.
    expect(channelRoundTrip(T - MIN, [], T)).toEqual({ state: 'waiting', sentAt: T - MIN, ageMs: MIN });
  });

  it('stays ok past the reply window — completion is permanent', () => {
    expect(channelRoundTrip(T - 90 * MIN, [T - 60 * MIN], T))
      .toEqual({ state: 'ok', sentAt: T - 90 * MIN, latencyMs: 30 * MIN });
  });

  it('goes silent at exactly the reply window', () => {
    expect(channelRoundTrip(T - CHANNEL_ROUNDTRIP_TIMEOUT_MS, [], T))
      .toEqual({ state: 'silent', sentAt: T - CHANNEL_ROUNDTRIP_TIMEOUT_MS, ageMs: CHANNEL_ROUNDTRIP_TIMEOUT_MS });
  });

  it('goes silent past the reply window and keeps reporting the true age', () => {
    expect(channelRoundTrip(T - 90 * MIN, [], T)).toEqual({ state: 'silent', sentAt: T - 90 * MIN, ageMs: 90 * MIN });
  });

  it('skips unusable inbound entries instead of throwing', () => {
    const inbound = [Number.NaN, Number.POSITIVE_INFINITY, -1, 'junk', T - MIN];
    expect(channelRoundTrip(T - 10 * MIN, inbound, T)).toEqual({ state: 'ok', sentAt: T - 10 * MIN, latencyMs: 9 * MIN });
  });

  it('clamps the waiting age at zero when the send is dated in the future', () => {
    expect(channelRoundTrip(T + MIN, [], T)).toEqual({ state: 'waiting', sentAt: T + MIN, ageMs: 0 });
  });
});
