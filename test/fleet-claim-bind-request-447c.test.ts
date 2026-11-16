import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetClaimBind } from '../src/cli/fleet-claim-bind.js';
import { ashlrHome } from '../src/core/cloud/store.js';
import type { listWorkBoard, WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';
import { claimNoticeDir, claimNoticePaths, readClaimThreadBindings } from '../src/core/fleet/claim-notice-send.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const threadKey = 'T0FAKE01/C0FAKE01/1700000000.000100';
const item = (id: string, channel: string, channelRef: string | null): WorkBoardItem => ({
  id, channel, channelRef, receivedAt: new Date(now).toISOString(), state: 'RECEIVED',
  asOf: new Date(now).toISOString(), source: 'fake-inbox', missing: [], owner: null, claimReceipt: null,
});

describe('fleet claim-bind --request (447c)', () => {
  let root: string;
  let board: WorkBoardResult;
  const listBoard = vi.fn<typeof listWorkBoard>();
  const bindings = () => claimNoticePaths(claimNoticeDir(root)).bindings;
  const bind = (args: string[], fleetRoot?: string) => cmdFleetClaimBind(args, {
    runsRoot: root, now: () => now, listBoard, ...(fleetRoot !== undefined ? { fleetRoot } : {}),
  });
  const requestArgs = (request: string) => ['claim-fake-1', '--repo', 'fake-org/fake-repo', '--request', request, '--json'];
  const lastJson = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])) as Record<string, unknown>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claim-bind-request-447c-'));
    board = { inbox: 'ok', truncated: false, items: [
      item('wi-fake-1', 'slack', threadKey),
      item('wi-fake-2', 'telegram', null),
      item('wi-fake-3', 'slack', null),
    ] };
    listBoard.mockReset().mockImplementation(() => board);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('binds the exact Slack reference and reads the bounded board from the supplied root', async () => {
    const fleetRoot = join(root, 'fake-fleet');
    expect(await bind(requestArgs('wi-fake-1'), fleetRoot)).toBe(0);
    expect(listBoard).toHaveBeenCalledExactlyOnceWith({ root: fleetRoot, now, limit: 100 });
    expect(lastJson()).toEqual({ status: 'bound', claimId: 'claim-fake-1', repo: 'fake-org/fake-repo',
      request: 'wi-fake-1', threadKey });
    expect(readClaimThreadBindings(bindings())).toEqual([
      { claimId: 'claim-fake-1', repo: 'fake-org/fake-repo', threadKey },
    ]);
  });

  it('uses the same default board root as fleet work-board', async () => {
    expect(await bind(requestArgs('wi-fake-1'))).toBe(0);
    expect(listBoard).toHaveBeenCalledExactlyOnceWith({ root: join(ashlrHome(), 'fleet'), now, limit: 100 });
  });

  it.each([
    ['wi-fake-2', 'request-not-slack'],
    ['wi-fake-3', 'request-thread-invalid'],
    ['wi-fake-unknown', 'request-not-found'],
  ])('refuses %s without creating a bindings file', async (request, reason) => {
    expect(await bind(requestArgs(request))).toBe(1);
    expect(lastJson()).toEqual({ status: 'refused', reason, claimId: 'claim-fake-1', repo: 'fake-org/fake-repo', request });
    expect(existsSync(bindings())).toBe(false);
  });

  it('refuses an unavailable inbox even if it contains a matching item', async () => {
    board.inbox = 'unavailable';
    expect(await bind(requestArgs('wi-fake-1'))).toBe(1);
    expect(lastJson()).toEqual({ status: 'refused', reason: 'request-board-unavailable',
      claimId: 'claim-fake-1', repo: 'fake-org/fake-repo', request: 'wi-fake-1' });
    expect(existsSync(bindings())).toBe(false);
  });

  it('refuses an invalid non-null Slack reference', async () => {
    board.items[0]!.channelRef = 'fake-invalid-thread';
    expect(await bind(requestArgs('wi-fake-1'))).toBe(1);
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'request-thread-invalid' });
    expect(existsSync(bindings())).toBe(false);
  });

  it('refuses duplicate request ids instead of choosing a thread', async () => {
    board.items.push(item('wi-fake-1', 'slack', 'T0FAKE01/C0FAKE01/1700000000.000200'));
    expect(await bind(requestArgs('wi-fake-1'))).toBe(1);
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'request-not-found' });
    expect(existsSync(bindings())).toBe(false);
  });

  it('rejects --thread together with --request before reading or writing', async () => {
    expect(await bind([...requestArgs('wi-fake-1'), '--thread', threadKey])).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(listBoard).not.toHaveBeenCalled();
    expect(existsSync(bindings())).toBe(false);
  });

  it('keeps plain --thread output and binding behavior unchanged without reading the board', async () => {
    expect(await bind(['claim-fake-1', '--repo', 'fake-org/fake-repo', '--thread', threadKey, '--json'])).toBe(0);
    expect(lastJson()).toEqual({ status: 'bound', claimId: 'claim-fake-1', repo: 'fake-org/fake-repo', threadKey });
    expect(readClaimThreadBindings(bindings())).toEqual([
      { claimId: 'claim-fake-1', repo: 'fake-org/fake-repo', threadKey },
    ]);
    expect(listBoard).not.toHaveBeenCalled();
  });
});
