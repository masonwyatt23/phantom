import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaimNoticeTick } from '../src/cli/channels-slack-claim-tick.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass, type ClaimNoticeSendDeps } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('claim tick durable outage recovery', () => {
  it.each([
    ['bindings', 'bindings-unavailable', 'claim-bindings-unreadable'],
    ['prev', 'prev-unavailable', 'prev-snapshot-unreadable'],
  ] as const)('preserves and retries a pending assignment when %s is unreadable', async (dependency, status, reason) => {
    const dir = mkdtempSync(join(tmpdir(), 'claim-tick-outage-'));
    dirs.push(dir);
    const root = join(dir, 'runs');
    const paths = claimNoticePaths(root);
    const ledger = join(dir, 'coordination.jsonl');
    const thread = 'T000FAKE/C000FAKE/1700000000.000001';
    const head = 'abcdef1234567';
    let clock = Date.parse('2026-11-16T00:00:00Z');
    let passes = 0;
    const sends: { threadKey: string; dedupeKey: string }[] = [];
    const send: ClaimNoticeSendDeps['send'] = (threadKey, _text, dedupeKey) => {
      sends.push({ threadKey, dedupeKey });
      return { ok: true, receipt: 'fake-receipt' };
    };
    const pass = () => { passes++; return runClaimNoticePass({ ...claimNoticeFileDeps(root),
      readBoard: () => readFleetBoard({ path: ledger, now: clock }), send, now: () => clock }); };
    must(postFleetMessage({ from: 'setup', to: 'all', body: 'fake seed', ttlMs: 1 }, { path: ledger, now: clock }));
    expect(await pass()).toMatchObject({ status: 'completed', baselined: true });
    const claim = must(claimFleetWork({ repo: 'fake/outage', task: 'fake task', agent: 'agent-a' }, { path: ledger, now: ++clock })).claim;
    const binding = appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: 'fake/outage', threadKey: thread, head }, clock);
    if (!binding.ok) throw new Error(binding.reason);
    const key = JSON.stringify(['ASSIGNED', claim.id, head]);
    const target = paths[dependency];
    const original = readFileSync(target);
    // A malformed snapshot or over-budget binding file is present but untrusted.
    writeFileSync(target, dependency === 'prev' ? '{' : Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const prevBefore = readFileSync(paths.prev);
    const sent = () => existsSync(paths.sent) ? readFileSync(paths.sent, 'utf8') : '';
    const sentBefore = sent();
    const tick = createClaimNoticeTick({ now: () => clock, killed: () => false, pass });
    expect(await tick.maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0, status, reason });
    expect(sends).toEqual([]);
    expect(readFileSync(paths.prev)).toEqual(prevBefore);
    expect(sent()).toBe(sentBefore);
    expect(await tick.maybeRun()).toEqual({ ran: false, reason: 'interval' });
    expect(passes).toBe(2);
    writeFileSync(target, original);
    clock += 30_000;
    expect(await tick.maybeRun()).toEqual({ ran: true, sent: 1, deduped: 0, failed: 0 });
    expect(sends).toEqual([{ threadKey: thread, dedupeKey: key }]);
    expect(JSON.parse(sent().trim()).key).toBe(key);
    clock += 30_000;
    expect(await tick.maybeRun()).toEqual({ ran: true, sent: 0, deduped: 0, failed: 0 });
    expect(sends).toHaveLength(1);
  });
});
