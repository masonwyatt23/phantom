/** Exercises `fleet work-board-changes` against a real durable bus in a
 * private tmp ASHLR_HOME. Fixtures are plainly fake; labels and tokens grant
 * no authority and no token may appear in output. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { cmdFleetWorkBoardChanges } from '../src/cli/fleet-work-board-changes.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { ashlrHome } from '../src/core/cloud/store.js';

let root: string, scratch: string, now: number, savedAshlrHome: string | undefined;
const TTL = 10_000_000, REF_A = 'T0FAKEWS/C0FAKECH/1700000000.000001', iso = (ms: number) => new Date(ms).toISOString();
const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-peer-agent', to: 'fake-lane', priority: 'P2', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-peer-agent', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'slack-coordination', text: 'fake request text' },
});
const busRequest = (id: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL, body: { kind: 'work' },
});
const seed = () => {
  for (const envelope of [slackRequest('slack-request-a', REF_A), busRequest('bus-request-b')])
    expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
};
const snapshot = (): string => {
  const file = join(scratch, 'previous-board.json');
  writeFileSync(file, JSON.stringify({ ...listWorkBoard({ root, now }), asOf: iso(now) }), { mode: 0o600 });
  return file;
};
const lines = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.map((call: unknown[]) => String(call[0]));

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'work-board-changes-318-'));
  chmodSync(scratch, 0o700);
  // The verb reads only the default root: point ASHLR_HOME at a private dir
  // per test so each case posts into an empty durable bus.
  savedAshlrHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = join(scratch, '.ashlr');
  root = join(ashlrHome(), 'fleet');
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = savedAshlrHome;
  rmSync(scratch, { recursive: true, force: true });
});

describe('cmdFleetWorkBoardChanges', { timeout: 60_000 }, () => {
  it('prints only the item that moved, and --json the same delta', async () => {
    expect(resolveFleetSubcommand('work-board-changes')).toEqual(
      { module: './fleet-work-board-changes.js', exportName: 'cmdFleetWorkBoardChanges' });
    seed();
    const previous = snapshot();
    now += 1_000;
    expect(postBusReply('slack-request-a', 'fake-reply-blocked', { blocked: { dependency: 'fake-dep' } },
      { root, now: () => now }).outcome).toBe('posted');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoardChanges(['--previous', previous])).toBe(0);
    expect(lines(log)).toEqual([
      `slack-request-a RECEIVED->BLOCKED channel=slack ref=${REF_A} missing=none`,
      `changes=1 inbox=ok as-of=${iso(now)}`,
    ]);
    expect(await cmdFleetWorkBoardChanges(['--previous', previous, '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ inbox: 'ok', previous: 'ok', asOf: iso(now) });
    expect(parsed.changes).toEqual([{ id: 'slack-request-a', channel: 'slack', channelRef: REF_A,
      from: 'RECEIVED', to: 'BLOCKED', asOf: iso(now), missing: [] }]);
    expect(lines(log).join('\n')).not.toMatch(/[a-f0-9]{64}/);
  });

  it('an unreadable --previous reports previous=unreadable and lists new items', async () => {
    seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoardChanges(['--previous', join(scratch, 'missing.json')])).toBe(0);
    expect(lines(log)).toEqual([
      'bus-request-b none->RECEIVED channel=bus ref=none missing=named owner,durable claim receipt',
      `slack-request-a none->RECEIVED channel=slack ref=${REF_A} missing=named owner,durable claim receipt`,
      'previous=unreadable',
      `changes=2 inbox=ok as-of=${iso(now)}`,
    ]);
    const bogus = join(scratch, 'bogus.json');
    writeFileSync(bogus, '{"items":"nope"}', { mode: 0o600 });
    expect(await cmdFleetWorkBoardChanges(['--previous', bogus, '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed.previous).toBe('unreadable');
    expect(parsed.changes).toHaveLength(2);
  });

  it('without --previous every current item diffs as new and --thread keeps its thread', async () => {
    seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoardChanges(['--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed.previous).toBe('none');
    expect(parsed.changes.map((c: { id: string }) => c.id)).toEqual(['bus-request-b', 'slack-request-a']);
    expect(await cmdFleetWorkBoardChanges(['--thread', REF_A])).toBe(0);
    const got = lines(log).slice(-2);
    expect(got[0]).toBe(`slack-request-a none->RECEIVED channel=slack ref=${REF_A} missing=named owner,durable claim receipt`);
    expect(got[1]).toBe(`changes=1 inbox=ok as-of=${iso(now)}`);
  });

  it('exits 2 on a relative --previous and on bad or duplicate flags; --help prints usage', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoardChanges(['--previous', 'relative/path.json'])).toBe(2);
    expect(await cmdFleetWorkBoardChanges(['--previous'])).toBe(2);
    expect(await cmdFleetWorkBoardChanges(['--limit', '0'])).toBe(2);
    expect(await cmdFleetWorkBoardChanges(['--limit', '101'])).toBe(2);
    expect(await cmdFleetWorkBoardChanges(['--bogus'])).toBe(2);
    expect(await cmdFleetWorkBoardChanges(['--thread', REF_A, '--thread', 'x'])).toBe(2);
    expect(await cmdFleetWorkBoardChanges(['--json', '--json'])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    expect(await cmdFleetWorkBoardChanges(['--help'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toContain('fleet work-board-changes');
  });
});
