/** A durable RESULT prefix cannot bypass receipt qualification after restart. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass,
  type ClaimNoticeSendDeps,
} from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import {
  claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult,
} from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('rejects a malformed durable result, then delivers the real return once to its source thread (490s)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-notice-invalid-490s-'));
  chmodSync(dir, 0o700);
  try {
    const path = join(dir, 'coordination.jsonl');
    const root = join(dir, 'runs');
    const paths = claimNoticePaths(root);
    const repo = 'fake/qualification';
    const threadKey = 'T000FAKE/C000FAKE/1700000000.000490';
    const head = 'abcdef0490abcdef';
    const agent = 'fake-owner';
    let now = Date.parse('2026-11-16T00:00:00Z');
    const options = () => ({ path, now: now += 5_000 });
    const sends: { threadKey: string; text: string; dedupeKey: string }[] = [];
    const send: ClaimNoticeSendDeps['send'] = (threadKey, text, dedupeKey) => {
      sends.push({ threadKey, text, dedupeKey });
      return { ok: true, receipt: `fake-receipt-${sends.length}` };
    };
    const pass = () => {
      now += 5_000;
      // Reconstruct every disk dependency and board reader on every pass.
      return runClaimNoticePass({ ...claimNoticeFileDeps(root),
        readBoard: () => readFleetBoard({ path, now }), send, now: () => now });
    };
    const rows = () => readFileSync(paths.sent, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { v: number; at: number; key: string });
    must(postFleetMessage({ from: 'fake-setup', to: 'all', body: 'fake seed', ttlMs: 1 }, options()));
    expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0, sent: 0 });
    const owned = must(claimFleetWork({ repo, task: 'fake qualification task', agent }, options()));
    const id = owned.claim.id;
    expect(appendClaimThreadBinding(paths.bindings, { claimId: id, repo, threadKey, head }, now).ok).toBe(true);
    const assignedKey = JSON.stringify(['ASSIGNED', id, head]);
    expect(await pass()).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    const assignedRows = [{ v: 1, at: now, key: assignedKey }];
    expect(sends).toEqual([{ threadKey, dedupeKey: assignedKey, text: expect.stringContaining('ASSIGNED:') }]);
    expect(rows()).toEqual(assignedRows);

    // Valid receipt grammar, but the message id disagrees with its claim id.
    // Keep the canonical return id free for the genuine owner/lease return.
    const invalidBody = `RESULT VERIFIED ${repo} claim ${id} task "fake malformed sentinel": pr #490 head ${head}`;
    const invalid = must(postFleetMessage({ id: 'return-fake-mismatched-claim',
      from: agent, to: 'all', body: invalidBody }, options()));
    const board = readFleetBoard({ path, now });
    expect(board).toMatchObject({ state: 'known', claims: [owned.claim], messages: [invalid] });
    expect(readFileSync(path, 'utf8')).toContain(JSON.stringify(invalid));
    expect(projectCoordinationReturns(board, now)).toMatchObject({ returns: [], unparsed: 1 });
    const rejected = await pass();
    expect(rejected).toMatchObject({ status: 'completed', planned: 0, sent: 0, failed: 0, deliveries: [] });
    expect(sends).toHaveLength(1); // No VERIFIED, BLOCKED or RELEASED escaped.
    expect(rows()).toEqual(assignedRows); // No invented delivery ledger row.
    const beforeReturn = readFileSync(paths.prev);
    expect(JSON.parse(beforeReturn.toString()).messages).toEqual([invalid]);

    const returned = returnFleetClaim({ id, agent, lease: owned.lease, pr: 490, head }, options());
    expect(returned).toMatchObject({ ok: true, outcome: 'returned', message: { id: `return-${id}` } });
    expect(readFleetBoard({ path, now }).claims).toEqual([]);
    const verifiedKey = JSON.stringify(['VERIFIED', id, head]);
    const delivered = await pass();
    expect(delivered).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0,
      deliveries: [{ state: 'VERIFIED', result: 'sent', threadKey, dedupeKey: verifiedKey }] });
    const expectedRows = [...assignedRows, { v: 1, at: now, key: verifiedKey }];
    expect(rows()).toEqual(expectedRows);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ threadKey, dedupeKey: verifiedKey });
    expect(sends[1]!.text).toContain(`VERIFIED: ${agent} ${repo}#490@${head.slice(0, 7)}`);
    expect(sends[1]!.text).toContain(`pr #490 head ${head}`);

    expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
    // Even a lost snapshot update must replay through the durable sent fence.
    writeFileSync(paths.prev, beforeReturn, { mode: 0o600 });
    expect(await pass()).toMatchObject({ status: 'completed', planned: 1, sent: 0, skipped: 1,
      deliveries: [{ state: 'VERIFIED', result: 'ledgered', threadKey, dedupeKey: verifiedKey }] });
    expect(rows()).toEqual(expectedRows);
    expect(sends).toHaveLength(2);
    expect(sends.filter(s => s.text.startsWith('VERIFIED:'))).toHaveLength(1);
    expect(sends.every(s => s.threadKey === threadKey)).toBe(true);
    expect(sends.some(s => s.text.includes(invalidBody) || s.text.includes('fake malformed sentinel'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
