import { describe, expect, it } from 'vitest';
import { composeOwnerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { formatCoordinationClaimsLine } from '../src/core/comms/coordination-claims-line.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';

const now = new Date('2026-11-13T20:27:00Z'); // 15:27 ET
const AS_OF = 'as-of=2026-11-13T20:27:00.000Z';
const claim = (n: number, over: Partial<FleetClaim> = {}): FleetClaim => ({
  id: `fake-claim-id-${n}`, repo: 'example/repo', task: `fake task ${n}`, agent: 'fake-agent',
  claimedAt: now.getTime() - 10_000 + n, expiresAt: now.getTime() + 3_600_000, ...over,
});
const known = (claims: FleetClaim[], expiredClaims = 0): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims, messages: [], proposals: [], expiredClaims });
const unknownBoard: FleetBoard = { schema: 'fleet.coordination.v1', state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: null };

describe('formatCoordinationClaimsLine', () => {
  it('unknown ledger never claims zero', () => {
    const line = formatCoordinationClaimsLine(unknownBoard, now);
    expect(line).toBe(`Claims: unknown (coordination ledger unreadable) ${AS_OF}`);
    expect(line).not.toMatch(/none active|0 /);
  });
  it('no active claims', () => {
    expect(formatCoordinationClaimsLine(known([], 2), now)).toBe(`Claims: none active (expired=2) source=coordination-ledger ${AS_OF}`);
  });
  it('one claim', () => {
    expect(formatCoordinationClaimsLine(known([claim(1)]), now))
      .toBe(`Claims: 1 active — fake-agent example/repo "fake task 1" until 16:27 ET source=coordination-ledger ${AS_OF}`);
  });
  it('five claims: 3 newest shown plus +2 more', () => {
    const line = formatCoordinationClaimsLine(known([1, 2, 3, 4, 5].map(n => claim(n))), now);
    expect(line).toContain('5 active');
    expect(line.indexOf('fake task 5')).toBeLessThan(line.indexOf('fake task 4'));
    expect(line).toContain('fake task 3');
    expect(line).not.toContain('fake task 2');
    expect(line).toContain('; +2 more source=coordination-ledger');
  });
  it('collapses multiline/control text and clips long tasks', () => {
    const line = formatCoordinationClaimsLine(known([claim(1, { task: `line one\n\n\tline\u0007two ${'x'.repeat(200)}` })]), now);
    expect(line).not.toMatch(/[\u0000-\u001f]/);
    expect(line).toContain('"line one line two ');
    expect(line).toContain('…"');
    expect(line.length).toBeLessThanOrEqual(300);
  });
  it('caps the whole line at 300 chars and keeps the tail', () => {
    const wide = [1, 2, 3, 4].map(n => claim(n, { task: 'y'.repeat(100), agent: 'a'.repeat(100), repo: `${'o'.repeat(40)}/${'r'.repeat(40)}` }));
    const line = formatCoordinationClaimsLine(known(wide), now);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line.endsWith(AS_OF)).toBe(true);
  });
  it('never prints ids, lease or message/proposal content', () => {
    const board: FleetBoard = { ...known([claim(1)]),
      messages: [{ id: 'fake-msg-id', from: 'fake-agent', to: 'x', body: 'fake-message-body', at: 1, expiresAt: 2 }],
      proposals: [{ id: 'fake-prop-id', repo: 'example/repo', task: 'fake-proposal-task', to: 'x', at: 1, expiresAt: 2, executionAuthorized: false }] };
    const line = formatCoordinationClaimsLine(board, now);
    for (const banned of ['fake-claim-id', 'fake-msg-id', 'fake-message-body', 'fake-prop-id', 'fake-proposal-task', 'lease']) expect(line).not.toContain(banned);
    expect(line).not.toMatch(/[A-Za-z0-9_-]{32,}/);
  });
});

describe('composeOwnerStatusReply claims line', () => {
  const brief = async () => 'Morning leader brief\nShipped (last 12h): 2 fake PRs';
  const board = () => ({ items: [], inbox: 'ok' as const, truncated: false });
  const runtime = async () => 'Runtime: fake-runtime ok';

  it('sits after the runtime line and before the digest rest', async () => {
    const lines = (await composeOwnerStatusReply('/x', now, { brief, board, runtime, claims: () => known([claim(1)]) })).split('\n');
    expect(lines[0]).toBe('Phantom status, 15:27 ET');
    expect(lines[1]).toBe('Runtime: fake-runtime ok');
    expect(lines[2]).toMatch(/^Claims: 1 active — fake-agent example\/repo/);
    expect(lines[3]).toBe('Shipped (last 12h): 2 fake PRs');
  });
  it('throwing seam yields the unknown line; digest intact', async () => {
    const lines = (await composeOwnerStatusReply('/x', now, { brief, board, claims: () => { throw new Error('boom'); } })).split('\n');
    expect(lines[1]).toBe(`Claims: unknown (coordination ledger unreadable) ${AS_OF}`);
    expect(lines[2]).toBe('Shipped (last 12h): 2 fake PRs');
  });
  it('oversized reply drops board lines before the claims line, then claims before runtime', async () => {
    const blocked = { items: Array.from({ length: 3 }, (_, i) => ({ id: `fake-id-${i}`, channel: 'slack', state: 'BLOCKED' as const, missing: [] })), inbox: 'ok' as const, truncated: false };
    const pad = (n: number) => async () => `Morning leader brief\n${'d'.repeat(n)}`;
    const claims = () => known([claim(1)]);
    const base = { board: () => blocked as never, runtime, claims };
    const mid = await composeOwnerStatusReply('/x', now, { ...base, brief: pad(1250) });
    expect(mid).toContain('Claims:');
    expect(mid).not.toContain('Work items');
    const tight = await composeOwnerStatusReply('/x', now, { ...base, brief: pad(1400) });
    expect(tight).not.toContain('Claims:');
    expect(tight).toContain('Runtime: fake-runtime ok');
    const huge = await composeOwnerStatusReply('/x', now, { ...base, brief: pad(1600) });
    expect(huge).not.toContain('Runtime:');
    expect(huge).toContain('dddd');
  });
});
