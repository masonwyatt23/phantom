import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { flushSlackLeaderReplies } from '../src/core/agents/slack-leader.js';
import type { SlackCall } from '../src/core/agents/slack-transport.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Qualifies PR #4275 (RQ-PHX-RECONCILESLACKFAIR09SNP1) with restart evidence the
// preserved 258s scenario does not cover: the scheduling cursor is durable
// before transport work, so a drain interrupted after takeLeaderReplyBatch but
// before any first-batch delivery must still let a later eligible reply through
// on a fresh drain/network instance. Real journals and cursor files only; the
// transport is an injected fake and the interruption is a deterministic abort.
it('a drain interrupted after cursor persistence but before first delivery cannot starve a later reply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-restart-')); roots.push(root);
  const configDir = join(root, 'config'), runsDir = join(root, 'runs'), busRoot = join(root, 'bus');
  mkdirSync(configDir, { mode: 0o700 });
  const ownerToml = `[mason]\nidentities=[{channel="slack",id="U0OWNER"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0TEAM"\nown_user_id="U0BOT"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0LEADER"\n`;
  const configFile = join(configDir, 'agent-network.toml');
  writeFileSync(configFile, ownerToml, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  const now = () => Date.parse('2026-11-13T02:00:00Z');
  const network = createLeaderNetwork({ configSource: ownerToml, commsSource: 'confirmedByMason=true', runsDir, busRoot, now,
    deliver: async () => ({ status: 'drafted' }) });
  for (let i = 0; i < 11; i++) {
    const message: BusEnvelope = { id: `fake-request-${i}`, from: 'mason', to: 'leader', priority: 'P0', ttl: 60000,
      channel: 'slack', channel_ref: `slack:T0TEAM:D0LEADER:1793920000.${String(i + 1).padStart(6, '0')}`,
      origin_bridge: 'slack', external: false, sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true },
      body: { kind: 'note', text: `Fake request ${i}` } };
    const result = await network.ingest({ message, verifiedSender: { channel: 'slack', id: 'U0OWNER' } });
    expect(result.status).toBe('accepted');
    if (i >= 5) expect((await network.reply(result.requestId!, `Fake reply ${i}`)).status).toBe('drafted');
  }
  // Six drafted replies hold transport slots; requests without a reply consume none.
  const drafted = (await network.pending()).filter(row => row.replyText !== undefined);
  expect(drafted.map(row => row.replyText)).toEqual([5, 6, 7, 8, 9, 10].map(i => `Fake reply ${i}`));

  const posts: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const call: SlackCall = vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T0TEAM', user_id: 'U0BOT', bot_id: 'B0BOT' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0TEAM' } };
    if (method === 'conversations.members') return { members: ['U0BOT', 'U0OWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0TEAM', is_bot: body.user === 'U0BOT' } };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    if (method === 'chat.postMessage') {
      posts.push(body);
      // Restart seam: the worker dies inside the first delivery attempt, after
      // the scheduling cursor was already persisted for the whole batch.
      if (body.text === 'Leader: Fake reply 5') { controller.abort(); throw new Error('slack-session-expired'); }
      if (body.text !== 'Leader: Fake reply 10') throw new Error('fake rate limit');
      return { channel: body.channel, ts: '1793920010.000001' };
    }
    throw new Error('unexpected fake call');
  });

  // Interrupted drain: cursor persisted, zero deliveries proved, batch aborted.
  expect(await flushSlackLeaderReplies({ configDir, runsDir, busRoot, now, call, signal: controller.signal }))
    .toMatchObject({ state: 'completed', sent: 0 });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ channel: 'D0LEADER', thread_ts: '1793920000.000006', text: 'Leader: Fake reply 5' });
  expect(readFileSync(join(runsDir, 'leader', 'slack-reply-cursor.json'), 'utf8')).toBe('5');
  // No success receipt exists for the failed or unattempted sends: the Slack
  // journal holds only the single interrupted 'attempted' intent.
  const store = JSON.parse(readFileSync(join(runsDir, 'slack-transport', 'messages.json'), 'utf8')) as { messages: Record<string, { state: string }> };
  expect(Object.keys(store.messages)).toHaveLength(1);
  expect(Object.values(store.messages).every(receipt => receipt.state === 'attempted')).toBe(true);
  // Every drafted reply is still pending on a freshly reconstructed network.
  const afterInterrupt = await createLeaderNetwork({ configSource: ownerToml, commsSource: 'confirmedByMason=true', runsDir, busRoot, now }).pending();
  expect(afterInterrupt.filter(row => row.replyText !== undefined).map(row => row.replyText))
    .toEqual([5, 6, 7, 8, 9, 10].map(i => `Fake reply ${i}`));

  // Fresh drain/network instance resumes rotation at the persisted cursor, so
  // the sixth eligible reply is reached and delivered to the same thread.
  expect(await flushSlackLeaderReplies({ configDir, runsDir, busRoot, now, call }))
    .toMatchObject({ state: 'completed', sent: 1 });
  const replyTen = posts.filter(post => post.text === 'Leader: Fake reply 10');
  expect(replyTen).toHaveLength(1);
  expect(replyTen[0]).toMatchObject({ channel: 'D0LEADER', thread_ts: '1793920000.000011' });
  expect(readFileSync(join(runsDir, 'leader', 'slack-reply-cursor.json'), 'utf8')).toBe('4');

  // Another fresh drain neither reposts the delivered reply nor counts it again;
  // unconfirmed intents reconcile read-only instead of resending.
  expect(await flushSlackLeaderReplies({ configDir, runsDir, busRoot, now, call }))
    .toMatchObject({ state: 'completed', sent: 0 });
  expect(posts.filter(post => post.text === 'Leader: Fake reply 10')).toHaveLength(1);
  const settled = await createLeaderNetwork({ configSource: ownerToml, commsSource: 'confirmedByMason=true', runsDir, busRoot, now }).pending();
  expect(settled.some(row => row.replyText === 'Fake reply 10')).toBe(false);

  // The recovered path re-reads current owner policy: with the Slack owner
  // removed from [mason], a fresh drain sends nothing and touches no transport.
  writeFileSync(configFile, ownerToml.replace('identities=[{channel="slack",id="U0OWNER"}]\n[team]', 'identities=[]\n[team]'), { mode: 0o600 });
  const callsBefore = vi.mocked(call).mock.calls.length;
  expect(await flushSlackLeaderReplies({ configDir, runsDir, busRoot, now, call }))
    .toMatchObject({ state: 'completed', sent: 0 });
  expect(posts).toHaveLength(6);
  expect(vi.mocked(call).mock.calls.length).toBe(callsBefore);
}, 120000);
