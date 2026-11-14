import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';

const start = Date.parse('2026-11-12T22:29:00.000Z');
let root: string;
const iso = (offset: number) => new Date(start + offset).toISOString();
const post = (id: string, offset: number, body: object) => {
  expect(appendBusInbox({ id, from: 'fake-sender', to: 'fake-worker', priority: 'P1',
    ttl: 60_000, body }, { root, now: () => start + offset }).status).toBe('posted');
};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chronology-325s-')); chmodSync(root, 0o700); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each([['verified-first', 1_000, 2_000], ['blocked-first', 2_000, 1_000]])(
  'retains both receipts and reports VERIFIED for %s', (_order, verifiedAt, blockedAt) => {
    post('fake-request', 0, { kind: 'work' });
    const replies = [
      { id: 'fake-verified', at: verifiedAt, body: { inReplyTo: 'fake-request', verified: { artifact: 'fake-result.txt' } } },
      { id: 'fake-blocked', at: blockedAt, body: { inReplyTo: 'fake-request', blocked: { dependency: 'fake-dependency' } } },
    ].sort((a, b) => a.at - b.at);
    for (const reply of replies) post(reply.id, reply.at, reply.body);
    post('fake-other-request', 3_000, { kind: 'work' });
    post('fake-other-blocked', 4_000, { inReplyTo: 'fake-other-request', blocked: { dependency: 'fake-other' } });
    const path = join(root, 'bus-inbox', 'messages.json');
    const before = readFileSync(path);
    const result = collectBusWorkItemEvidence('fake-request', { root, now: start + 5_000 });
    const board = listWorkBoard({ root, now: start + 5_000 });
    expect(result.sources.inbox).toBe('found');
    expect(result.evidence).toMatchObject({ receivedAt: iso(0),
      verified: { artifact: 'fake-result.txt', source: 'bus-reply:fake-verified', at: iso(verifiedAt) },
      blocker: { dependency: 'fake-dependency', source: 'bus-reply:fake-blocked', at: iso(blockedAt) } });
    expect(board.inbox).toBe('ok');
    expect(board.items.find(item => item.id === 'fake-request')).toMatchObject({
      state: 'VERIFIED', source: 'bus-reply:fake-verified', asOf: iso(verifiedAt), missing: [] });
    expect(board.items.find(item => item.id === 'fake-other-request')).toMatchObject({
      state: 'BLOCKED', source: 'bus-reply:fake-other-blocked', asOf: iso(4_000) });
    expect(readFileSync(path)).toEqual(before);
  },
);
