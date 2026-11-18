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
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination write failed: ${result.error}`);
  return result.value;
}

it.each(['thread_not_found', 'channel_not_found', 'access_revoked'])(
  'retains the original attempted assignment through %s and reconciles it when visible', async error => {
    vi.useFakeTimers();
    let now = Date.parse('2026-11-18T00:00:00Z');
    vi.setSystemTime(now);
    const dir = mkdtempSync(join(tmpdir(), 'slack-notice-580s-'));
    chmodSync(dir, 0o700); dirs.push(dir);
    const ledger = join(dir, 'coordination.jsonl'), runsRoot = join(dir, 'runs');
    const busRoot = join(dir, 'bus'), stateRoot = join(dir, 'transport');
    const teamId = 'T000FAKE', channel = 'C000FAKE', thread = '1700000000.000001', ts = '1700000000.000002';
    const threadKey = `${teamId}/${channel}/${thread}`;
    const config: SlackBridgeConfig = { bridgeId: 'slack', teamId, ownUserId: 'U000BOT', ownBotId: 'B000BOT',
      map: [{ topic: 'fake-topic', channel }] };
    const teamIdentities = [{ channel: 'slack' as const, id: 'U000OWNER' }];
    const readConfig = (): AgentNetworkConfig => ({ path: 'synthetic', state: 'ok', teamIdentities, slack: config });
    const pass = () => runClaimNoticePass(claimNoticePassDeps({ runsRoot, busRoot, readConfig, now: () => now,
      readBoard: () => readFleetBoard({ path: ledger, now }) }));
    const advance = () => { now += 1_000; vi.setSystemTime(now); return { path: ledger, now }; };
    must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, advance()));
    expect(await pass()).toMatchObject({ baselined: true, planned: 0 });
    const claim = must(claimFleetWork({ repo: 'fake/alpha', task: 'fake task', agent: 'fake-agent' }, advance())).claim;
    expect(appendClaimThreadBinding(claimNoticePaths(runsRoot).bindings,
      { claimId: claim.id, repo: claim.repo, threadKey }, now).ok).toBe(true);
    const notice = await pass();
    expect(notice).toMatchObject({ planned: 1, sent: 1, failed: 0, deliveries: [{ state: 'ASSIGNED' }] });
    const scan = () => scanBusInbox({ root: busRoot, now: () => now });
    const inbox = scan();
    expect(inbox).toMatchObject({ source: 'available', skipped: 0 });
    expect(inbox.rows).toHaveLength(1);
    const envelope = inbox.rows[0]!.envelope;
    expect(envelope).toMatchObject({ channel: 'slack', channel_ref: threadKey, body: { kind: 'note' } });
    expect(JSON.stringify(envelope.body)).toContain('ASSIGNED');
    expect(JSON.stringify(envelope.body)).not.toContain('VERIFIED');
    expect(notice.deliveries[0]!.receipt).toBe(`bus-note:${envelope.id}`);
    const ledgerBefore = readFileSync(ledger, 'utf8');
    const boardBefore = readFleetBoard({ path: ledger, now });
    expect(boardBefore).toMatchObject({ state: 'known', claims: [claim], proposals: [] });
    const posts: Record<string, unknown>[] = [];
    let visible = false;
    const call = vi.fn<SlackCall>(async (method, input = {}) => {
      if (method === 'auth.test') return { team_id: teamId, user_id: 'U000BOT', bot_id: 'B000BOT' };
      if (method === 'conversations.info') return { channel: { id: input.channel, is_channel: true, context_team_id: teamId } };
      if (method === 'conversations.members') return { members: ['U000BOT', 'U000OWNER'], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: input.user, team_id: teamId, is_bot: input.user === 'U000BOT' } };
      if (method === 'chat.postMessage') { posts.push(input); throw new Error('synthetic-ambiguous-post'); }
      if (method === 'conversations.replies') {
        if (!visible) throw new Error(error);
        return { messages: [{ client_msg_id: posts[0]!.client_msg_id, user: 'U000BOT', ts, thread_ts: thread }],
          response_metadata: { next_cursor: '' } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const inputs = () => ({ config: structuredClone(config), teamIdentities: structuredClone(teamIdentities),
      confirmedByMason: true, stateRoot, runsDir: runsRoot, busRoot, call });
    expect((await deliverSlackEnvelope(envelope, inputs())).status).toBe('uncertain');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel, thread_ts: thread, client_msg_id: expect.any(String) });
    const attempted = { state: 'ok', receipts: [{ key: slackSendStoreKey(envelope.id), state: 'attempted', channel, thread }] };
    expect(readSlackSendReceipts({ stateRoot })).toEqual(attempted);
    const persisted = readFileSync(join(stateRoot, 'messages.json'), 'utf8');
    const replay = scan().rows[0]!;
    expect(replay).toEqual(inbox.rows[0]);
    call.mockClear();
    expect((await deliverSlackEnvelope(replay.envelope, inputs())).status).toBe('uncertain');
    expect(call.mock.calls).toEqual([['auth.test'], ['conversations.replies', { channel, ts: thread, limit: 100 }]]);
    expect(posts).toHaveLength(1);
    expect(readSlackSendReceipts({ stateRoot })).toEqual(attempted);
    expect(readFileSync(join(stateRoot, 'messages.json'), 'utf8')).toBe(persisted);
    advance();
    expect(await pass()).toMatchObject({ planned: 0, sent: 0, failed: 0, deliveries: [] });
    expect(scan().rows).toEqual(inbox.rows);
    expect(readFleetBoard({ path: ledger, now })).toEqual(boardBefore);
    expect(readFileSync(ledger, 'utf8')).toBe(ledgerBefore);
    visible = true;
    call.mockClear();
    expect(await deliverSlackEnvelope(scan().rows[0]!.envelope, inputs())).toEqual({ status: 'sent', reason: 'delivery-reconciled', ts });
    expect(call.mock.calls).toEqual([['auth.test'], ['conversations.replies', { channel, ts: thread, limit: 100 }]]);
    expect(posts).toHaveLength(1);
    expect(readSlackSendReceipts({ stateRoot })).toEqual({ state: 'ok', receipts: [
      { key: slackSendStoreKey(envelope.id), state: 'sent', channel, thread, ts },
    ] });
    expect(readFileSync(ledger, 'utf8')).toBe(ledgerBefore);
  },
);
