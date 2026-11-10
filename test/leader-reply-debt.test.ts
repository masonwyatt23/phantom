import { describe, expect, it } from 'vitest';
import { computeReplyDebt } from '../src/core/fleet/leader-reply-debt.js';
import type { InboxEntry } from '../src/core/fleet/mason-inbox.js';

const entry = (id: string, at: string, text = id, source = 'desktop'): InboxEntry => ({ id, at, text, source, priority: null });
const now = new Date('2026-11-10T16:00:00Z');

describe('leader reply debt', () => {
  it('matches references without clearing unrelated entries', () => {
    const result = computeReplyDebt([entry('a', '2026-11-10T14:00:00Z'), entry('b', '2026-11-10T14:10:00Z')], [{ at: '2026-11-10T15:00:00Z', text: 'id:a' }], now);
    expect(result.owed.map(row => row.entryId)).toEqual(['b']);
    expect(result.matches).toEqual([{ entryId: 'a', matchedBy: 'id' }, { entryId: 'b', matchedBy: 'none' }]);
  });
  it('uses unreferenced later replies by time', () => {
    const result = computeReplyDebt([entry('a', '2026-11-10T14:00:00Z')], [{ at: '2026-11-10T15:00:00Z', text: 'Done' }], now);
    expect(result.owed).toEqual([]);
    expect(result.matches[0]?.matchedBy).toBe('time');
  });
  it('filters flags, empty entries, handoffs and grace; sorts oldest first', () => {
    const result = computeReplyDebt([entry('new', '2026-11-10T15:00:00Z'), entry('flag', '2026-11-10T13:00:00Z', '--help'), entry('empty', '2026-11-10T13:00:00Z', ''), entry('agent', '2026-11-10T13:00:00Z', 'hi', 'agent-handoff'), entry('young', '2026-11-10T15:50:00Z'), entry('old', '2026-11-10T14:00:00Z')], [], now);
    expect(result.owed.map(row => row.entryId)).toEqual(['old', 'new']);
    expect(result.oldestAgeMinutes).toBe(120);
  });
});
