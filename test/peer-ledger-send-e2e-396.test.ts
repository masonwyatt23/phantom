import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPeerMessage, PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS, type PeerLedgerRow } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger } from '../src/core/agentnet/peer-ledger.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import { localWriteGate } from '../src/core/agents/send-gate.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';

vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: vi.fn(() => null) }));
// Broker fixtures copied from agentnet-peer-bus.test.ts; every transport call is fake.
let root: string, bindings: string, peers: PeerBinding[], now: number, shared: boolean, approved: boolean;
const session = (n = 0) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const policy = (n = 0): SlackDeliveryPolicy => ({ config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[n]!.userId,
  ownBotId: peers[n]!.botId, botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: approved, teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) });
const api = (n = 0): SlackCall => vi.fn(async (method, args = {}) => {
  if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[n]!.userId, bot_id: peers[n]!.botId };
  if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false, is_ext_shared: shared, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
  if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
  if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
  if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
  throw new Error('unexpected-api-method');
});
const options = (n = 0, call = api(n)) => ({ bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy(n) });
const request = { toAgent: 'agent1', kind: 'task', text: 'Review the parser', refs: ['pr:12', 'phm_TEST_REFERENCE'] };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-ledger-send-396-')); bindings = join(root, 'bindings.json'); now = 1_800_000_000_000; shared = false; approved = true;
  peers = Array.from({ length: 10 }, (_, n) => ({ callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
    sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
    expiresAt: now + 3600_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' }));
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  vi.mocked(localWriteGate).mockReturnValue(null);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

const read = () => readPeerLedger({ busRoot: root, now: () => now });
const coordinationFile = () => join(root, 'agentnet', 'coordination.json');

async function fillPair() {
  for (let n = 0; n < PEER_PAIR_LIMIT; n++) {
    expect(await sendPeerMessage(request, session(), options())).toMatchObject({ status: 'posted', slack: 'sent' });
  }
}

// Multiple durable bus/Slack-state writes per case need more than the unit default.
describe('peer ledger against the real send path', () => {
  it('reports the debit from one direct send', async () => {
    expect(await sendPeerMessage(request, session(), options())).toMatchObject({ status: 'posted', slack: 'sent' });
    const ledger = read();
    expect(ledger).toMatchObject({ status: 'ok', liveRows: 1 });
    expect(ledger.pairs).toEqual([{ fromAgent: 'agent0', target: 'agent1', inWindow: 1,
      remaining: PEER_PAIR_LIMIT - 1, lastAt: new Date(now).toISOString() }]);
  }, 30_000);

  it('reaches zero exactly when sends refuse, without reserving a refused row', async () => {
    await fillPair();
    const ledger = read(), stored = readFileSync(coordinationFile(), 'utf8');
    expect(ledger).toMatchObject({ status: 'ok', liveRows: PEER_PAIR_LIMIT });
    expect(ledger.pairs).toHaveLength(1);
    expect(ledger.pairs[0]).toMatchObject({ fromAgent: 'agent0', target: 'agent1', inWindow: PEER_PAIR_LIMIT, remaining: 0 });
    expect(await sendPeerMessage(request, session(), options())).toEqual({ status: 'refused', reason: 'pair-rate-limit' });
    expect(read()).toEqual(ledger);
    expect(readFileSync(coordinationFile(), 'utf8')).toBe(stored);
  }, 30_000);

  it.each([PEER_WINDOW_MS, PEER_WINDOW_MS + 1])('restores capacity at window age %i ms and permits another send', async age => {
    await fillPair();
    expect(read().pairs[0]?.remaining).toBe(0);
    now += age;
    expect(read()).toMatchObject({ status: 'ok', liveRows: PEER_PAIR_LIMIT });
    expect(read().pairs[0]).toMatchObject({ inWindow: 0, remaining: PEER_PAIR_LIMIT });
    expect(await sendPeerMessage(request, session(), options())).toMatchObject({ status: 'posted', slack: 'sent' });
    expect(read().liveRows).toBe(PEER_PAIR_LIMIT + 1);
    expect(read().pairs[0]).toMatchObject({ inWindow: 1, remaining: PEER_PAIR_LIMIT - 1 });
  }, 30_000);

  it('debits the channel and each enrolled audience recipient, excluding absent peers and the sender', async () => {
    const original = api();
    const call: SlackCall = (method, args, credential) => method === 'conversations.members'
      ? Promise.resolve({ members: peers.slice(0, 3).map(p => p.userId) })
      : original(method, args, credential);
    expect(await sendPeerMessage({ channel: 'CMESH', kind: 'social', text: 'Hello' }, session(), options(0, call)))
      .toMatchObject({ status: 'posted', slack: 'sent' });
    const ledger = read();
    expect(ledger).toMatchObject({ status: 'ok', liveRows: 3 });
    expect(ledger.pairs).toHaveLength(3);
    expect(ledger.pairs.map(p => p.target).sort()).toEqual(['CMESH', 'agent1', 'agent2'].sort());
    for (const pair of ledger.pairs) {
      expect(pair).toMatchObject({ fromAgent: 'agent0', inWindow: 1, remaining: PEER_PAIR_LIMIT - 1 });
    }
  }, 30_000);

  it('tracks the last reply hop and enters nearCap at PEER_MAX_HOPS - 1', async () => {
    let parent: string | undefined, origin: string | undefined;
    for (let n = 0; n < PEER_MAX_HOPS; n++) {
      const result = await sendPeerMessage({ toAgent: `agent${n + 1}`, kind: 'handoff', text: 'Continue',
        ...(parent ? { replyTo: parent } : {}) }, session(n), options(n));
      expect(result).toMatchObject({ status: 'posted', slack: 'sent', hopCount: n + 1 });
      if (n === 0) origin = result.origin;
      expect(result.origin).toBe(origin);
      expect(read().origins).toEqual([{ origin, maxHop: result.hopCount, nearCap: n + 1 >= PEER_MAX_HOPS - 1 }]);
      parent = result.id;
    }
    expect(read().liveRows).toBe(PEER_MAX_HOPS);
  }, 30_000);

  it('omits real stored thread ids, digests and message text from ledger JSON', async () => {
    const threadId = 'private-thread-396', text = 'Private parser review content for ledger redaction';
    expect(await sendPeerMessage({ ...request, threadId, text }, session(), options()))
      .toMatchObject({ status: 'posted', slack: 'sent' });
    const rows = JSON.parse(readFileSync(coordinationFile(), 'utf8')) as PeerLedgerRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe(threadId);
    expect(rows[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8')).toContain(text);
    const ledger = read(), json = JSON.stringify(ledger);
    expect(ledger).toMatchObject({ status: 'ok', liveRows: 1 });
    for (const value of [threadId, rows[0]!.digest, text, 'threadId', 'digest', 'text']) {
      expect(json).not.toContain(value);
    }
  }, 30_000);
});
