import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardNotifyLedgerPath, diffBoard, planNotifications, readBoardNotifySent,
  sendNotifications, snapshotAfterSend, type BoardSendReceipt, type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const at = '2026-11-13T22:00:00.000Z';
const item = (id: string, blocked: boolean): BoardSnapshotItem => ({
  id, state: blocked ? 'BLOCKED' : 'RECEIVED', asOf: at, source: 'fake-source',
  owner: null, claimReceipt: null, channel: 'fake', channelRef: 'fake-thread',
  blocker: blocked ? { dependency: 'fake-dependency', source: 'fake-source', at } : null,
  verified: null,
});

describe('board notification pass deadline', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-pass-')); chmodSync(dir, 0o700); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  it('bounds stalled sends, preserves pending transitions and ignores late receipts', async () => {
    const ledgerPath = boardNotifyLedgerPath(dir);
    const previous = ['a', 'b', 'c', 'd'].map(id => item(id, false));
    const current = ['a', 'b', 'c', 'd'].map(id => item(id, true));
    const notices = planNotifications(diffBoard(previous, current), new Set()).notices;
    let resolveLate!: (receipt: BoardSendReceipt) => void;
    const stalled = new Promise<BoardSendReceipt>(resolve => { resolveLate = resolve; });
    const sender = vi.fn().mockResolvedValueOnce({ status: 'sent', receipt: 'receipt-a' })
      .mockReturnValueOnce(new Promise(() => {})).mockReturnValueOnce(stalled);
    const pass = sendNotifications(notices, { senders: { fake: sender }, ledgerPath, senderTimeoutMs: 10, passTimeoutMs: 15 });
    await vi.advanceTimersByTimeAsync(15);
    const results = await pass;
    expect(results.map(r => [r.notice.itemId, r.status, r.reason])).toEqual([
      ['a', 'sent', undefined], ['b', 'unavailable', 'sender-timeout'],
      ['c', 'unavailable', 'sender-timeout'], ['d', 'unavailable', 'pass-deadline-exceeded'],
    ]);
    expect(sender.mock.calls.map(([notice]) => notice.itemId)).toEqual(['a', 'b', 'c']);
    const before = readFileSync(ledgerPath, 'utf8');
    expect(before.trim().split('\n')).toHaveLength(1);
    resolveLate({ status: 'sent', receipt: 'late' });
    await vi.runAllTimersAsync();
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
    const snapshot = snapshotAfterSend(previous, current, new Set(results.filter(r => r.status === 'unavailable').map(r => r.notice.itemId)));
    expect(snapshot).toEqual([current[0], ...previous.slice(1)]);
    const retry = planNotifications(diffBoard(snapshot, current), readBoardNotifySent(ledgerPath)!).notices;
    expect(retry.map(n => n.itemId)).toEqual(['b', 'c', 'd']);
    const recovered = await sendNotifications(retry, {
      senders: { fake: () => ({ status: 'duplicate', receipt: 'original-receipt' }) }, ledgerPath,
    });
    expect(recovered.map(r => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
  });
});
