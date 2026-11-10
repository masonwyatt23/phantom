import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordTeammateText, markTeammateTextsAnswered } from '../src/core/comms/imessage-teammate-inbox.js';
import { readOwnerCommsStatus, teammateReplyGap, type ReplyGapEvent } from '../src/core/comms/owner-thread.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const min = (n: number) => NOW - n * 60_000;
const ev = (direction: ReplyGapEvent['direction'], at: number): ReplyGapEvent => ({ teammate: 'Ashlr.', direction, at });

describe('teammateReplyGap', () => {
  it('is ok inside the warn window', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(2))], NOW);
    expect(gap).toMatchObject({ teammate: 'Ashlr.', unansweredCount: 1, oldestUnansweredMs: 120_000, state: 'ok' });
  });
  it('is late at 6 minutes and counts every waiting text', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(6)), ev('inbound', min(1))], NOW);
    expect(gap).toMatchObject({ unansweredCount: 2, oldestUnansweredMs: 360_000, state: 'late', lastInboundAt: min(1), lastOutboundAt: null });
  });
  it('clears when an outbound follows the inbound', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(20)), ev('outbound', min(15))], NOW);
    expect(gap).toMatchObject({ unansweredCount: 0, oldestUnansweredMs: 0, state: 'ok', lastOutboundAt: min(15) });
  });
  it('is unknown with no evidence source', () => {
    expect(teammateReplyGap(null, NOW).map(gap => gap.state)).toEqual(['unknown']);
  });
  it('returns metadata only', () => {
    const rows = teammateReplyGap([{ ...ev('inbound', min(9)), body: 'hi', phone: 'fake-handle' } as ReplyGapEvent], NOW);
    expect(Object.keys(rows[0]!).sort()).toEqual(['lastInboundAt', 'lastOutboundAt', 'oldestUnansweredMs', 'state', 'teammate', 'unansweredCount']);
    expect(JSON.stringify(rows)).not.toMatch(/fake-handle|"hi"|body|phone/);
  });
});

it('reports older unanswered rows through owner status after a newer row is answered', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'reply-gap-'));
  try {
    expect(recordTeammateText({ rowid: 1, handle: 'fake-teammate', text: 'first' }, runsDir, new Date(min(20)))).toBe(true);
    expect(recordTeammateText({ rowid: 2, handle: 'fake-teammate', text: 'second' }, runsDir, new Date(min(2)))).toBe(true);
    expect(markTeammateTextsAnswered([2], runsDir)).toBe(1);
    const status = readOwnerCommsStatus({ runsDir, now: () => NOW, settings: { owners: {}, secretHandles: {}, confirmed: true, team: [] } });
    expect(status.replyGap).toMatchObject([{ teammate: 'Teammate', unansweredCount: 1, oldestUnansweredMs: 1_200_000, state: 'late' }]);
  } finally { rmSync(runsDir, { recursive: true, force: true }); }
});
