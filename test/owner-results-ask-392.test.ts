import { describe, expect, it, vi } from 'vitest';
import { ownerStatusReply, OWNER_RESULTS_FALLBACK } from '../src/core/agents/owner-status-reply.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';
import { isResultsAsk } from '../src/core/fleet/results-ask.js';
import { formatResultsReply } from '../src/core/fleet/results-reply.js';

const now = new Date('2026-11-15T05:00:00Z');
const FOOTER = "VERIFIED is the returning agent's evidence; Phantom has not checked the PR.";

function projection(receipts: string[] = []) {
  const board: FleetBoard = {
    schema: 'fleet.coordination.v1', state: 'known', claims: [], proposals: [], expiredClaims: 0,
    messages: receipts.map((evidence, i) => ({
      id: `return-c${i}`, from: 'test-agent', to: 'all', at: now.getTime() + i,
      expiresAt: now.getTime() + 86400000,
      body: `RESULT ${evidence.startsWith('dependency ') ? 'BLOCKED' : 'VERIFIED'} example/demo claim c${i} task "Work": ${evidence}`,
    })),
  };
  return projectCoordinationReturns(board, now.getTime());
}

describe('exact results asks', () => {
  it.each(['results', 'returns', 'verified', "what's verified", 'what landed', 'Results?', 'what’s verified', '  RETURNS.!  '])('accepts %j', text => {
    expect(isResultsAsk(text)).toBe(true);
    expect(ownerStatusReply().ask(text)).toBe(true);
  });
  it.each(['results for pr #12', 'status', 'results please', 'what landed today', '', `results${'?'.repeat(34)}`])('rejects %j', text => {
    expect(isResultsAsk(text)).toBe(false);
  });
});

describe('results reply', () => {
  it('formats PR and dependency receipts newest first with full retained counts', () => {
    const input = projection(['pr #12 head abc1234567890', 'dependency upstream PR #11']);
    input.unparsed = 2;
    // The formatter also sorts an already-projected input without mutating it.
    input.returns.reverse();
    const before = JSON.stringify(input);
    expect(formatResultsReply(input)).toBe([
      `Phantom results, as of ${now.toISOString()}`,
      '1 VERIFIED, 1 BLOCKED, 2 unparsed',
      'BLOCKED example/demo claim c1: dependency upstream PR #11 — from test-agent, 2026-11-15T05:00:00.001Z',
      'VERIFIED example/demo claim c0: PR #12 head abc1234 — from test-agent, 2026-11-15T05:00:00.000Z',
      FOOTER,
    ].join('\n'));
    expect(JSON.stringify(input)).toBe(before);
  });
  it('reports unknown distinctly from no retained receipts and preserves the disclaimer', () => {
    const unknown = formatResultsReply(projectCoordinationReturns(null, now.getTime()));
    expect(unknown).toContain('Results: UNKNOWN (coordination ledger: reader failed)');
    expect(unknown).not.toContain('none retained');
    expect(unknown.endsWith(FOOTER)).toBe(true);
    const empty = formatResultsReply(projection());
    expect(empty).toContain('0 VERIFIED, 0 BLOCKED, 0 unparsed\nResults: none retained');
    expect(empty.endsWith(FOOTER)).toBe(true);
  });
  it('shows at most eight rows', () => {
    const reply = formatResultsReply(projection(Array.from({ length: 10 }, () => 'tests passed')));
    expect(reply.split('\n').filter(line => line.startsWith('VERIFIED example/'))).toHaveLength(8);
    expect(reply).toContain('10 VERIFIED, 0 BLOCKED, 0 unparsed');
    expect(reply).not.toContain('claim c1:');
    expect(reply).not.toContain('claim c0:');
  });
  it('cuts non-PR evidence to 80 characters and drops oldest rows to preserve the 1500 cap', () => {
    const input = projection(Array.from({ length: 30 }, () => `artifact ${'x'.repeat(200)}`));
    // Valid longer agent labels make eight rows exceed the reply budget.
    input.returns.forEach(row => { row.from = `test-${'agent'.repeat(10)}`; });
    const reply = formatResultsReply(input);
    expect(reply.length).toBeLessThanOrEqual(1500);
    expect(reply).toContain('30 VERIFIED, 0 BLOCKED, 0 unparsed');
    expect(reply).toContain(`claim c29: artifact ${'x'.repeat(80)} — from`);
    expect(reply).not.toContain('x'.repeat(81));
    const rows = reply.split('\n').filter(line => line.startsWith('VERIFIED example/'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(8);
    rows.forEach((row, i) => expect(row).toContain(`claim c${29 - i}:`));
    expect(reply.endsWith(FOOTER)).toBe(true);
  });
});

describe('owner results composition', () => {
  it('uses the results seam and contains failures in its own fallback', async () => {
    const results = vi.fn(async () => 'X');
    await expect(ownerStatusReply({ results }).compose('/synthetic', now, 'results')).resolves.toBe('X');
    expect(results).toHaveBeenCalledWith(now);
    await expect(ownerStatusReply({ results: async () => { throw new Error('synthetic failure'); } })
      .compose('/synthetic', now, 'results')).resolves.toBe(OWNER_RESULTS_FALLBACK);
  });
  it('keeps status on its digest and snapshot path', async () => {
    const results = vi.fn(async () => 'X');
    const brief = vi.fn(async () => 'Morning leader brief\nShipped: synthetic');
    const snapshot = vi.fn(async () => { throw new Error('synthetic snapshot unavailable'); });
    const reply = await ownerStatusReply({ results, brief, snapshot, board: () => ({ inbox: 'ok', items: [], truncated: false }) })
      .compose('/synthetic', now, 'status');
    expect(reply).toContain('Phantom status, 00:00 ET\nShipped: synthetic');
    expect(reply).toContain('Runtime: UNKNOWN (snapshot unavailable)');
    expect(brief).toHaveBeenCalledWith('/synthetic', now);
    expect(snapshot).toHaveBeenCalledWith(now);
    expect(results).not.toHaveBeenCalled();
  });
});
