import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

const START = Date.parse('2026-11-15T06:00:00.000Z');
const FIRST_REPLY_MS = START + 30_000;
const SECOND_REPLY_MS = START + 45_000;
const THIRD_REPLY_MS = START + 60_000;
const DEADLINE_MS = 40;
const FOOTER = 'Reachability only; this is not an assignment or claim.';
const FORBIDDEN = /\b(?:ASSIGNED|RUNNING|VERIFIED)\b/;
let directory: string;
let ledger: string;
let previousPath: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'slack-bridge-416s-'));
  ledger = join(directory, 'coordination.jsonl');
  previousPath = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousPath === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
  else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previousPath;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void } {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

describe('Slack bridge reply while a peer reader stalls then recovers', () => {
  it('answers BLOCKED within the reader deadline, then READY on a fresh read', async () => {
    // Seed the real claims ledger before fake timers: the claim writer takes
    // wall-clock locks, and every later read stays deterministic via explicit
    // `now` values plus a faked Date.now inside readFleetBoard.
    writeFileSync(ledger, '', { mode: 0o600 });
    expect(claimFleetWork(
      { repo: 'example/repo', task: 'partial-recovery-416s', agent: 'dot', ttlMs: 3_600_000 },
      { now: START },
    )).toMatchObject({ ok: true });

    // Peer reads are scripted per call: stall-then-resolve, clean, stall-then-
    // reject. Only the first and third asks see a stall; the middle one proves
    // the same adapter reports a fresh READY without being rebuilt.
    const stalledResolve = deferred();
    const stalledReject = deferred();
    const peerReads = [stalledResolve.promise, null, stalledReject.promise];
    let peerCalls = 0;
    const peers = () => {
      const scripted = peerReads[peerCalls];
      peerCalls += 1;
      return scripted ?? Promise.resolve({ status: 'ok', asOf: new Date(Date.now()).toISOString(), peers: [] });
    };
    const owners = vi.fn(async () => 'ownership must not run for a bridge ask');
    const adapter = ownerStatusReply({
      owners,
      bridge: async now => formatBridgeCheckReply(await readFleetBridgeCheck({
        runtime: async () => ({
          status: 'ok',
          host: 'macbook-pro',
          stateRoot: '/fake-state-root',
          asOf: new Date(FIRST_REPLY_MS).toISOString(),
          lastFleetStateRead: { ageSeconds: 12 },
        }),
        peers,
        now: () => now.getTime(),
        deadlineMs: DEADLINE_MS,
      }), now),
    });

    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // First ask: the peer reader never settles inside its deadline, so the
      // verdict is BLOCKED naming peers while every other section stays real.
      vi.setSystemTime(FIRST_REPLY_MS);
      expect(adapter.ask('bridge?')).toBe(true);
      const before = readFileSync(ledger);
      const pending = adapter.compose('/fake-runs', new Date(FIRST_REPLY_MS), 'bridge?');
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 10);
      const blocked = await pending;
      const after = readFileSync(ledger);

      expect(after).toEqual(before);
      expect(blocked).toContain(`Bridge: BLOCKED as of ${new Date(FIRST_REPLY_MS).toISOString()} · missing peers`);
      expect(blocked).toContain('Runtime: ok · fleet-state age 12s · host macbook-pro · stateRoot /fake-state-root');
      expect(blocked).toContain('Claims: 1 live, newest 30s');
      expect(blocked).toContain('Peers: unavailable');
      expect(blocked.length).toBeLessThanOrEqual(600);
      expect(blocked.endsWith(FOOTER)).toBe(true);
      expect(blocked).not.toMatch(FORBIDDEN);
      expect(owners).not.toHaveBeenCalled();
      expect(peerCalls).toBe(1);

      // The stalled reader resolves only after its deadline was lost: the
      // already-composed reply cannot change and nothing rejects unhandled.
      stalledResolve.resolve({ status: 'ok', asOf: new Date(FIRST_REPLY_MS).toISOString(), peers: [] });
      await flushAsync();
      expect(unhandled).not.toHaveBeenCalled();
      expect(blocked).toContain(`Bridge: BLOCKED as of ${new Date(FIRST_REPLY_MS).toISOString()}`);
      expect(blocked).toContain('Peers: unavailable');
      expect(blocked.length).toBeLessThanOrEqual(600);
      expect(blocked.endsWith(FOOTER)).toBe(true);

      // Second ask on the same adapter: peers read cleanly, so the verdict is
      // a fresh READY carrying this reply's own as-of and claim age.
      vi.setSystemTime(SECOND_REPLY_MS);
      const beforeSecond = readFileSync(ledger);
      const ready = await adapter.compose('/fake-runs', new Date(SECOND_REPLY_MS), 'bridge?');
      const afterSecond = readFileSync(ledger);
      expect(afterSecond).toEqual(beforeSecond);
      expect(peerCalls).toBe(2);
      expect(ready).toContain(`Bridge: READY as of ${new Date(SECOND_REPLY_MS).toISOString()}`);
      expect(ready).toContain('Claims: 1 live, newest 45s');
      expect(ready).toContain('Peers: ok');
      expect(ready.length).toBeLessThanOrEqual(600);
      expect(ready.endsWith(FOOTER)).toBe(true);
      expect(ready).not.toMatch(FORBIDDEN);
      expect(owners).not.toHaveBeenCalled();

      // Third ask stalls again and the reader rejects after the deadline: the
      // late rejection is consumed by the attempt race, never unhandled.
      vi.setSystemTime(THIRD_REPLY_MS);
      const beforeThird = readFileSync(ledger);
      const pendingThird = adapter.compose('/fake-runs', new Date(THIRD_REPLY_MS), 'bridge?');
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 10);
      const blockedAgain = await pendingThird;
      expect(readFileSync(ledger)).toEqual(beforeThird);
      expect(blockedAgain).toContain(`Bridge: BLOCKED as of ${new Date(THIRD_REPLY_MS).toISOString()} · missing peers`);
      expect(blockedAgain).toContain('Claims: 1 live, newest 60s');
      expect(blockedAgain).toContain('Peers: unavailable');
      expect(blockedAgain.length).toBeLessThanOrEqual(600);
      expect(blockedAgain.endsWith(FOOTER)).toBe(true);
      expect(peerCalls).toBe(3);

      stalledReject.reject(new Error('late peer reader failure'));
      await flushAsync();
      expect(unhandled).not.toHaveBeenCalled();
      expect(blockedAgain).toContain('Peers: unavailable');
      expect(owners).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
