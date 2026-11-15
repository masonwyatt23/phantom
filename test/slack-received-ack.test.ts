import { describe, expect, it } from 'vitest';
import { planReceivedAck } from '../src/core/comms/slack-received-ack.js';

const input = { receiptId: 'req-fake-1', duplicate: false, threadKey: 'thread-fake-1', asOf: '2026-11-14T22:00:00.000Z' };
describe('planReceivedAck', () => {
  it('names the durable receipt and observation time without claiming assignment', () => {
    expect(planReceivedAck(input)).toEqual({
      text: 'RECEIVED: receipt req-fake-1 as of 2026-11-14T22:00:00.000Z. Not yet assigned.',
      dedupeKey: 'received:req-fake-1',
    });
    expect(planReceivedAck({ ...input, asOf: '2026-11-15T22:00:00.000Z' })?.dedupeKey)
      .toBe(planReceivedAck(input)?.dedupeKey);
  });
  it('does not acknowledge duplicates', () => {
    expect(planReceivedAck({ ...input, duplicate: true })).toBeNull();
  });
  it.each(['', '  '])('does not fall back to a channel when thread is %j', threadKey => {
    expect(planReceivedAck({ ...input, threadKey })).toBeNull();
  });
});
