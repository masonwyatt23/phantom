import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSlackOrderNoticeSender, planOrderMergeNotices, readOrderNoticeLedger, sendOrderMergeNotices,
  type OrderMergeNoticeSenders } from '../src/core/fleet/order-merge-notice.js';
import { readOrderTrace, type OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { SlackCall } from '../src/core/agents/slack-transport.js';

// Legacy-heading Slack orders (source 'slack', no entry id, leader-network
// requestId) merge-notice into the order's own thread. The binding is the
// durable route in <runs>/leader/network-state.json; delivery is the existing
// gated transport with a plainly fake Slack call. All ids are fake.
const FAKE_CHANNEL = 'C0FAKE0001';
const THREAD_TS = '1700000000.000100';
const CHANNEL_REF = `slack:T0TEAM:${FAKE_CHANNEL}:${THREAD_TS}`;
const JOB = 'RQ-PHX-FAKE370';
const ORDER_KEY = '11-13 13:13';
const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const ownerEnvelope = {
  id: 'slack-owner-fake370req', from: 'mason', to: 'leader', priority: 'P0' as const, ttl: 7 * 24 * 60 * 60 * 1000,
  body: { text: 'Fake slack order' }, channel: 'slack' as const, channel_ref: CHANNEL_REF,
  sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true }, external: false, origin_bridge: 'leader-network',
};
const requestId = sha256(['slack', ownerEnvelope.id]);
const ENTRY = `ln-${requestId.slice(0, 24)}`;

const configText = `[mason]\nidentities=[{channel="slack",id="U0OWNER"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"},{channel="slack",id="U0PEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0TEAM"\nown_user_id="U0BOT"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${FAKE_CHANNEL}"\n`;

let root: string;
let runs: string;
let config: string;
const sources = { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy' } as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'order-notice-slack-370-'));
  runs = join(root, 'runs');
  config = join(root, 'config');
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(config, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const writeBinding = (dir: string): void => {
  mkdirSync(join(dir, 'leader'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'leader', 'network-state.json'), JSON.stringify({
    version: 1, startedAt: 1699999999000, lastMasonAt: 1700000000000,
    routes: {
      [requestId]: {
        channel: 'slack', recipient: 'U0OWNER', channelRef: CHANNEL_REF, receivedAt: 1700000000000,
        inbox: true, bus: true, fingerprint: sha256([ownerEnvelope, 'U0OWNER']), message: ownerEnvelope,
      },
    },
    digests: {},
  }), { mode: 0o600 });
};

const slackTrace = (jobs = [{ id: JOB, lane: null, state: 'merged' as const, url: 'https://example.com/fake' }]): OrderTraceV1 => ({
  v: 1, generatedAt: '', sources: { ...sources },
  orders: [{ at: '2026-11-13 13:13', source: 'slack', requestId, key: ORDER_KEY, jobs }],
});

const sender = (call: SlackCall): OrderMergeNoticeSenders =>
  ({ slack: createSlackOrderNoticeSender({ runsDir: runs, configDir: config, call }) });

const fakeCall = (over: { info?: Record<string, unknown>; post?: (body: Record<string, unknown>) => Record<string, unknown> } = {}): SlackCall =>
  vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T0TEAM', user_id: 'U0BOT', bot_id: 'B0BOT' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_channel: true, context_team_id: 'T0TEAM', ...over.info } };
    if (method === 'conversations.members') return { members: ['U0BOT', 'U0OWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0TEAM', is_bot: body.user === 'U0BOT' } };
    if (method === 'chat.postMessage') return over.post ? over.post(body) : { channel: body.channel, ts: '1700000000.000200' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error(`unexpected synthetic method ${method}`);
  });
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
const ledgerText = () => existsSync(join(runs, 'queue', 'order-notices.jsonl'))
  ? readFileSync(join(runs, 'queue', 'order-notices.jsonl'), 'utf8') : '';

it('plans one slack notice for a legacy-heading order with a request id', () => {
  const notices = planOrderMergeNotices(slackTrace(), new Set());
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ channel: 'slack', entryId: ENTRY, key: `${ENTRY}:${JOB}`, jobId: JOB, requestId });
  expect(notices[0]!.text).toBe(`Merged: ${JOB} for your ${ORDER_KEY} order (https://example.com/fake).`);
});

it('posts one same-thread reply and ledgers sent; a second run posts nothing', async () => {
  writeBinding(runs);
  const call = fakeCall();
  const senders = sender(call);
  expect(await sendOrderMergeNotices(runs, planOrderMergeNotices(slackTrace(), new Set()), senders))
    .toEqual({ sent: 1, skipped: 0, failed: 0 });
  expect(posts(call)).toHaveLength(1);
  expect(posts(call)[0]![1]).toMatchObject({ channel: FAKE_CHANNEL, thread_ts: THREAD_TS });
  expect(ledgerText()).toContain(`"key":"${ENTRY}:${JOB}"`);
  expect(ledgerText()).toContain('"status":"sent"');
  // Re-planned against the ledger there is no notice left; even a repeated
  // send call is deduped by the ledger inside the lock.
  expect(planOrderMergeNotices(slackTrace(), readOrderNoticeLedger(runs))).toEqual([]);
  expect(await sendOrderMergeNotices(runs, planOrderMergeNotices(slackTrace(), new Set()), senders))
    .toEqual({ sent: 0, skipped: 0, failed: 0 });
  expect(posts(call)).toHaveLength(1);
});

it('fails without a durable binding and retries the notice next run', async () => {
  const call = fakeCall();
  const senders = sender(call);
  expect(await sendOrderMergeNotices(runs, planOrderMergeNotices(slackTrace(), new Set()), senders))
    .toEqual({ sent: 0, skipped: 0, failed: 1 });
  expect(readOrderNoticeLedger(runs)).toEqual(new Set());
  expect(call).not.toHaveBeenCalled();
  // The notice is not ledgered, so the next pass plans and sends it.
  writeBinding(runs);
  expect(await sendOrderMergeNotices(runs, planOrderMergeNotices(slackTrace(), readOrderNoticeLedger(runs)), senders))
    .toEqual({ sent: 1, skipped: 0, failed: 0 });
  expect(posts(call)).toHaveLength(1);
});

it('fails when the Slack delivery policy is missing', async () => {
  writeBinding(runs);
  const empty = join(root, 'empty-config');
  mkdirSync(empty, { mode: 0o700 });
  const call = fakeCall();
  const senders = { slack: createSlackOrderNoticeSender({ runsDir: runs, configDir: empty, call }) };
  expect(await sendOrderMergeNotices(runs, planOrderMergeNotices(slackTrace(), new Set()), senders))
    .toEqual({ sent: 0, skipped: 0, failed: 1 });
  expect(ledgerText()).not.toContain(`${ENTRY}:${JOB}`);
  expect(call).not.toHaveBeenCalled();
});

it('fails on an audience gate refusal and never falls back to a top-level post', async () => {
  writeBinding(runs);
  const call = fakeCall({ info: { is_shared: true } });
  expect(await sendOrderMergeNotices(runs, planOrderMergeNotices(slackTrace(), new Set()), sender(call)))
    .toEqual({ sent: 0, skipped: 0, failed: 1 });
  expect(readOrderNoticeLedger(runs)).toEqual(new Set());
  expect(posts(call)).toHaveLength(0);
});

it('fails on an uncertain delivery and never reposts while unproved', async () => {
  writeBinding(runs);
  const call = fakeCall({ post: _body => ({ channel: 'C0OTHER00', ts: '1700000000.000200' }) });
  const notices = planOrderMergeNotices(slackTrace(), new Set());
  expect(await sendOrderMergeNotices(runs, notices, sender(call))).toEqual({ sent: 0, skipped: 0, failed: 1 });
  expect(readOrderNoticeLedger(runs)).toEqual(new Set());
  expect(posts(call)).toHaveLength(1);
  // The retained intent reconciles through conversations.replies rather than reposting.
  expect(await sendOrderMergeNotices(runs, notices, sender(call))).toEqual({ sent: 0, skipped: 0, failed: 1 });
  expect(posts(call)).toHaveLength(1);
  expect(readOrderNoticeLedger(runs)).toEqual(new Set());
});

it('keeps channel-line notices byte-identical', () => {
  const trace: OrderTraceV1 = {
    v: 1, generatedAt: '', sources: { ...sources },
    orders: [{ at: '', source: 'desktop (desk-fake)', key: '11-01 00:08',
      jobs: [{ id: 'RQ-FAKE3', lane: null, state: 'merged', url: 'https://example.com/fake' }] }],
  };
  expect(planOrderMergeNotices(trace, new Set())).toEqual([{
    key: 'desk-fake:RQ-FAKE3', entryId: 'desk-fake', jobId: 'RQ-FAKE3', channel: 'desktop',
    text: 'Merged: RQ-FAKE3 for your 11-01 00:08 order (https://example.com/fake).',
  }]);
});

it('plans nothing for a slack source without a 64-hex request id', () => {
  const trace = slackTrace();
  delete trace.orders[0]!.requestId;
  expect(planOrderMergeNotices(trace, new Set())).toEqual([]);
  trace.orders[0]!.requestId = 'f'.repeat(63);
  expect(planOrderMergeNotices(trace, new Set())).toEqual([]);
  trace.orders[0]!.requestId = 'F'.repeat(64);
  expect(planOrderMergeNotices(trace, new Set())).toEqual([]);
});

it('carries a real legacy slack heading through the trace to one threaded reply', async () => {
  writeBinding(runs);
  writeFileSync(join(runs, 'leader', 'MASON-INBOX.md'),
    `## 2026-11-13 13:13 ET (Operator, slack) PRIORITY P0 [request-sha256:${'a'.repeat(64)}] [leader-network:${requestId}]\nFake slack order\n`);
  mkdirSync(join(runs, 'queue', 'prompts'), { recursive: true });
  writeFileSync(join(runs, 'queue', 'prompts', `${JOB}.md`), "Serves Mason's Nov 13 13:13 order");
  mkdirSync(join(runs, 'metrics'), { recursive: true });
  writeFileSync(join(runs, 'metrics', 'jobs.jsonl'),
    `${JSON.stringify({ job: JOB, state: 'merged', url: 'https://example.com/fake' })}\n`);
  const trace = await readOrderTrace({ runsDir: runs });
  expect(trace.orders[0]).toMatchObject({ source: 'slack', requestId, key: ORDER_KEY });
  const notices = planOrderMergeNotices(trace, new Set());
  expect(notices).toHaveLength(1);
  const call = fakeCall();
  expect(await sendOrderMergeNotices(runs, notices, sender(call))).toEqual({ sent: 1, skipped: 0, failed: 0 });
  expect(posts(call)).toHaveLength(1);
  expect(posts(call)[0]![1]).toMatchObject({ channel: FAKE_CHANNEL, thread_ts: THREAD_TS });
});
