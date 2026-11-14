import { describe, expect, it } from 'vitest';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';

const long = 'synthetic-'.repeat(200);
const iso = '2026-11-13T12:00:00.000Z';

function verdict(state: 'BLOCKED' | 'UNKNOWN' | 'VERIFIED'): FleetRecheck {
  return {
    schema: 'fleet.recheck.v1', asOf: iso,
    sections: {
      runtime: { state: 'UNKNOWN', source: 'runtime-identity', asOf: iso, host: long, tailnetName: 'unknown',
        installedVersion: long, sourceVersion: 'unknown', fleetState: { ageSeconds: 60, stale: false }, missing: [] },
      claims: { state: 'UNKNOWN', source: 'coordination', asOf: iso, active: 3, expiredClaims: 0,
        top: Array.from({ length: 20 }, () => ({ agent: long, repo: long, task: long, expiresAt: iso })), missing: [] },
      bridge: { state: 'BLOCKED', source: 'channel-health', asOf: iso, channels: [], missingBridge: long, missing: [] },
      task: { state: 'UNKNOWN', source: 'work-board', asOf: iso,
        task: { id: long, state: 'RUNNING', owner: long, claimReceipt: long, ledgerClaim: null, asOf: iso, source: 'fake' },
        unowned: 0, unclaimed: 0, missing: [] },
    },
    overall: { state, missing: ['slack bridge process not running', ...Array(100).fill(long)] },
  };
}

describe('recheck reply budget', () => {
  for (const state of ['BLOCKED', 'UNKNOWN'] as const) {
    it(`keeps the first ${state} reason after oversized evidence`, () => {
      const reply = formatRecheckReply(verdict(state));
      expect(reply.length).toBeLessThanOrEqual(900);
      expect(reply).toContain(`Phantom recheck ${state} · as of ${iso} · source fleet-recheck`);
      expect(reply).toContain(`${state === 'BLOCKED' ? 'BLOCKED on' : 'UNKNOWN'}: slack bridge process not running`);
      expect(reply).toMatch(/Task: .* · owner .* · claim .* \(UNKNOWN\)/);
    });
  }

  it('handles absent task and empty missing details', () => {
    const r = verdict('UNKNOWN');
    r.sections.task.task = null;
    r.overall.missing = [];
    const reply = formatRecheckReply(r);
    expect(reply).toContain('Task: none, no task evidence (UNKNOWN)');
    expect(reply).toContain('UNKNOWN: no missing detail');
    expect(reply.length).toBeLessThanOrEqual(900);
  });

  it('scrubs sensitive shapes before clipping oversized values', () => {
    const r = verdict('BLOCKED');
    r.sections.runtime.host = `/Users/fake/private 192.0.2.1 ${long}`;
    r.overall.missing = [`check /home/fake/claims 198.51.100.2 ${long}`];
    const reply = formatRecheckReply(r);
    expect(reply).not.toMatch(/\/Users\/|\/home\/|192\.0\.2\.1|198\.51\.100\.2/);
    expect(reply).toContain('[ip]');
    expect(reply).toContain('BLOCKED on: check ~/claims [ip]');
    expect(reply.length).toBeLessThanOrEqual(900);
  });

  it('keeps the evidence-only qualification under overflow', () => {
    const reply = formatRecheckReply(verdict('VERIFIED'));
    expect(reply.length).toBeLessThanOrEqual(900);
    expect(reply).toContain('Evidence only; this reply grants no dispatch.');
  });
});
