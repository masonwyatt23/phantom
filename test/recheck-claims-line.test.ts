import { describe, expect, it, vi } from 'vitest';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import { buildRecheckClaimsLine } from '../src/core/fleet/recheck-claims-line.js';

vi.mock('../src/core/fleet/fleet-recheck.js', () => ({ readFleetRecheck: async () => ({}) }));
vi.mock('../src/core/fleet/fleet-recheck-reply.js', () => ({ formatRecheckReply: () => 'Phantom recheck\nClaims: old summary\nEvidence only' }));
import { composeOwnerRecheckReply } from '../src/core/agents/owner-status-reply.js';

const now = new Date('2026-11-14T12:00:00.000Z');
const ms = now.getTime();
const claim = (n = 1): FleetClaim => ({ id: `fake-${n}`, agent: `fake-owner-${n}`, repo: 'example/phantom',
  task: `review example/phantom#${n} fake-branch @abcdef123456`, claimedAt: ms - n * 60_000, expiresAt: ms + 60_000 });
const board = (claims: FleetClaim[] = []): FleetBoard => ({ schema: 'fleet.coordination.v1', state: 'known',
  claims, messages: [], proposals: [], expiredClaims: 0 });

describe('buildRecheckClaimsLine', () => {
  it('dates a successful empty read', () => {
    expect(buildRecheckClaimsLine(board(), now)).toBe(`Claims: none active (as of ${now.toISOString()})`);
  });
  it('names one owner, exact PR/head and lease age', () => {
    expect(buildRecheckClaimsLine(board([claim()]), now)).toBe('Claims: 1 active · fake-owner-1 example/phantom#1@abcdef1 lease 1m');
  });
  it('shows only the three newest of five claims with an accurate remainder', () => {
    const line = buildRecheckClaimsLine(board([5, 4, 3, 2, 1].map(claim)), now);
    expect(line).toContain('Claims: 5 active');
    expect(line).toContain('fake-owner-3');
    expect(line).not.toContain('fake-owner-4');
    expect(line).toMatch(/; \+2 more$/);
  });
  it('never converts read failure into none', () => {
    for (const input of [null, { ...board(), state: 'unknown' as const }]) {
      expect(buildRecheckClaimsLine(input, now)).toBe('Claims: UNKNOWN (coordination ledger unreadable)');
    }
  });
  it('excludes expired, future and malformed leases at the captured clock', () => {
    expect(buildRecheckClaimsLine(board([{ ...claim(), expiresAt: ms },
      { ...claim(), claimedAt: ms + 1 }, { ...claim(), expiresAt: NaN }]), now))
      .toBe(`Claims: none active (as of ${now.toISOString()})`);
  });
  it('uses the newest returned result, without claiming an older VERIFIED as newest', () => {
    const input = board();
    input.messages = [
      { id: 'return-fake-1', from: 'fake-owner-1', to: 'all', at: ms - 120_000, expiresAt: ms + 60_000,
        body: 'RESULT VERIFIED example/phantom claim fake-1 task "fake": pr #42 head abcdef123456' },
      { id: 'return-fake-2', from: 'fake-owner-2', to: 'all', at: ms - 60_000, expiresAt: ms + 60_000,
        body: 'RESULT BLOCKED example/phantom claim fake-2 task "fake": dependency fake gate' },
    ];
    expect(buildRecheckClaimsLine(input, now)).toContain('last BLOCKED example/phantom by fake-owner-2 1m ago');
    input.messages.pop();
    expect(buildRecheckClaimsLine(input, now)).toContain('last VERIFIED example/phantom#42 by fake-owner-1 2m ago');
  });
  it('keeps generic task PR/head unknown rather than inventing identity', () => {
    expect(buildRecheckClaimsLine(board([{ ...claim(), task: 'fake private task' }]), now))
      .toContain('example/phantom#unknown@unknown');
  });
  it('guards a throwing reader and replaces the generic line in owner replies', async () => {
    const failed = await composeOwnerRecheckReply(now, { recordRecheck: () => {}, claimsBoard: () => { throw new Error('fake private path'); } });
    expect(failed).toBe('Phantom recheck\nClaims: UNKNOWN (coordination reader failed)\nEvidence only');
    const reply = await composeOwnerRecheckReply(now, { recordRecheck: () => {}, claimsBoard: () => board([claim()]) });
    expect(reply).toContain('fake-owner-1 example/phantom#1@abcdef1 lease 1m');
    expect(reply.match(/Claims:/g)).toHaveLength(1);
  });
});
