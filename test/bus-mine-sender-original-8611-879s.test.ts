import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { announceWork } from '../src/core/agents/bus-unified.js';
import { formatBusWorkMine, readBusWorkMine } from '../src/core/agents/bus-work-mine.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { createBusMailbox } from '../src/core/fleet/bus-mailbox.js';
import { enqueueBusWake } from '../src/core/fleet/bus-wake-queue.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('work mine sender filters recovered from #8611', () => {
  it('filters each section on its own evidence and preserves unknown claims on exclusion', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mine-sender-')); dirs.push(base);
    const now = Date.now();
    const options = { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => now };
    for (const handle of ['atlas', 'nova', 'ghost']) {
      expect(registerAgentIdentity({ handle, aliases: handle === 'nova' ? ['nova-lane'] : [],
        runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options).status).toBe('created');
    }
    for (const sender of ['nova', 'ghost']) {
      for (const [prefix, body] of [
        ['w', { kind: 'work', text: 'work' }],
        ['ho', { kind: 'worker-handoff', taskId: `RQ-${sender}`, prompt: 'handoff' }],
        ['th', { kind: 'note', text: 'question?', thread: `thread-${sender}` }],
      ] as const) {
        expect(appendBusInbox({ id: `${prefix}-${sender}`, from: `agent:${sender}`, to: 'agent:atlas',
          priority: 'P2', ttl: 120_000, body }, options).status).toBe('posted');
      }
      expect((await announceWork({ from: sender, jobId: `RQ-${sender}`, title: sender, repo: 'a/b',
        claimKeys: [`queue:RQ-${sender}`], to: 'agent:atlas', id: `post-${sender}` }, options)).status).toBe('posted');
      expect(enqueueBusWake({ kind: 'bus.send', id: `wake-${sender}`, from: `agent:${sender}`, to: 'agent:atlas' },
        { root: options.runsRoot, now: options.now })).toBe('queued');
      expect(createBusMailbox(dirname(options.root), options.now).send({ id: `mail-${sender}`, from: `agent:${sender}`,
        to: 'atlas', priority: 'P2', ttl: 120_000, body: { text: 'mail' } }).replayed).toBe(false);
      expect(mutateBusWorkClaim({ action: 'acquire', id: `w-${sender}`, owner: 'atlas', leaseMs: 60_000,
        root: options.root }).status).toBe('acquired');
    }
    expect(acquireCoordination({ root: options.root, origin: 'message', key: 'queue:missing', owner: 'atlas',
      leaseMs: 60_000, leaseUntil: now + 60_000, sourceId: 'missing:0:0', now,
      started: new Date(now).toISOString() }).status).toBe('acquired');
    const all = readBusWorkMine('atlas', options);
    if (all.status !== 'ok') throw new Error('baseline unavailable');
    for (const [filter, expected, claims] of [
      [{ from: 'nova-lane' }, 'nova', ['queue:w-nova']],
      [{ from: stableAgentId('nova') }, 'nova', ['queue:w-nova']],
      [{ excludeFrom: 'nova' }, 'ghost', ['queue:missing', 'queue:w-ghost']],
      [{ from: 'ghost', excludeFrom: 'nova' }, 'ghost', ['queue:w-ghost']],
    ] as const) {
      const result = readBusWorkMine('atlas', { ...options, ...filter });
      if (result.status !== 'ok') throw new Error('filtered read unavailable');
      expect(result).toMatchObject(filter);
      expect(formatBusWorkMine(result)[0]).toContain('from=');
      expect(result.next).toMatchObject({ status: 'ok', matched: 1, items: [{ id: `w-${expected}` }] });
      expect(result.handoffs).toMatchObject({ status: 'ok', matched: 1, items: [{ id: `ho-${expected}` }] });
      expect(result.jobs).toMatchObject({ status: 'ok', open: 1, jobs: [{ id: `RQ-${expected}` }] });
      expect(result.wakes).toMatchObject({ status: 'ok', matched: 1, wakes: [{ id: `wake-${expected}` }] });
      expect(result.mailbox).toMatchObject({ status: 'ok', matched: 1, messages: [{ id: `mail-${expected}` }] });
      expect(result.inbox).toMatchObject({ status: 'ok', matched: 4 });
      expect(result.threads).toMatchObject({ status: 'ok', matched: 3 });
      expect(result.claims.status).toBe('ok');
      if (result.claims.status !== 'ok') throw new Error('claims unavailable');
      expect(result.claims.claims.map(row => row.key).sort()).toEqual(claims);
      expect(result.board).toEqual(all.board);
      expect(result.channels).toEqual(all.channels);
    }
  });

  it.each(['', 'has space', 'two  spaces', null, 5])('rejects invalid sender ref %s', ref => {
    expect(readBusWorkMine('atlas', { from: ref as never })).toEqual({ status: 'invalid', reason: 'invalid-from' });
    expect(readBusWorkMine('atlas', { excludeFrom: ref as never }))
      .toEqual({ status: 'invalid', reason: 'invalid-exclude-from' });
  });
});
