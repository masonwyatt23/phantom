import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig, SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import { slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import { scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it('returns a claimed result through durable bus and original Slack thread once across restart', async () => {
  vi.useFakeTimers();
  let now = Date.parse('2026-11-18T00:00:00Z');
  vi.setSystemTime(now);
  const dir = mkdtempSync(join(tmpdir(), 'slack-result-575s-'));
  chmodSync(dir, 0o700); dirs.push(dir);
  const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs');
  const busRoot = join(dir, 'bus'), stateRoot = join(dir, 'transport');
  const paths = claimNoticePaths(runsRoot);
  const teamId = 'T000FAKE', channel = 'C000FAKE', thread = '1700000000.000001';
  const threadKey = `${teamId}/${channel}/${thread}`, siblingThread = '1700000000.000002';
  const head = 'abcdef1234567890', agent = 'fake-owner', repo = 'fake/project';
  const config: SlackBridgeConfig = { bridgeId: 'slack', teamId, ownUserId: 'U000BOT', ownBotId: 'B000BOT',
    map: [{ topic: 'fake-topic', channel }] };
  const teamIdentities = [{ channel: 'slack' as const, id: 'U000OWNER' }];
  const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities, slack: config });
  const board = () => readFleetBoard({ path: ledger, now });
  const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig, now: () => now, readBoard: board }));
  const advance = () => { now += 1_000; vi.setSystemTime(now); return { path: ledger, now }; };
  const inbox = () => {
    const scan = scanBusInbox({ root: busRoot, now: () => now });
    expect(scan).toMatchObject({ source: 'available', skipped: 0 });
    return scan.rows.map(row => row.envelope);
  };
  const view = () => readClaimNoticeView({ runsRoot, now: () => now, readBoard: board, readConfig,
    readSendReceipts: () => readSlackSendReceipts({ stateRoot }) });
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, advance()));
  expect(await pass()).toMatchObject({ baselined: true, planned: 0, failed: 0 });
  const owned = must(claimFleetWork({ repo, task: 'fake original task', agent }, advance()));
  const sibling = must(claimFleetWork({ repo: 'fake/other', task: 'unrelated task', agent: 'fake-sibling' }, advance()));
  expect(appendClaimThreadBinding(paths.bindings, { claimId: owned.claim.id, repo, threadKey, pr: 7, head }, now).ok).toBe(true);
  expect(appendClaimThreadBinding(paths.bindings, { claimId: sibling.claim.id, repo: sibling.claim.repo,
    threadKey: `${teamId}/${channel}/${siblingThread}`, pr: 9, head: 'fedcba9876543210' }, now).ok).toBe(true);
  expect(await pass()).toMatchObject({ planned: 2, sent: 2, failed: 0 });
  const assigned = inbox();
  expect(assigned).toHaveLength(2);
  expect(assigned.every(e => e.body.kind === 'note' && e.body.text.startsWith('ASSIGNED:'))).toBe(true);
  expect(readSlackSendReceipts({ stateRoot }).receipts).toEqual([]);

  const posts: Record<string, unknown>[] = [];
  // Every restart gets a new external client and dependency object; only private files survive.
  const transport = () => {
    const call: SlackCall = async (method, input = {}) => {
      if (method === 'auth.test') return { team_id: teamId, user_id: 'U000BOT', bot_id: 'B000BOT' };
      if (method === 'conversations.info') return { channel: { id: input.channel, is_channel: true, context_team_id: teamId } };
      if (method === 'conversations.members') return { members: ['U000BOT', 'U000OWNER'], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: input.user, team_id: teamId, ...(input.user === 'U000BOT' ? { is_bot: true } : {}) } };
      if (method === 'chat.postMessage') {
        posts.push(input);
        expect(input.channel).toBe(channel);
        expect(readSlackSendReceipts({ stateRoot }).receipts).toEqual(expect.arrayContaining([
          expect.objectContaining({ state: 'attempted', channel, thread: input.thread_ts }),
        ]));
        return { channel, ts: `${Math.floor(now / 1000)}.00000${posts.length}` };
      }
      throw new Error(`unexpected Slack method ${method}`);
    };
    return { config: structuredClone(config), teamIdentities: structuredClone(teamIdentities),
      confirmedByMason: true, stateRoot, runsDir: runsRoot, busRoot, call };
  };
  const assignmentBoard = board(), assignmentBytes = readFileSync(ledger, 'utf8');
  for (const envelope of assigned) expect(await deliverSlackEnvelope(envelope, transport())).toMatchObject({ status: 'sent' });
  expect(posts.map(p => p.thread_ts).sort()).toEqual([thread, siblingThread].sort());
  expect(board()).toEqual(assignmentBoard);
  expect(readFileSync(ledger, 'utf8')).toBe(assignmentBytes);

  // VERIFIED is the existing result-receipt label, not a new GitHub verification.
  const returned = returnFleetClaim({ id: owned.claim.id, agent, lease: owned.lease, pr: 7, head }, advance());
  expect(returned).toMatchObject({ ok: true, outcome: 'returned', claimId: owned.claim.id,
    message: { from: agent, body: `RESULT VERIFIED ${repo} claim ${owned.claim.id} task "fake original task": pr #7 head ${head}` } });
  advance();
  const notice = await pass();
  expect(notice).toMatchObject({ planned: 1, sent: 1, failed: 0 });
  const all = inbox();
  const results = all.filter(e => !assigned.some(a => a.id === e.id));
  expect(results).toHaveLength(1);
  const result = results[0]!;
  const text = `VERIFIED: ${agent} ${repo}#7@${head.slice(0, 7)} claim ${owned.claim.id}; pr #7 head ${head}; as of ${new Date(now).toISOString()}`;
  expect(result).toMatchObject({ channel: 'slack', channel_ref: threadKey,
    body: { kind: 'note', text, thread: `slack:${teamId}:${channel}:${thread}`,
      inReplyTo: JSON.stringify(['VERIFIED', owned.claim.id, head]) } });
  expect(notice.deliveries).toEqual([expect.objectContaining({ state: 'VERIFIED', text, threadKey,
    receipt: `bus-note:${result.id}` })]);
  expect(all.some(e => JSON.stringify(e.body).includes('RELEASED:'))).toBe(false);
  expect(all.filter(e => e.channel_ref === `${teamId}/${channel}/${siblingThread}`)).toEqual([
    assigned.find(e => e.channel_ref === `${teamId}/${channel}/${siblingThread}`),
  ]);
  const before = board(), bytes = readFileSync(ledger, 'utf8');
  expect(before.claims).toEqual([sibling.claim]);
  expect(before.messages).toEqual([returned.message]);
  const recent = (await view()).sent.recent;
  expect(recent.find(r => r.state === 'VERIFIED' && r.claimId === owned.claim.id)?.delivery).toBe('no-slack-receipt');
  expect(readSlackSendReceipts({ stateRoot }).receipts.some(r => r.key === slackSendStoreKey(result.id))).toBe(false);
  const delivered = await deliverSlackEnvelope(result, transport());
  expect(delivered).toMatchObject({ status: 'sent', reason: 'delivery-proved' });
  expect(posts.at(-1)).toMatchObject({ channel, thread_ts: thread, text });
  expect(readSlackSendReceipts({ stateRoot })).toMatchObject({ state: 'ok', receipts: expect.arrayContaining([
    { key: slackSendStoreKey(result.id), state: 'sent', channel, thread, ts: delivered.ts },
  ]) });
  advance(); // Collect after the synthetic Slack ts, including its fractional seconds.
  expect((await view()).sent.recent.find(r => r.state === 'VERIFIED' && r.claimId === owned.claim.id)?.delivery).toBe('slack-sent');
  // Re-read the envelope and reconstruct transport after losing all client state.
  advance();
  expect(await deliverSlackEnvelope(inbox().find(e => e.id === result.id)!, transport())).toEqual({
    status: 'duplicate', reason: 'delivery-proved', ts: delivered.ts,
  });
  expect(posts).toHaveLength(3);
  expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0 });
  expect(inbox()).toEqual(all);
  expect(board()).toEqual(before);
  expect(readFileSync(ledger, 'utf8')).toBe(bytes);
});
