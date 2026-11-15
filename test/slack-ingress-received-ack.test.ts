import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSlackBusIngress, type SlackBusIngressOptions, type SlackBusIngressPolicy } from '../src/core/comms/slack-bus-ingress.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const now = 1_793_925_600_000;
const secret = 'fake-signing-material-for-offline-test';
const policy: SlackBusIngressPolicy = {
  enabled: true, workspaceId: 'TFAKE', receiverAppId: 'ARECEIVER', selfBotId: 'BSELF', selfUserId: 'USELF', bridgeId: 'local-fake',
  peers: [{ botId: 'BFAKE', appId: 'AFAKE', userId: 'UFAKE', agentId: 'agent-fake', vendor: 'fake', bridgeId: 'remote-fake' }],
  routes: [{ channelId: 'CFAKE', audience: 'fleet-coordination', mode: 'peer', peerBotIds: ['BFAKE'], recipients: ['agent-fake-1'] }],
};
function request(kind = 'request', threaded = true) {
  const rawBody = JSON.stringify({
    type: 'event_callback', team_id: 'TFAKE', api_app_id: 'ARECEIVER', event_id: 'req-fake-1', is_ext_shared_channel: false,
    event: { type: 'message', channel: 'CFAKE', bot_id: 'BFAKE', app_id: 'AFAKE', user: 'UFAKE',
      ts: '1793925600.000001', ...(threaded ? { thread_ts: '1793925500.000001' } : {}), text: 'Fake request',
      metadata: { event_type: 'phantom_agent_message', event_payload: { version: 1, kind, message_id: 'req-fake-1',
        origin_bridge: 'remote-fake', visited_bridges: ['remote-fake'], hop_count: 1 } } },
  });
  const timestamp = String(now / 1000);
  return { rawBody, timestamp, signature: `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}` };
}
function fixture(failure?: 'throw' | 'reject' | 'refuse') {
  const rows = new Map<string, BusEnvelope>();
  const order: string[] = [];
  const send = vi.fn<NonNullable<SlackBusIngressOptions['sendReceivedAck']>>(() => {
    order.push('send');
    expect(rows.size).toBeGreaterThan(0);
    if (failure === 'throw') throw new Error('private fake error');
    if (failure === 'reject') return Promise.reject(new Error('private fake error'));
    return Promise.resolve({ status: failure === 'refuse' ? 'refused' : 'sent', reason: 'fake' });
  });
  const options: SlackBusIngressOptions = {
    root: '/fake-bus-root', readPolicy: () => policy, readSigningSecret: () => secret, now: () => now,
    append: envelope => {
      if (rows.has(envelope.id)) return { status: 'duplicate', id: envelope.id, cursor: rows.size };
      rows.set(envelope.id, envelope); order.push('write');
      return { status: 'posted', id: envelope.id, cursor: rows.size };
    },
    receivedAckTransport: { config: { teamId: 'TFAKE', bridgeId: 'slack', map: [{ topic: 'fake-topic', channel: 'CFAKE' }] },
      teamIdentities: [], confirmedByMason: false, stateRoot: '/fake-send-root', call: async () => { throw new Error('unexpected network'); } },
    sendReceivedAck: send,
  };
  return { options, rows, order, send, receive: createSlackBusIngress(options) };
}

describe('durable ingress RECEIVED ack', () => {
  it('writes before sending once in the source thread; recreated ingress suppresses replay', async () => {
    const f = fixture();
    expect(f.receive(request())).toMatchObject({ status: 'accepted', posted: 1 });
    await Promise.resolve();
    expect(f.order).toEqual(['write', 'send']);
    expect(f.rows.size).toBe(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    const envelope = f.send.mock.calls[0]![0];
    const receiptId = [...f.rows.keys()][0]!;
    expect(envelope.body).toMatchObject({ kind: 'note', thread: 'slack:TFAKE:CFAKE:1793925500.000001',
      text: `RECEIVED: receipt ${receiptId} as of ${new Date(now).toISOString()}. Not yet assigned.` });
    expect(envelope.id).toBe(`received:${receiptId}`);
    expect(createSlackBusIngress(f.options)(request())).toMatchObject({ posted: 0, duplicates: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each(['throw', 'reject', 'refuse'] as const)('keeps durable receipt when sender reports %s', async failure => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const f = fixture(failure);
      expect(f.receive(request()).status).toBe('accepted');
      await Promise.resolve(); await Promise.resolve();
      expect(f.rows.size).toBe(1);
      expect(log).toHaveBeenCalledWith('slack-received-ack-send-failed');
      expect(createSlackBusIngress(f.options)(request()).duplicates).toBe(1);
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
  it('sends once for group fanout', () => {
    const f = fixture();
    f.options.readPolicy = () => ({ ...policy, routes: [{ ...policy.routes[0]!, mode: 'group', recipients: ['agent-fake-1', 'agent-fake-2'] }] });
    expect(createSlackBusIngress(f.options)(request()).posted).toBe(2);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('does not acknowledge again when a retry finishes partial fanout', () => {
    const f = fixture(), append = f.options.append!;
    f.options.readPolicy = () => ({ ...policy, routes: [{ ...policy.routes[0]!, mode: 'group', recipients: ['agent-fake-1', 'agent-fake-2'] }] });
    let calls = 0;
    f.options.append = (envelope, options) => ++calls === 2 ? { status: 'full' } : append(envelope, options);
    expect(createSlackBusIngress(f.options)(request())).toMatchObject({ status: 'partial', posted: 1 });
    expect(createSlackBusIngress(f.options)(request())).toMatchObject({ posted: 1, duplicates: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('does not send before a failed write or for a non-request', () => {
    const f = fixture();
    f.options.append = () => ({ status: 'unavailable' });
    expect(createSlackBusIngress(f.options)(request()).status).toBe('partial');
    expect(f.send).not.toHaveBeenCalled();
    f.receive(request('note'));
    expect(f.send).not.toHaveBeenCalled();
  });
  it('uses the source message as thread root when it has no parent', () => {
    const f = fixture(); f.receive(request('request', false));
    expect(f.send.mock.calls[0]![0].body).toMatchObject({ thread: 'slack:TFAKE:CFAKE:1793925600.000001' });
  });
  it('refuses an unmapped thread without turning it into a channel post', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const f = fixture(); f.options.receivedAckTransport!.config.map = [];
      expect(f.receive(request()).status).toBe('accepted');
      expect(f.rows.size).toBe(1);
      expect(f.send).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('slack-received-ack-send-failed');
    } finally { log.mockRestore(); }
  });
});
