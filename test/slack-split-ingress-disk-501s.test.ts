import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSlackJournal, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { leaderReplySendKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';

describe('Slack split ingress evidence across disk replay', () => {
  for (const bus of ['posted', 'duplicate'] as const) {
    for (const order of ['failed-first', 'failed-last'] as const) {
      it(`qualifies ${bus} against failed ingress, ${order}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'slack-split-501s-'));
        try {
          const runsDir = join(root, 'runs');
          const stateRoot = join(root, 'sends');
          const journalPath = slackJournalPath(runsDir);
          const storePath = join(stateRoot, 'messages.json');
          mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
          mkdirSync(stateRoot, { mode: 0o700 });
          const requestId = 'a'.repeat(64);
          const otherId = 'b'.repeat(64);
          const channelId = 'D0SYNTHETIC';
          const threadTs = '1793920000.000001';
          const messageTs = '1793920001.000001';
          const replyTs = '1793920003.000001';
          const authorId = 'U0SYNTHETICAUTHOR';
          const text = 'synthetic-private-request-text';
          const good = { at: '2026-11-06T01:46:41.000Z', decision: 'ingested', bus, channelId, threadTs,
            messageTs, requestId, authorId, text };
          const bad = { ...good, at: '2026-11-06T01:46:42.000Z', bus: 'failed', channelId: 'D0OTHER',
            threadTs: '1793920010.000001', messageTs: '1793920011.000001' };
          const other = { ...good, at: '2026-11-06T01:46:43.000Z', requestId: otherId,
            messageTs: '1793920002.000001' };
          const writeJournal = (failed: typeof bad) => {
            const pair = order === 'failed-first' ? [failed, good] : [good, failed];
            writeFileSync(journalPath, [...pair, other].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
          };
          writeFileSync(storePath, JSON.stringify({ version: 1, messages: {
            [leaderReplySendKey(requestId)]: { state: 'sent', channel: channelId, thread: threadTs, ts: replyTs },
          } }), { mode: 0o600 });
          const inspect = () => {
            const before = [readFileSync(journalPath), readFileSync(storePath)];
            const journal = readSlackJournal({ runsDir });
            const sends = readSlackSendReceipts({ stateRoot });
            const trace = readSlackRequestTrace({ runsDir, stateRoot, now: () => new Date('2026-11-06T02:00:00Z') });
            expect([readFileSync(journalPath), readFileSync(storePath)]).toEqual(before);
            expect(journal.state).toBe('ok');
            expect(journal.entries).toHaveLength(3);
            expect(sends.state).toBe('ok');
            expect(sends.receipts).toHaveLength(1);
            expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
            for (const privateValue of [requestId, otherId, authorId, text, root, runsDir, stateRoot]) {
              expect(JSON.stringify(trace)).not.toContain(privateValue);
            }
            return trace;
          };
          writeJournal(bad);
          const conflict = inspect();
          // Qualification of the current defect: the split bind certifies the good
          // location despite contradictory evidence in the failed partition.
          expect(conflict.rows.map(row => [row.channelId, row.ingress, row.outcome, row.replyTs])).toEqual([
            [channelId, bus, 'answered', replyTs],
            [bad.channelId, 'failed', 'bus-failed', undefined],
            [channelId, bus, 'unanswered', undefined],
          ]);
          writeJournal({ ...bad, channelId, threadTs, messageTs });
          const repaired = inspect();
          expect(repaired.rows.map(row => [row.ingress, row.outcome, row.replyTs])).toEqual([
            [bus, 'answered', replyTs], ['failed', 'bus-failed', replyTs], [bus, 'unanswered', undefined],
          ]);
          expect(repaired.rows[2]).toEqual(conflict.rows[2]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
