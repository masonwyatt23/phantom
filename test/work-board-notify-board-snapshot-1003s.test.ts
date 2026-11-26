import { describe, expect, it, vi } from 'vitest';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';
import { diffBoard, planNotifications, snapshotBoard } from '../src/core/fleet/work-board-notify.js';

const at = '2026-11-12T22:30:00.000Z';
const item = (changes: Partial<WorkBoardItem>): WorkBoardItem => ({
  id: 'synthetic', channel: 'slack', channelRef: 'team/channel/thread', receivedAt: at,
  state: 'BLOCKED', asOf: at, source: 'reply:original', missing: [], owner: null, claimReceipt: null,
  ...changes,
});
const board = (...items: WorkBoardItem[]): WorkBoardResult => ({ items, inbox: 'ok', truncated: false });
const plan = (items: ReturnType<typeof snapshotBoard>) => planNotifications(diffBoard([], items), new Set());

describe('board snapshot outcome proof', () => {
  it('uses the settled blocker even if a later reader differs or throws', () => {
    for (const reader of [vi.fn(() => ({ id: 'synthetic', blocker: { dependency: 'B', source: 'later', at } })),
      vi.fn(() => { throw new Error('later read'); })]) {
      const rows = snapshotBoard(board(item({ result: { kind: 'blocked', dependency: 'A' } })), reader);
      expect(reader).not.toHaveBeenCalled();
      expect(rows[0]?.blocker).toEqual({ dependency: 'A', source: 'reply:original', at });
      expect(plan(rows).notices[0]).toMatchObject({ detail: 'A', source: 'reply:original', asOf: at });
    }
  });

  it('carries all verification fields and converts null optionals to absent', () => {
    const reader = vi.fn();
    const rows = snapshotBoard(board(item({ state: 'VERIFIED', result: {
      kind: 'verified', pr: 42, head: 'abc123', tests: 'passed', artifact: 'build-42',
    } }), item({ id: 'second', state: 'VERIFIED', result: {
      kind: 'verified', pr: null, head: null, tests: 'passed', artifact: null,
    } })), reader);
    expect(reader).not.toHaveBeenCalled();
    expect(rows[0]?.verified).toEqual({ pr: 42, head: 'abc123', tests: 'passed', artifact: 'build-42', source: 'reply:original', at });
    expect(rows[1]?.verified).toEqual({ tests: 'passed', source: 'reply:original', at });
    expect(plan(rows).notices[0]?.detail).toBe('PR #42 head abc123 tests passed artifact build-42');
  });

  it('reads legacy outcomes once, tolerates read failures, and never reads silent states', () => {
    const reader = vi.fn(() => ({ id: 'synthetic', blocker: { dependency: 'legacy', source: 'old', at } }));
    const rows = snapshotBoard(board(item({}), item({ id: 'silent', state: 'RUNNING' })), reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(plan(rows).notices[0]?.detail).toBe('legacy');
    const throwing = vi.fn(() => { throw new Error('unavailable'); });
    expect(plan(snapshotBoard(board(item({})), throwing)).dropped).toHaveLength(1);
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it('drops contradictory and malformed explicit proof without a fallback read', () => {
    const invalid: unknown[] = [null, undefined, { kind: 'verified', pr: 42, head: 'abc', tests: null, artifact: null },
      { kind: 'blocked', dependency: '' }, { kind: 'blocked', dependency: 'unknown' },
      { kind: 'blocked', dependency: 'x'.repeat(201) }];
    const reader = vi.fn(() => ({ id: 'synthetic', blocker: { dependency: 'later', source: 'later', at } }));
    for (const result of invalid) {
      const row = item({ result: result as WorkBoardItem['result'] });
      const planned = plan(snapshotBoard(board(row), reader));
      expect(planned.notices).toEqual([]);
      expect(planned.dropped).toHaveLength(1);
    }
    const malformedVerified = item({ state: 'VERIFIED', result: { kind: 'verified', pr: 1, head: null, tests: null, artifact: null } });
    expect(plan(snapshotBoard(board(malformedVerified), reader)).notices).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  });
});
