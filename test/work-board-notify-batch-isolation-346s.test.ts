/** RQ-PHX-NOTIFYBATCHISOLATION346S — batch isolation for the board →
 * source-thread notifier: when one pass plans notices for two independent
 * work items and the sender can deliver only one, the failed item's
 * pending state must not block, delay or corrupt the other item's update,
 * and recovery must retry only the failed item — never redeliver the
 * successful one. Two real bus requests carry fake Slack channel/thread
 * labels; a BLOCKED receipt posts for A and a VERIFIED test receipt for B
 * through the actual `fleet work-result` CLI, and board passes run through
 * the actual `fleet board-notify` entry point with only transport senders
 * and the clock injected. The deciding pass plans both notices, then a
 * sender that refuses A's source thread while returning a durable receipt
 * for B delivers B exactly once: the report counts match the real sends,
 * only B gains sent-ledger evidence, A keeps its prior snapshot row, and
 * the bus inbox bytes are identical before and after every notifier
 * invocation — notification is not execution. A fresh invocation (new
 * senders, snapshot and ledger re-read from disk) with the transport
 * restored retries A alone into its original thread; one further pass
 * sends neither. Neither the result receipts nor the send receipts acquire,
 * complete or release a claim, and no result or thread crosses between
 * items. The whole scenario runs with A's request inserted before B's and
 * with B's before A's — the board lists newest receipts first, so the two
 * runs put the failing item in both batch positions and success cannot
 * depend on ordering. All roots, hosts, agents and channel refs are fake
 * temporary fixtures; no real transport ever leaves. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';
import {
  boardNotifyLedgerPath, readBoardNotifySent, readBoardNotifySnapshot,
  type BoardNotifySender,
} from '../src/core/fleet/work-board-notify.js';

const ID_A = 'RQ-PHX-FAKE-346-A';
const ID_B = 'RQ-PHX-FAKE-346-B';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000346';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000347';
const REPLY_BLOCKED_A = 'fake-reply-346-a-blocked';
const REPLY_VERIFIED_B = 'fake-reply-346-b-verified';
const DEP = 'waiting on fake-dep-346';
const TESTS_B = 'fake suite green 346-b';
const TTL = 10_000_000;

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'work' },
});

type SlackSender = Mock<BoardNotifySender>;
type Senders = { slack: SlackSender; bus: SlackSender };
interface LedgerRow {
  itemId: string; state: string; channel: string; thread: string | null;
  receipt: string | null; delta?: string;
}

let receiptSeq = 0;
const workingSenders = (): Senders => ({
  slack: vi.fn<BoardNotifySender>(async () => ({ status: 'sent' as const, receipt: `fake-ts-${++receiptSeq}` })),
  bus: vi.fn<BoardNotifySender>(),
});
/** Transport that reaches every thread except A's source thread: the
 * per-item failure this batch must isolate. */
const partialSenders = (): Senders => ({
  slack: vi.fn<BoardNotifySender>(async notice => notice.sourceThread === TS_A
    ? { status: 'unavailable' as const, reason: 'fake transport down' }
    : { status: 'sent' as const, receipt: `fake-ts-${++receiptSeq}` }),
  bus: vi.fn<BoardNotifySender>(),
});

describe('board-notify batch isolation', { timeout: 60_000 }, () => {
  let root: string, dir: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;

  const postRequest = (id: string, ref: string) =>
    expect(appendBusInbox(slackRequest(id, ref), { root, now: () => now }).status).toBe('posted');
  const workResult = async (replyId: string, extra: string[], requestId = ID_A) => {
    const output: string[] = [];
    const code = await cmdFleetWorkResult(
      ['--request-id', requestId, '--reply-id', replyId, '--root', root, ...extra],
      { now: () => now }, { output: text => output.push(text) });
    return { code, result: JSON.parse(output.join('')) as { outcome: string; transport: string | null } };
  };
  const runNotify = async (senders: Senders) => {
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'],
      { senders, now: () => now, killed: false });
    return { code, report: JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, unknown> };
  };
  const boardItem = (id: string) => listWorkBoard({ root, now }).items.find(i => i.id === id);
  const snapshotItem = (id: string) =>
    readBoardNotifySnapshot(dir)?.find(item => item.id === id);
  const ledgerRows = (): LedgerRow[] => {
    try {
      return readFileSync(boardNotifyLedgerPath(dir), 'utf8')
        .split('\n').filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as LedgerRow);
    } catch { return []; }
  };
  const sentKeys = () => [...readBoardNotifySent(boardNotifyLedgerPath(dir))!];
  const inboxIds = () => {
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
  };
  const inboxBytes = () => readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8');
  const noticesOf = (sender: SlackSender) => sender.mock.calls.map(call => call[0]);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'board-notify-batch-346-'));
    dir = mkdtempSync(join(tmpdir(), 'board-notify-batch-state-346-'));
    now = Date.now();
    receiptSeq = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  /** One full scenario; `first` names the item whose request is inserted
   * first. The board lists newest receipts first, so the second insert
   * leads every pass — the two runs put the failing item in both batch
   * positions. */
  const runScenario = async (first: 'A' | 'B') => {
    const posting = first === 'A' ? [ID_A, ID_B] : [ID_B, ID_A];
    const threadOf = (id: string) => (id === ID_A ? TS_A : TS_B);
    posting.forEach((id, index) => {
      postRequest(id, threadOf(id));
      if (index === 0) now += 1_000; // distinct receivedAt: deterministic board order
    });
    // The board — and therefore the notice batch — runs newest-first.
    const batchOrder = [...posting].reverse();

    // Baseline: RECEIVED never notifies.
    let senders = workingSenders();
    let pass = await runNotify(senders);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'baselined', items: 2, planned: 0 });
    expect(senders.slack).not.toHaveBeenCalled();
    expect(senders.bus).not.toHaveBeenCalled();

    // Real result receipts through the actual work-result CLI: A reports
    // BLOCKED on its dependency, B reports VERIFIED on a test artifact.
    now += 60_000;
    const blocked = await workResult(REPLY_BLOCKED_A, ['--blocked', DEP]);
    expect(blocked.code).toBe(0);
    expect(blocked.result.outcome).toBe('posted');
    const verified = await workResult(REPLY_VERIFIED_B, ['--tests', TESTS_B], ID_B);
    expect(verified.code).toBe(0);
    expect(verified.result.outcome).toBe('posted');

    // Freeze the bus bytes: every notifier invocation below must leave
    // the inbox untouched — sends are injected fakes, never the bus.
    const inboxBefore = inboxBytes();

    // The deciding pass: both notices plan; the sender refuses A's source
    // thread and returns a durable receipt for B. B delivers exactly once,
    // A stays pending, and the counts match the real sends.
    senders = partialSenders();
    pass = await runNotify(senders);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({
      status: 'completed', transitions: 2, planned: 2, sent: 1, pending: 1,
    });
    expect(senders.bus).not.toHaveBeenCalled();
    const attempted = noticesOf(senders.slack);
    expect(attempted.map(notice => notice.itemId)).toEqual(batchOrder);
    const noticeA = attempted.find(notice => notice.itemId === ID_A)!;
    const noticeB = attempted.find(notice => notice.itemId === ID_B)!;
    expect(noticeA).toMatchObject({
      state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_A,
      source: `bus-reply:${REPLY_BLOCKED_A}`,
    });
    expect(noticeA.text).toContain(ID_A);
    expect(noticeA.text).toContain(DEP);
    expect(noticeA.text).not.toContain(ID_B);
    expect(noticeA.text).not.toContain(TESTS_B);
    expect(noticeB).toMatchObject({
      state: 'VERIFIED', sourceChannel: 'slack', sourceThread: TS_B,
      source: `bus-reply:${REPLY_VERIFIED_B}`,
    });
    expect(noticeB.text).toContain(ID_B);
    expect(noticeB.text).toContain(TESTS_B);
    expect(noticeB.text).not.toContain(ID_A);
    expect(noticeB.text).not.toContain(DEP);

    // Durable truth after the partial pass: exactly one ledger row — B's —
    // and the sent-key set holds only B's entry+delta keys. A keeps its
    // prior RECEIVED snapshot row so its transition re-fires; B advanced.
    const rowsAfterPartial = ledgerRows();
    expect(rowsAfterPartial).toHaveLength(1);
    expect(rowsAfterPartial[0]).toMatchObject({
      itemId: ID_B, state: 'VERIFIED', channel: 'slack', thread: TS_B,
    });
    expect(rowsAfterPartial[0]!.receipt).toBeTruthy();
    expect(rowsAfterPartial[0]!.delta).toBeTruthy();
    expect(sentKeys()).toHaveLength(2);
    expect(sentKeys().every(key => key.startsWith(`${ID_B} `))).toBe(true);
    expect(sentKeys().some(key => key.startsWith(`${ID_A} `))).toBe(false);
    expect(snapshotItem(ID_A)).toMatchObject({ state: 'RECEIVED' });
    expect(snapshotItem(ID_B)).toMatchObject({ state: 'VERIFIED' });
    expect(inboxBytes()).toBe(inboxBefore);

    // Recovery: a fresh invocation re-reads the snapshot and ledger from
    // disk with new senders; the restored transport retries A alone into
    // its original thread — B is never called again and never re-ledgered.
    senders = workingSenders();
    now += 60_000;
    pass = await runNotify(senders);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({
      status: 'completed', transitions: 1, planned: 1, sent: 1, pending: 0,
    });
    expect(senders.bus).not.toHaveBeenCalled();
    expect(senders.slack).toHaveBeenCalledTimes(1);
    const retry = noticesOf(senders.slack)[0]!;
    expect(retry).toMatchObject({
      itemId: ID_A, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_A,
      source: `bus-reply:${REPLY_BLOCKED_A}`,
    });
    expect(retry.text).toContain(DEP);
    expect(retry.text).not.toContain(TESTS_B);
    expect(ledgerRows().filter(row => row.itemId === ID_B)).toHaveLength(1);
    expect(ledgerRows().filter(row => row.itemId === ID_A)).toHaveLength(1);
    expect(inboxBytes()).toBe(inboxBefore);

    // One further pass: nothing changed but time — no timestamp-only
    // notification fires, nothing is re-sent and the ledger is untouched.
    senders = workingSenders();
    now += 60_000;
    pass = await runNotify(senders);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({
      status: 'completed', transitions: 0, planned: 0, sent: 0, pending: 0,
    });
    expect(senders.slack).not.toHaveBeenCalled();
    expect(senders.bus).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(2);
    expect(inboxBytes()).toBe(inboxBefore);

    // Evidence is not authority: neither the result receipts nor the send
    // receipts acquired, completed or released a claim — the claims table
    // was never even created — and neither item was ever ASSIGNED.
    const claims = inspectBusWorkClaims(root);
    expect(claims.source).toBe('missing');
    expect(claims.claims).toEqual([]);
    expect(boardItem(ID_A)).toMatchObject({ state: 'BLOCKED', owner: null, claimReceipt: null });
    expect(boardItem(ID_B)).toMatchObject({ state: 'VERIFIED', owner: null, claimReceipt: null });
    expect(boardItem(ID_A)!.result).toEqual({ kind: 'blocked', dependency: DEP });
    expect(boardItem(ID_B)!.result).toEqual({ kind: 'verified', pr: null, head: null, tests: TESTS_B, artifact: null });

    // No cross-item leakage: each item's evidence cites only its own
    // reply, every ledger row binds its item to its own thread, and the
    // inbox holds exactly the two requests and two result replies — the
    // injected senders appended nothing.
    const evidenceA = collectBusWorkItemEvidence(ID_A, { root, now }).evidence;
    const evidenceB = collectBusWorkItemEvidence(ID_B, { root, now }).evidence;
    expect(evidenceA.blocker).toMatchObject({ dependency: DEP, source: `bus-reply:${REPLY_BLOCKED_A}` });
    expect(evidenceA.verified).toBeUndefined();
    expect(evidenceB.verified).toMatchObject({ tests: TESTS_B, source: `bus-reply:${REPLY_VERIFIED_B}` });
    expect(evidenceB.blocker).toBeUndefined();
    const rows = ledgerRows();
    expect(rows.find(row => row.itemId === ID_A)).toMatchObject({ state: 'BLOCKED', thread: TS_A });
    expect(rows.find(row => row.itemId === ID_B)).toMatchObject({ state: 'VERIFIED', thread: TS_B });
    for (const id of [ID_A, ID_B]) {
      expect(sentKeys().filter(key => key.startsWith(`${id} `))).toHaveLength(2);
    }
    expect(inboxIds()).toEqual([...posting, REPLY_BLOCKED_A, REPLY_VERIFIED_B]);
  };

  it('a failed source-thread delivery leaves the other item intact and retries alone (A inserted first)', async () => {
    await runScenario('A');
  });

  it('a failed source-thread delivery leaves the other item intact and retries alone (B inserted first)', async () => {
    await runScenario('B');
  });
});
