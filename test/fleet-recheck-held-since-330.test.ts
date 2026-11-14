/** RQ-PHX-RECHECKHELDSINCE330 — recheckHeldSince counts how many consecutive
 * recorded checks (newest-first rows from readRecheckRecords) hold the live
 * verdict, so `fleet recheck --reply` can say how long the state has held.
 * Pure function: every fixture is a hand-built row; nothing touches disk. */
import { describe, expect, it } from 'vitest';
import { recheckHeldSince } from '../src/core/fleet/recheck-held-since.js';
import { RECHECK_RECORD_SCHEMA, type RecheckRecord } from '../src/core/fleet/recheck-record.js';

const t = (minute: number): string => new Date(Date.UTC(2026, 10, 13, 12, minute)).toISOString();

/** Minimal well-formed row; only overall and asOf matter to the projection. */
function row(overall: string, asOf: string): RecheckRecord {
  return {
    schema: RECHECK_RECORD_SCHEMA,
    asOf,
    overall,
    sections: {
      runtime: { state: 'VERIFIED', host: 'host-a.example', installedVersion: '1.2.3', asOf },
      claims: { state: 'VERIFIED', active: 0, asOf },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf },
      task: { state: 'VERIFIED', id: null, owner: null, claimReceipt: null, asOf },
      missing: null,
    },
  };
}

describe('recheckHeldSince', () => {
  it('reports a three-row BLOCKED run that ends before an older UNKNOWN row', () => {
    const rows = [row('BLOCKED', t(4)), row('BLOCKED', t(3)), row('BLOCKED', t(2)), row('UNKNOWN', t(1))];
    expect(recheckHeldSince(rows, 'BLOCKED')).toEqual({
      state: 'BLOCKED', since: t(2), consecutive: 3, truncated: false,
    });
  });

  it('marks the run truncated when it reaches the end of the retained window', () => {
    const rows = [row('BLOCKED', t(3)), row('BLOCKED', t(2)), row('BLOCKED', t(1))];
    expect(recheckHeldSince(rows, 'BLOCKED')).toEqual({
      state: 'BLOCKED', since: t(1), consecutive: 3, truncated: true,
    });
  });

  it('returns null when the newest row already differs from the live verdict', () => {
    const rows = [row('VERIFIED', t(2)), row('BLOCKED', t(1))];
    expect(recheckHeldSince(rows, 'BLOCKED')).toBeNull();
  });

  it('returns null on an empty window', () => {
    expect(recheckHeldSince([], 'BLOCKED')).toBeNull();
  });

  it('stops the run at the first unparseable asOf without counting it', () => {
    const rows = [row('BLOCKED', t(3)), row('BLOCKED', 'not-a-date'), row('BLOCKED', t(1))];
    expect(recheckHeldSince(rows, 'BLOCKED')).toEqual({
      state: 'BLOCKED', since: t(3), consecutive: 1, truncated: false,
    });
  });

  it('returns null when the run would start on an unparseable asOf', () => {
    const rows = [row('BLOCKED', 'not-a-date'), row('BLOCKED', t(1))];
    expect(recheckHeldSince(rows, 'BLOCKED')).toBeNull();
  });
});
