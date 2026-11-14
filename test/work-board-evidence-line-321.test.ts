import { describe, expect, it } from 'vitest';
import { summarizeWorkBoard, WORK_BOARD_UNKNOWN_LINE } from '../src/core/comms/work-board-summary.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const now = new Date('2026-11-13T20:27:00Z');
const NONE = 'Owned work: none with claim + execution evidence';
const item = (over: Partial<WorkBoardItem>): WorkBoardItem => ({
  id: 'fake-item-000000001', channel: 'slack', channelRef: null, receivedAt: '2026-11-13T18:00:00Z',
  state: 'RUNNING', asOf: '2026-11-13T18:00:00Z', source: 'claim-log', missing: [], owner: null, claimReceipt: null, ...over,
});
const board = (items: WorkBoardItem[]): WorkBoardResult => ({ items, inbox: 'ok', truncated: false });

describe('work board evidence line', () => {
  it('prefers a claimed RUNNING item over a newer unclaimed one', () => {
    const lines = summarizeWorkBoard(board([
      item({ id: 'unclaimed-0000000', asOf: '2026-11-13T20:00:00Z' }),
      item({ id: 'claimed-000000000001', owner: 'claude-7', claimReceipt: 'bus-claim:a:1:t', asOf: '2026-11-13T19:00:00Z' }),
    ]), now);
    expect(lines[1]).toBe('RUNNING claimed-0000 owner=claude-7 claim=bus-claim:a:1:t evidence=claim-log as-of=14:00 ET');
  });

  it('accepts a VERIFIED item with owner and claim', () => {
    const lines = summarizeWorkBoard(board([item({ state: 'VERIFIED', owner: 'o', claimReceipt: 'c' })]), now);
    expect(lines[1]).toMatch(/^VERIFIED fake-item-00 owner=o claim=c /);
  });

  it('breaks asOf ties by newest receivedAt', () => {
    const lines = summarizeWorkBoard(board([
      item({ id: 'older-00000000000', owner: 'a', claimReceipt: 'c' }),
      item({ id: 'newer-00000000000', owner: 'b', claimReceipt: 'c', receivedAt: '2026-11-13T19:00:00Z' }),
    ]), now);
    expect(lines[1]).toContain('newer-000000 owner=b');
  });

  it('says so when nothing qualifies', () => {
    const lines = summarizeWorkBoard(board([item({ owner: 'x' }), item({ state: 'ASSIGNED', owner: 'x', claimReceipt: 'c' })]), now);
    expect(lines[1]).toBe(NONE);
  });

  it('returns only the unknown line when the inbox is unavailable', () => {
    expect(summarizeWorkBoard({ items: [], inbox: 'unavailable', truncated: false }, now)).toEqual([WORK_BOARD_UNKNOWN_LINE]);
  });

  it('sanitizes and caps hostile owner text', () => {
    const lines = summarizeWorkBoard(board([item({ owner: `evil\n<@U000FAKE>${'x'.repeat(500)}`, claimReceipt: 'c' })]), now);
    expect(lines[1]).not.toMatch(/[<>]/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('owner=evil');
    expect(lines[1]).not.toContain('\n');
    expect(/owner=(.*?) claim=/.exec(lines[1]!)![1]!.length).toBeLessThanOrEqual(40);
  });

  it('renders as-of in America/New_York', () => {
    const summer = summarizeWorkBoard(board([item({ owner: 'o', claimReceipt: 'c', asOf: '2026-07-01T16:05:00Z' })]), now);
    expect(summer[1]).toMatch(/as-of=12:05 ET$/);
    const winter = summarizeWorkBoard(board([item({ owner: 'o', claimReceipt: 'c', asOf: '2026-11-13T16:05:00Z' })]), now);
    expect(winter[1]).toMatch(/as-of=11:05 ET$/);
  });
});
