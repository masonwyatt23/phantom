import { describe, expect, it } from 'vitest';
import { reachHint, safeReach } from '../src/core/drive/nodes/join-reach-hint.js';
import type { PoolReach, PoolReachHost } from '../src/core/fleet/pool-reach.js';

function host(over: Partial<PoolReachHost> = {}): PoolReachHost {
  return {
    slot: 'primary', alias: 'mac-a', matched: 'mac-a', online: true,
    lastSeen: '2026-11-14T11:59:00.000Z', ageSeconds: 60, isSelf: false, ...over,
  };
}
function reach(hosts: PoolReachHost[], reasons: string[] = []): PoolReach {
  return { asOf: '2026-11-14T12:00:00.000Z', self: 'mac-self', role: 'worker', hosts, reasons };
}

describe('reachHint', () => {
  it('names the offline backup and its last seen time', () => {
    const hint = reachHint(reach([
      host(),
      host({ slot: 'backup', alias: 'mac-b', matched: 'mac-b', online: false, lastSeen: '2026-11-14T11:58:40.000Z', ageSeconds: 80 }),
    ]));
    expect(hint).toBe('backup mac-b is offline on the tailnet (last seen 2026-11-14T11:58:40.000Z); start it or check tailscale before retrying');
  });

  it('names the offline primary too', () => {
    const hint = reachHint(reach([
      host({ online: false, lastSeen: '2026-11-14T10:00:00.000Z' }),
      host({ slot: 'backup', alias: 'mac-b' }),
    ]));
    expect(hint).toContain('primary mac-a is offline on the tailnet');
  });

  it('flags an unmatched alias as not a visible tailnet peer', () => {
    const hint = reachHint(reach([
      host(),
      host({ slot: 'backup', alias: 'mac-b', matched: 'unknown', online: 'unknown', lastSeen: 'unknown', ageSeconds: 'unknown' }),
    ]));
    expect(hint).toBe('backup mac-b is not a tailnet peer this computer can see; check the SSH alias or tailnet membership');
  });

  it('prefers the offline report over an unmatched alias (first match wins)', () => {
    const hint = reachHint(reach([
      host({ online: false, lastSeen: '2026-11-14T10:00:00.000Z' }),
      host({ slot: 'backup', alias: 'mac-b', matched: 'unknown', online: 'unknown' }),
    ]));
    expect(hint).toContain('primary mac-a is offline on the tailnet');
  });

  it('reports missing evidence with the first reason when hosts is empty', () => {
    expect(reachHint(reach([], ['node pool not configured', 'tailscale unavailable or status unreadable'])))
      .toBe('tailnet or pool evidence unavailable: node pool not configured');
  });

  it('still produces a sentence when hosts and reasons are both empty', () => {
    expect(reachHint(reach([]))).toBe('tailnet or pool evidence unavailable: no reasons reported');
  });

  it('points at SSH approval when both hosts are online', () => {
    const hint = reachHint(reach([host(), host({ slot: 'backup', alias: 'mac-b', matched: 'mac-b' })]));
    expect(hint).toBe('primary and backup are online on the tailnet; the refusal is likely SSH approval or sign-in, see approvalSteps');
  });
});

describe('safeReach', () => {
  it('returns the reach evidence and its hint from a healthy reader', () => {
    const evidence = reach([host(), host({ slot: 'backup', alias: 'mac-b', online: false, lastSeen: '2026-11-14T11:58:40.000Z' })]);
    const result = safeReach(() => evidence);
    expect(result.reach).toBe(evidence);
    expect(result.hint).toContain('backup mac-b is offline on the tailnet');
  });

  it('never throws: a failed reader degrades to null reach plus a fixed hint', () => {
    const result = safeReach(() => { throw new Error('tailscale exploded'); });
    expect(result).toEqual({ reach: null, hint: 'tailnet reach unknown (reader failed)' });
  });
});
