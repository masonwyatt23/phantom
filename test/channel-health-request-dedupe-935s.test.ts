import { describe, expect, it, vi } from 'vitest';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const stores = vi.hoisted(() => ({ rows: [] as object[], receipts: [] as object[] }));
vi.mock('../src/core/agents/slack-journal.js', () => ({ readSlackJournal: () => ({ state: 'ok', entries: stores.rows }) }));
vi.mock('../src/core/agents/slack-send-receipts.js', () => ({ readSlackSendReceipts: () => ({ state: 'ok', receipts: stores.receipts }) }));
import { defaultChannelSources, readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const channelId = 'C0FAKELEADER';
const messageTs = '1700000000.000100';
const id = fakeRequestId('935s:first');
const row = (at: string, overrides: Record<string, unknown> = {}) => ({
  at, decision: 'ingested', channelId, messageTs, threadTs: messageTs, requestId: id, bus: 'posted', ...overrides,
});
const receipt = (requestId = id, thread = messageTs) => ({
  key: replyKey(requestId), channel: channelId, thread, state: 'sent', ts: '1700000000.000200',
});
const idle: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };
async function report(rows: object[], receipts: object[] = []) {
  stores.rows = rows;
  stores.receipts = receipts;
  const slack = defaultChannelSources().slack;
  slack.configMissing = () => [];
  slack.processAlive = () => true;
  return (await readChannelHealth({ now: () => now, host: 'fake', sources: { slack, imessage: idle } })).channels[0]!;
}

describe('default Slack request replay projection', () => {
  it('counts an answered identity once even when another observation lacks admission', async () => {
    const rows = [row(ago(30)), row(ago(2), { bus: undefined })];
    const result = await report(rows, [receipt()]);
    expect(result).toMatchObject({ state: 'LIVE', unansweredCount: 0, proof: { requestCoverage: 'verified', answeredCount: 1,
      durableIngress: { posted: 1, unverified: 1 } } });
    expect(await report([...rows].reverse(), [receipt()])).toEqual(result);
  });

  it('uses the earliest valid observation for pending grace independently of row order', async () => {
    const rows = [row(ago(30)), row(ago(2), { bus: 'duplicate' })];
    const result = await report(rows);
    expect(result).toMatchObject({ state: 'DEGRADED', unansweredCount: 1, proof: { requestCoverage: 'unproven', answeredCount: 0 } });
    expect(await report([...rows].reverse())).toEqual(result);
  });

  it('does not merge distinct identities observed at the same time', async () => {
    const second = fakeRequestId('935s:second');
    const result = await report([row(ago(30)), row(ago(30), { requestId: second })]);
    expect(result.unansweredCount).toBe(2);
  });

  it('keeps conflicting locations and idless observations unproven', async () => {
    const rows = [row(ago(30)), row(ago(2), { threadTs: '1700000001.000100' }), row(ago(3), { requestId: undefined })];
    for (const ordered of [rows, [...rows].reverse()]) {
      const result = await report(ordered, [receipt()]);
      expect(result).toMatchObject({ state: 'DEGRADED', unansweredCount: 3, proof: { requestCoverage: 'unproven', answeredCount: 0 } });
    }
  });

  it('retains failed ingress evidence even when another replay was admitted and answered', async () => {
    const result = await report([row(ago(30)), row(ago(2), { bus: 'failed' })], [receipt()]);
    expect(result).toMatchObject({ state: 'DEGRADED', unansweredCount: 0, proof: { answeredCount: 1, durableIngress: { failed: 1 } } });
    expect(result.missing).toContain('slack durable ingress failed');
  });

  it('does not let malformed or future observations establish admission', async () => {
    const future = new Date(now.getTime() + 60_000).toISOString();
    const result = await report([row(ago(30), { bus: undefined }), row(future), row(ago(2), { messageTs: 'invalid' })], [receipt()]);
    expect(result).toMatchObject({ state: 'DEGRADED', unansweredCount: 2, proof: { requestCoverage: 'unproven', answeredCount: 0 } });
  });
});
