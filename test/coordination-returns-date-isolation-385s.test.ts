import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

describe('coordination return date isolation', () => {
  it.each([
    ['at', 8_640_000_000_000_001, 1000],
    ['expiresAt', 8_640_000_000_000_000, 1],
  ])('omits a retained receipt with an unrepresentable %s', (_field, badAt, ttlMs) => {
    const dir = mkdtempSync(join(tmpdir(), 'returns-date-385s-'));
    try {
      const path = join(dir, 'board.jsonl');
      const post = (id: string, now: number, ttl: number) => postFleetMessage({
        id: `return-${id}`, from: 'fake-agent', to: 'all', ttlMs: ttl,
        body: `RESULT VERIFIED example/demo claim ${id} task "Fake work": tests fake evidence`,
      }, { path, now });
      expect(post('bad', badAt, ttlMs).ok).toBe(true);
      expect(post('good', 1000, 1000).ok).toBe(true);
      const board = readFleetBoard({ path, now: 1001 });
      expect(board.messages).toHaveLength(2);
      const before = JSON.stringify(board);
      const output = projectCoordinationReturns(board, 8_640_000_000_000_001);
      expect(output).toMatchObject({ state: 'known', asOf: 'unknown', unparsed: 1, returns: [{
        claimId: 'good', at: new Date(1000).toISOString(), expiresAt: new Date(2000).toISOString(),
        evidence: 'tests fake evidence',
      }] });
      expect(() => JSON.stringify(output)).not.toThrow();
      expect(JSON.stringify(board)).toBe(before);
      expect(projectCoordinationReturns(board, 1001).asOf).toBe(new Date(1001).toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
