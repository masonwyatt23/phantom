/** RQ-PHX-RECHECKHELDSINCE330 — the `fleet recheck --reply` Held line: line 2
 * of the reply when recorded evidence holds the verdict, "Held: unrecorded"
 * when the caller asks and no recorded run backs it, and absent entirely for
 * callers that pass no held argument. Fixtures are plainly fake; every CLI
 * reader is injected so nothing touches the real home, ledger or network. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheck } from '../src/cli/fleet-recheck.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import type { RecheckHeld } from '../src/core/fleet/recheck-held-since.js';
import { RECHECK_RECORD_SCHEMA, type RecheckRecord } from '../src/core/fleet/recheck-record.js';

const ISO = '2026-11-13T12:00:00.000Z';
const SINCE = '2026-11-12T22:30:00.000Z';
const HOME = '/home/fakeuser';

/** Hand-built BLOCKED verdict; never passed through readFleetRecheck. */
function blocked(over: Partial<FleetRecheck> = {}): FleetRecheck {
  return {
    schema: 'fleet.recheck.v1', asOf: ISO,
    sections: {
      runtime: {
        state: 'VERIFIED', source: 'runtime-identity', asOf: ISO,
        host: 'host-a.example', tailnetName: 'fake-tailnet-node',
        installedVersion: '1.2.3', sourceVersion: '1.2.3',
        fleetState: { ageSeconds: 60, stale: false }, missing: [],
      },
      claims: { state: 'VERIFIED', source: 'coordination', asOf: ISO, active: 0, expiredClaims: 0, top: [], missing: [] },
      bridge: {
        state: 'BLOCKED', source: 'channel-health', asOf: ISO,
        channels: [
          { channel: 'slack', state: 'BLOCKED', runtimeHost: null, processAlive: false, missingBridge: 'slack bridge process not running' },
          { channel: 'imessage', state: 'LIVE', runtimeHost: 'host-a.example', processAlive: true, missingBridge: null },
        ],
        missingBridge: 'slack bridge process not running', missing: ['slack bridge process not running'],
      },
      task: { state: 'BLOCKED', source: 'work-board', asOf: ISO, task: null, unowned: 0, unclaimed: 0, missing: ['task: no RUNNING or ASSIGNED board item'] },
    },
    overall: { state: 'BLOCKED', missing: ['slack bridge process not running'] },
    ...over,
  };
}

function record(overall: string, asOf: string): RecheckRecord {
  return {
    schema: RECHECK_RECORD_SCHEMA, asOf, overall,
    sections: {
      runtime: { state: 'VERIFIED', host: 'host-a.example', installedVersion: '1.2.3', asOf },
      claims: { state: 'VERIFIED', active: 0, asOf },
      bridge: { state: 'BLOCKED', missingBridge: 'slack bridge process not running', asOf },
      task: { state: 'BLOCKED', id: null, owner: null, claimReceipt: null, asOf },
      missing: null,
    },
  };
}

describe('formatRecheckReply held line', () => {
  it('inserts the Held line as line 2 and keeps the verdict line last', () => {
    const held: RecheckHeld = { state: 'BLOCKED', since: SINCE, consecutive: 3, truncated: false };
    const lines = formatRecheckReply(blocked(), held).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe(`Held: BLOCKED since ${SINCE} · 3 consecutive recorded checks`);
    expect(lines.at(-1)).toBe('BLOCKED on: slack bridge process not running');
  });

  it('appends "or earlier" when the run is truncated at the window edge', () => {
    const held: RecheckHeld = { state: 'BLOCKED', since: SINCE, consecutive: 50, truncated: true };
    expect(formatRecheckReply(blocked(), held).split('\n')[1])
      .toBe(`Held: BLOCKED since ${SINCE} or earlier · 50 consecutive recorded checks`);
  });

  it('uses the singular "check" for a run of one', () => {
    const held: RecheckHeld = { state: 'BLOCKED', since: SINCE, consecutive: 1, truncated: false };
    expect(formatRecheckReply(blocked(), held).split('\n')[1])
      .toBe(`Held: BLOCKED since ${SINCE} · 1 consecutive recorded check`);
  });

  it('prints Held: unrecorded when null is passed explicitly', () => {
    const lines = formatRecheckReply(blocked(), null).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe('Held: unrecorded');
    expect(lines.at(-1)).toBe('BLOCKED on: slack bridge process not running');
  });

  it('is byte-identical to the no-held output when the argument is absent', () => {
    const fixture = blocked();
    const previous = formatRecheckReply(fixture);
    expect(previous.split('\n')).toHaveLength(6);
    expect(previous).not.toContain('Held:');
    expect(formatRecheckReply(fixture, undefined)).toBe(previous);
  });

  it('scrubs a home path out of held.since', () => {
    const held: RecheckHeld = { state: 'BLOCKED', since: `${SINCE} at /Users/someone/x`, consecutive: 2, truncated: false };
    const reply = formatRecheckReply(blocked(), held);
    expect(reply).not.toContain('/Users/');
    expect(reply.split('\n')[1]).toBe(`Held: BLOCKED since ${SINCE} at ~/x · 2 consecutive recorded checks`);
  });

  it('keeps the reply within 900 characters', () => {
    const held: RecheckHeld = { state: 'BLOCKED', since: SINCE, consecutive: 50, truncated: true };
    const reply = formatRecheckReply(blocked({
      overall: { state: 'BLOCKED', missing: ['x'.repeat(2000)] },
    }), held);
    expect(reply.length).toBeLessThanOrEqual(900);
    expect(reply.endsWith('…')).toBe(true);
  });
});

describe('cmdFleetRecheck --reply held line', () => {
  function cliDeps(rows: RecheckRecord[] | 'throw') {
    const failing = () => { throw new Error('reader unavailable'); };
    return {
      now: () => new Date(ISO),
      homeDir: () => HOME,
      readRuntimeIdentity: failing,
      readFleetBoard: failing,
      readChannelHealth: failing,
      listWorkBoard: failing,
      readRecords: rows === 'throw' ? failing : () => ({ rows, skipped: 0, missing: false }),
    };
  }

  function capture(): { out: string[] } {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { out };
  }

  afterEach(() => vi.restoreAllMocks());

  it('names the recorded hold: UNKNOWN held since the oldest matching row', async () => {
    const { out } = capture();
    const rows = [record('UNKNOWN', ISO), record('UNKNOWN', SINCE), record('BLOCKED', '2026-11-12T21:00:00.000Z')];
    expect(await cmdFleetRecheck(['--reply'], cliDeps(rows))).toBe(0);
    const lines = out[0]!.split('\n');
    expect(lines[1]).toBe(`Held: UNKNOWN since ${SINCE} · 2 consecutive recorded checks`);
    expect(lines.at(-1)).toMatch(/^UNKNOWN: /);
  });

  it('prints Held: unrecorded when the log has no rows for the live verdict', async () => {
    const { out } = capture();
    expect(await cmdFleetRecheck(['--reply'], cliDeps([]))).toBe(0);
    expect(out[0]!.split('\n')[1]).toBe('Held: unrecorded');
  });

  it('prints Held: unrecorded when the newest row differs from the live verdict', async () => {
    const { out } = capture();
    expect(await cmdFleetRecheck(['--reply'], cliDeps([record('BLOCKED', ISO)]))).toBe(0);
    expect(out[0]!.split('\n')[1]).toBe('Held: unrecorded');
  });

  it('prints Held: unrecorded when the record reader throws', async () => {
    const { out } = capture();
    expect(await cmdFleetRecheck(['--reply'], cliDeps('throw'))).toBe(0);
    expect(out[0]!.split('\n')[1]).toBe('Held: unrecorded');
  });
});
