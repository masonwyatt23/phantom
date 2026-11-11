import { afterEach, describe, expect, it } from 'vitest';
import type { CapacityRow } from '../src/web-ui/routes/verse/usage/capacity-strip-model.js';
import {
  firstReadSession,
  markFirstReadAttempted,
  resetFirstReadSessionForTest,
  shouldAutoCheck,
} from '../src/web-ui/routes/verse/resources/first-read.js';

function row(over: Partial<CapacityRow> = {}): CapacityRow {
  return {
    seatId: 'synthetic', label: 'Synthetic', engine: 'codex', monogram: 'C', kind: 'subscription', plan: null,
    cls: 'unread' as CapacityRow['cls'], word: 'no reading', summary: '', connection: null, windows: [], credits: null,
    reserve: null, notes: [], localCount: 1, checkedAt: null, resetAt: null, signedOut: false, ...over,
  };
}

describe('first-read session bound', () => {
  afterEach(resetFirstReadSessionForTest);

  it('stops selecting a seat once its attempt is marked through the session API', () => {
    expect(shouldAutoCheck([row({ seatId: 'seat-a' })], firstReadSession())).toEqual(['seat-a']);
    markFirstReadAttempted('seat-a');
    expect(shouldAutoCheck([row({ seatId: 'seat-a' })], firstReadSession())).toEqual([]);
    expect(firstReadSession().attempted.has('seat-a')).toBe(true);
  });

  it('marks each selected seat independently of the others', () => {
    const rows = [row({ seatId: 'seat-a' }), row({ seatId: 'seat-b' })];
    expect(shouldAutoCheck(rows, firstReadSession())).toEqual(['seat-a', 'seat-b']);
    markFirstReadAttempted('seat-a');
    expect(shouldAutoCheck(rows, firstReadSession())).toEqual(['seat-b']);
  });

  it('never selects seats the auto-check cannot help: devin engine, local kind, signed out', () => {
    const rows = [
      row({ seatId: 'devin-a', engine: 'devin' }),
      row({ seatId: 'local', kind: 'local' }),
      row({ seatId: 'out-a', signedOut: true }),
    ];
    expect(shouldAutoCheck(rows, firstReadSession())).toEqual([]);
  });

  it('restores eligibility after the test reset, as a page reload would', () => {
    markFirstReadAttempted('seat-a');
    expect(shouldAutoCheck([row({ seatId: 'seat-a' })], firstReadSession())).toEqual([]);
    resetFirstReadSessionForTest();
    expect(shouldAutoCheck([row({ seatId: 'seat-a' })], firstReadSession())).toEqual(['seat-a']);
  });
});
