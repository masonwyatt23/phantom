import { describe, expect, it } from 'vitest';
import { preparingWord } from './preparing-stall.js';

describe('preparingWord', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const input = { preparing: true, running: 0, now };

  it('leaves the normal state word to the caller', () => {
    expect(preparingWord({ ...input, preparing: false })).toEqual({ word: '', detail: null });
  });
  it('keeps preparing before the deadline and when the start is unknown or invalid', () => {
    for (const tickStartedAt of [new Date(now - 179_999).toISOString(), null, 'invalid']) {
      expect(preparingWord({ ...input, tickStartedAt })).toEqual({ word: 'Preparing work', detail: null });
    }
  });
  it('names the stall at the deadline and reports the last reason or its absence', () => {
    expect(preparingWord({ ...input, tickStartedAt: new Date(now - 180_000).toISOString(), reason: 'Waiting for selection' }))
      .toEqual({ word: 'Stalled preparing · 3m', detail: 'Waiting for selection' });
    expect(preparingWord({ ...input, tickStartedAt: new Date(now - 240_000).toISOString() }))
      .toEqual({ word: 'Stalled preparing · 4m', detail: 'No agent started and no reason was reported.' });
  });
  it('keeps preparing when agents are working', () => {
    expect(preparingWord({ ...input, running: 1, tickStartedAt: new Date(now - 240_000).toISOString() }))
      .toEqual({ word: 'Preparing work', detail: null });
  });
});
