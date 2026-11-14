import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { appendBusInbox, BUS_INBOX_MAX_READ, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

describe('work result for a request beyond the first inbox page', () => {
  it('retains and attributes one receipt across an identical later retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'work-result-page-341s-'));
    chmodSync(root, 0o700);
    let now = 1_700_000_000_000;
    const earlier = 'fake-earlier-341s', target = 'fake-target-341s', reply = 'fake-result-341s';
    const post = (id: string, from: string, to: string, body: object) => {
      expect(appendBusInbox({ id, from, to, priority: 'P1', ttl: 1_000_000, body },
        { root, now: () => now }).status).toBe('posted');
    };
    const pages = () => {
      const result = [];
      let cursor = 0;
      for (;;) {
        const page = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root, now: () => now });
        expect(page.status).toBe('ok');
        if (page.status !== 'ok') throw new Error(`inbox: ${page.status}`);
        result.push(page);
        if (page.messages.length < BUS_INBOX_MAX_READ) return result;
        expect(page.nextCursor).toBeGreaterThan(cursor);
        cursor = page.nextCursor;
      }
    };
    const invoke = async () => {
      const output: string[] = [];
      const code = await cmdFleetWorkResult(['--request-id', target, '--reply-id', reply,
        '--root', root, '--tests', 'fake tests passed'], { now: () => now },
      { output: text => output.push(text) });
      expect(code).toBe(0);
      expect(output).toHaveLength(1);
      return JSON.parse(output[0]!) as { outcome: string; transport: string };
    };
    try {
      post(earlier, 'fake-first-owner', 'fake-first-lane', { kind: 'work' });
      for (let i = 1; i < BUS_INBOX_MAX_READ; i++) {
        post(`fake-noise-341s-${i}`, 'fake-noise-from', 'fake-noise-to', { inReplyTo: 'fake-unrelated' });
      }
      post(target, 'fake-target-owner', 'fake-target-lane', { kind: 'work' });
      const before = pages();
      expect(before[0]!.messages).toHaveLength(BUS_INBOX_MAX_READ);
      expect(before[0]!.messages[0]!.envelope.id).toBe(earlier);
      expect(before[1]!.messages.map(row => row.envelope.id)).toEqual([target]);

      expect(await invoke()).toMatchObject({ outcome: 'posted', transport: 'posted' });
      const posted = pages();
      expect(posted[1]!.messages.map(row => row.envelope.id)).toEqual([target, reply]);
      const receipt = posted[1]!.messages[1]!;
      expect(receipt.envelope).toMatchObject({ id: reply, from: 'fake-target-lane', to: 'fake-target-owner',
        priority: 'P1', body: { verified: { tests: 'fake tests passed' }, inReplyTo: target } });
      expect(receipt.envelope.body).toEqual({ verified: { tests: 'fake tests passed' }, inReplyTo: target });
      const targetEvidence = collectBusWorkItemEvidence(target, { root, now });
      const earlierEvidence = collectBusWorkItemEvidence(earlier, { root, now });
      expect(targetEvidence.sources).toEqual({ inbox: 'found', claims: 'missing' });
      expect(targetEvidence.evidence.verified).toMatchObject({ tests: 'fake tests passed', source: `bus-reply:${reply}` });
      expect(earlierEvidence.sources).toEqual({ inbox: 'found', claims: 'missing' });
      expect(earlierEvidence.evidence.verified).toBeUndefined();
      for (const evidence of [targetEvidence.evidence, earlierEvidence.evidence]) {
        expect(evidence.owner).toBeUndefined();
        expect(evidence.claimReceipt).toBeUndefined();
        expect(evidence.runningEvidence).toBeUndefined();
      }
      const board = listWorkBoard({ root, now });
      expect(board).toMatchObject({ inbox: 'ok', claims: 'missing', truncated: false });
      expect(board.items).toHaveLength(2);
      expect(board.items.find(item => item.id === target)).toMatchObject({ state: 'VERIFIED',
        source: `bus-reply:${reply}`, owner: null, claimReceipt: null,
        result: { kind: 'verified', tests: 'fake tests passed' } });
      expect(board.items.find(item => item.id === earlier)).toMatchObject({ state: 'RECEIVED', owner: null, claimReceipt: null });
      expect(board.items.find(item => item.id === earlier)?.result).toBeUndefined();

      now += 1_000;
      expect(await invoke()).toMatchObject({ outcome: 'duplicate', transport: 'duplicate' });
      const retried = pages().flatMap(page => page.messages);
      expect(retried).toHaveLength(BUS_INBOX_MAX_READ + 2);
      const replies = retried.filter(row => row.envelope.id === reply);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ cursor: receipt.cursor, receivedAt: receipt.receivedAt });
      expect(replies[0]!.envelope.body).toEqual(receipt.envelope.body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
