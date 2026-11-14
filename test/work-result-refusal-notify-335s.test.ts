import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';
import { boardNotifyLedgerKey, boardNotifyLedgerPath, readBoardNotifySent, readBoardNotifySnapshot, type BoardNotice } from '../src/core/fleet/work-board-notify.js';

const ID = 'RQ-PHX-FAKE-335';
const REPLY = 'fake-reply-335';
const THREAD = 'T0FAKEDT/C0FAKEDT/1700000000.000335';
const TTL = 600_000;

describe('refused work results through board notification', () => {
  let root: string, dir: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;
  let slack: ReturnType<typeof vi.fn>, bus: ReturnType<typeof vi.fn>;
  const inbox = () => readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8');
  const evidence = () => collectBusWorkItemEvidence(ID, { root, now }).evidence;
  const item = () => listWorkBoard({ root, now }).items.find(row => row.id === ID);
  const result = async (args: string[]) => {
    const output: string[] = [];
    const code = await cmdFleetWorkResult(['--request-id', ID, '--reply-id', REPLY, '--root', root, ...args],
      { now: () => now }, { output: text => output.push(text) });
    return { code, body: JSON.parse(output.join('')) as { outcome: string; transport: string | null } };
  };
  const notify = async () => {
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'],
      { now: () => now, killed: false, senders: { slack, bus } });
    return { code, report: JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, unknown> };
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'result-refusal-335-'));
    dir = mkdtempSync(join(tmpdir(), 'result-refusal-state-335-'));
    now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-receipt' });
    bus = vi.fn();
    expect(appendBusInbox({ id: ID, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
      channel: 'slack', channel_ref: THREAD,
      sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
      external: false, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not notify verification when a reply ID conflicts with a delivered blocker', async () => {
    expect((await notify()).report).toMatchObject({ status: 'baselined', items: 1 });
    now += 1_000;
    expect(await result(['--blocked', 'waiting on fake dependency'])).toMatchObject({ code: 0, body: { outcome: 'posted' } });
    expect((await notify()).report).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
    expect(slack).toHaveBeenCalledTimes(1);
    expect(slack.mock.calls[0]![0] as BoardNotice).toMatchObject({ itemId: ID, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: THREAD });
    const beforeInbox = inbox(), beforeEvidence = evidence(), beforeClaims = inspectBusWorkClaims(root).claims;
    const beforeSnapshot = readBoardNotifySnapshot(dir);
    const beforeSent = [...readBoardNotifySent(boardNotifyLedgerPath(dir))!];
    expect(beforeClaims).toEqual([]);
    expect(item()).toMatchObject({ state: 'BLOCKED', owner: null, claimReceipt: null });
    now += 1_000;
    expect(await result(['--tests', 'fake suite passed'])).toEqual({ code: 4, body: {
      schema: 'fleet.bus-reply.v1', correlation: 'untrusted-routing-only', outcome: 'transport-refused', transport: 'conflict',
    } });
    expect(inbox()).toBe(beforeInbox);
    expect(evidence()).toEqual(beforeEvidence);
    expect(item()).toMatchObject({ state: 'BLOCKED', owner: null, claimReceipt: null });
    expect((await notify()).report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(readBoardNotifySnapshot(dir)).toEqual(beforeSnapshot);
    expect([...readBoardNotifySent(boardNotifyLedgerPath(dir))!]).toEqual(beforeSent);
    expect(readBoardNotifySent(boardNotifyLedgerPath(dir))!.has(boardNotifyLedgerKey(ID, 'VERIFIED'))).toBe(false);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(bus).not.toHaveBeenCalled();
    expect(inspectBusWorkClaims(root).claims).toEqual(beforeClaims);
  });

  it('does not turn an expired request into result evidence or a verification notice', async () => {
    expect((await notify()).report).toMatchObject({ status: 'baselined', items: 1 });
    const beforeInbox = inbox(), beforeClaims = inspectBusWorkClaims(root).claims;
    now += TTL;
    // The board scans retained history, so expiry alone leaves this item RECEIVED.
    expect(item()).toMatchObject({ state: 'RECEIVED', owner: null, claimReceipt: null });
    const expiredSnapshot = readBoardNotifySnapshot(dir);
    const expiredEvidence = evidence();
    expect(expiredEvidence.verified).toBeUndefined();
    expect(await result(['--tests', 'fake suite passed'])).toMatchObject({ code: 3, body: { outcome: 'request-not-found', transport: null } });
    expect(inbox()).toBe(beforeInbox);
    expect(evidence()).toEqual(expiredEvidence);
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    expect(page).toMatchObject({ status: 'ok', messages: [] });
    // The live inbox filters the request, while the board retains its historical projection.
    expect((await notify()).report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(readBoardNotifySnapshot(dir)).toEqual(expiredSnapshot);
    expect(slack).not.toHaveBeenCalled();
    expect(bus).not.toHaveBeenCalled();
    expect(inspectBusWorkClaims(root).claims).toEqual(beforeClaims);
    expect(beforeClaims).toEqual([]);
  });
});
