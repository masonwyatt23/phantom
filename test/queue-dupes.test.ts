import { describe, expect, it } from 'vitest';
import { findQueueDupes } from '../src/core/fleet/queue-dupes.js';

describe('queue duplicate analysis', () => {
  it('groups IDs and normalized goals within a repository and reports unknown ages', () => {
    const lines = [
      'id\tpool\trepo\ttitle\tat',
      'A\twork\tphantom\tFix queue 1 pass 1\t2026-01-01T00:00:00Z',
      'B\twork\tphantom\tFix queue 2 pass 2\t2026-01-02T00:00:00Z',
      'A\twork\tother\tUnrelated\t2026-01-03T00:00:00Z',
      'C\twork\tother\tFix queue 3 pass 3\t',
    ].join('\n');
    const result = findQueueDupes(lines, Date.parse('2026-01-04T00:00:00Z'));
    expect(result.dupGroups).toEqual([{ ids: ['A', 'B', 'A'], keep: 'A' }]);
    expect(result.stale).toContainEqual({ id: 'C', ageMs: null });
    expect(result.stale).toContainEqual({ id: 'A', ageMs: 259200000 });
  });
});
