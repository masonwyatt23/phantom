import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acceptOwnerInbound, readOwnerCommsStatus, readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-preservation-'));
  roots.push(runsDir);
  const deliver = vi.fn(async () => ({ status: 'sent' as const, reason: 'ok' }));
  const options = (): OwnerThreadOptions => ({
    runsDir, busRoot: join(runsDir, 'bus'), capacity: { messages: 2, bytes: 1_048_576 },
    settings: { owners: { desktop: 'local-owner' }, secretHandles: {}, confirmed: true,
      team: [{ channel: 'bus', id: 'local-owner' }] },
    mailbox: { async accept() { return { status: 'accepted' }; } },
    transports: { desktop: { async pull() { return []; }, deliver } },
  });
  const input = (n: number) => ({ channel: 'desktop' as const, senderId: 'local-owner', text: `message ${n}`,
    idempotencyKey: `message-${n}`, at: 1_700_000_000_000 });
  return { options, input, deliver, dir: join(runsDir, 'leader') };
}

it('preserves ordered history and deduplication across repeated rotations and new options', async () => {
  const f = fixture();
  const options = f.options();
  expect(await acceptOwnerInbound(f.input(1), options)).toMatchObject({ status: 'accepted', seq: 1 });
  expect(await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-key-1' }, options)).toMatchObject({ status: 'sent' });
  for (let n = 2; n <= 5; n++) {
    expect(await acceptOwnerInbound(f.input(n), options)).toMatchObject({ status: 'accepted', seq: n + 1 });
  }
  const fresh = f.options();
  const archives = readdirSync(f.dir).filter(name => /^owner-thread-archive-\d+-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.split('-')[3]) - Number(b.split('-')[3]))
    .map(name => JSON.parse(readFileSync(join(f.dir, name), 'utf8')) as { messages: Array<{ seq: number; idempotencyKey: string }> });
  expect(archives.length).toBeGreaterThan(1);
  const archived = archives.flatMap(archive => archive.messages);
  const live = readOwnerThread(fresh).messages;
  expect(archived.map(message => message.idempotencyKey)).toContain('message-1');
  expect(archived.map(message => message.idempotencyKey)).toContain('reply-key-1');
  expect([...archived, ...live].map(message => message.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await acceptOwnerInbound(f.input(1), fresh)).toMatchObject({ status: 'duplicate' });
  expect(await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-key-1' }, fresh)).toMatchObject({ status: 'duplicate' });
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(readOwnerCommsStatus(fresh).messages).toBe(6);
  const state = JSON.parse(readFileSync(join(f.dir, 'owner-thread.json'), 'utf8')) as { deliveries: Record<string, string> };
  expect(state.deliveries).toEqual({});
});

it('fails closed on a conflicting archive without changing live bytes', async () => {
  const f = fixture();
  for (let n = 1; n <= 2; n++) expect((await acceptOwnerInbound(f.input(n), f.options())).status).toBe('accepted');
  const path = join(f.dir, 'owner-thread.json');
  const before = readFileSync(path);
  writeFileSync(join(f.dir, 'owner-thread-archive-1-2.json'), '{}', { mode: 0o600 });
  expect((await acceptOwnerInbound(f.input(3), f.options())).status).toBe('unavailable');
  expect(readFileSync(path)).toEqual(before);
});

it('rotates legacy state and rejects an invalid base', async () => {
  const f = fixture();
  mkdirSync(f.dir, { mode: 0o700 });
  const path = join(f.dir, 'owner-thread.json');
  writeFileSync(path, JSON.stringify({ v: 1, threadId: 'owner', messages: [], deliveries: {} }), { mode: 0o600 });
  for (let n = 1; n <= 3; n++) expect((await acceptOwnerInbound(f.input(n), f.options())).status).toBe('accepted');
  expect(readOwnerCommsStatus(f.options()).messages).toBe(3);
  writeFileSync(path, JSON.stringify({ v: 1, threadId: 'owner', base: -1, messages: [], deliveries: {} }));
  expect(readOwnerThread(f.options())).toHaveProperty('unavailable', true);
});
