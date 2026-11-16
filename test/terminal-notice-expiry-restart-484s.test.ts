import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('keeps a reported return quiet through receipt expiry after file-backed restarts, while a real expiry releases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-expiry-484s-'));
  chmodSync(dir, 0o700); dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl');
  const root = join(dir, 'runs');
  const paths = claimNoticePaths(root);
  const repo = 'fake/terminal';
  const thread = 'T000FAKE/C000FAKE/1700000000.000001';
  const sibling = 'T000FAKE/C000FAKE/1700000000.000002';
  const head = 'abcdef1234567';
  let now = Date.parse('2026-11-16T00:00:00Z');
  const options = () => ({ path: ledger, now, reap: false });
  const sends: { threadKey: string; text: string; key: string }[] = [];
  const pass = () => runClaimNoticePass({
    ...claimNoticeFileDeps(root), readBoard: () => readFleetBoard(options()), now: () => now,
    send: (threadKey, text, key) => { sends.push({ threadKey, text, key }); return { ok: true }; },
  });
  const bind = (claimId: string, threadKey: string, boundHead: string) => {
    expect(appendClaimThreadBinding(paths.bindings, { claimId, repo, threadKey, pr: 7, head: boundHead }, now).ok).toBe(true);
  };
  const snapshot = () => JSON.parse(readFileSync(paths.prev, 'utf8'));
  const sentRows = () => readFileSync(paths.sent, 'utf8').trim().split('\n').map(line => JSON.parse(line));

  expect(postFleetMessage({ from: 'seed', to: 'all', body: 'fixture seed', ttlMs: 1 }, options()).ok).toBe(true);
  now += 2;
  expect(readFleetBoard(options())).toMatchObject({ state: 'known', claims: [], messages: [] });
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
  expect(snapshot()).toMatchObject({ state: 'known', claims: [], messages: [], asOf: now });

  const result = claimFleetWork({ repo, task: 'synthetic terminal task', agent: 'fake-agent', ttlMs: 60_000 }, options());
  if (!result.ok) throw new Error(result.error);
  bind(result.value.claim.id, thread, head);
  now++;
  expect((await pass()).deliveries).toMatchObject([{ state: 'ASSIGNED', threadKey: thread, result: 'sent' }]);
  now++;
  const returned = returnFleetClaim({ id: result.value.claim.id, agent: 'fake-agent', lease: result.value.lease,
    pr: 7, head, ttlMs: 1000 }, options());
  expect(returned).toMatchObject({ ok: true, outcome: 'returned' });
  if (!returned.message) throw new Error('missing return receipt');
  const receipt = returned.message;
  now++;
  const verified = await pass();
  const verifiedKey = JSON.stringify(['VERIFIED', result.value.claim.id, head]);
  expect(verified.deliveries).toMatchObject([{ state: 'VERIFIED', threadKey: thread, result: 'sent', dedupeKey: verifiedKey }]);
  expect(sends.at(-1)?.text).toContain('fake/terminal#7@abcdef1');
  expect(snapshot()).toMatchObject({ claims: [], messages: [receipt], asOf: now });
  expect(sentRows().map(row => row.key)).toEqual([JSON.stringify(['ASSIGNED', result.value.claim.id, head]), verifiedKey]);
  const coordinationBytes = readFileSync(ledger);
  const sentBytes = readFileSync(paths.sent);
  const bindingBytes = readFileSync(paths.bindings);

  for (const at of [receipt.expiresAt - 1, receipt.expiresAt, receipt.expiresAt + 1]) {
    now = at;
    const board = readFleetBoard(options());
    expect(board.claims).toEqual([]);
    expect(board.messages).toEqual(at < receipt.expiresAt ? [receipt] : []);
    expect(await pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0, deliveries: [] });
    expect(snapshot()).toMatchObject({ state: 'known', claims: [], messages: board.messages, asOf: at });
    expect(readFileSync(ledger)).toEqual(coordinationBytes);
    expect(readFileSync(paths.sent)).toEqual(sentBytes);
    expect(readFileSync(paths.bindings)).toEqual(bindingBytes);
  }
  expect(sends).toHaveLength(2);
  expect(sends.map(s => s.threadKey)).toEqual([thread, thread]);
  expect(sentRows().map(row => row.key)).toEqual([JSON.stringify(['ASSIGNED', result.value.claim.id, head]), verifiedKey]);

  // A different live claim really expires: its release must remain routable.
  const control = claimFleetWork({ repo, task: 'synthetic expiry control', agent: 'fake-control', ttlMs: 100 }, options());
  if (!control.ok) throw new Error(control.error);
  const controlHead = '1234567abcdef';
  bind(control.value.claim.id, sibling, controlHead);
  now++;
  expect((await pass()).deliveries).toMatchObject([{ state: 'ASSIGNED', threadKey: sibling, result: 'sent' }]);
  expect(snapshot().claims).toEqual([control.value.claim]);
  const controlBytes = readFileSync(ledger);
  now = control.value.claim.expiresAt;
  const releaseKey = JSON.stringify(['RELEASED', repo, control.value.claim.id, 'fake-control', control.value.claim.claimedAt, controlHead]);
  expect((await pass()).deliveries).toMatchObject([{ state: 'RELEASED', threadKey: sibling, result: 'sent', dedupeKey: releaseKey }]);
  expect(sends.at(-1)?.text).toContain('claim expired');
  expect(snapshot()).toMatchObject({ claims: [], messages: [], asOf: now });
  expect(sentRows().map(row => row.key)).toEqual([
    JSON.stringify(['ASSIGNED', result.value.claim.id, head]), verifiedKey,
    JSON.stringify(['ASSIGNED', control.value.claim.id, controlHead]), releaseKey,
  ]);
  expect(readFileSync(ledger)).toEqual(controlBytes);
  now++;
  expect((await pass()).deliveries).toEqual([]);
  expect(sends).toHaveLength(4);
});
