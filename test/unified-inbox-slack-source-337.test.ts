/** Unified inbox, slack source. Hermetic: seams and temp dirs, fake ids only. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUnifiedInbox, type UnifiedInboxOptions } from '../src/core/comms/unified-inbox.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
let root: string, runsDir: string, busRoot: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unified-inbox-slack-'));
  runsDir = join(root, 'runs'); mkdirSync(runsDir, { recursive: true });
  busRoot = join(root, 'bus'); mkdirSync(busRoot, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Stub every other source so only slack varies. */
const others = (): UnifiedInboxOptions => ({
  runsDir, busRoot, slackStateRoot: join(root, 'slack'), now: () => NOW,
  readNeeds: () => ({ status: 'available', items: [{ id: 'nm-1', text: 'fake needs-you line' }] }) as never,
  readTexts: () => ({ sourceState: 'healthy', texts: [] }) as never,
  listPendingDrafts: async () => [],
  inspectBus: () => ({ source: 'missing' }) as never,
  readGmailPlans: () => null,
  readLinkedIn: () => ({ sourceState: 'healthy', skipped: 0, messages: [] }),
});
const status = (state: 'ok' | 'missing' | 'degraded', unanswered: number, sample: { channelId: string; threadTs: string; messageTs: string; at: string }[]) =>
  (() => ({ replies: { state, unanswered, unansweredSample: sample } })) as never;

const rows = [
  { channelId: 'C0FAKE0002', threadTs: '1700000000.000100', messageTs: '1700000000.000200', at: minutesAgo(40) },
  { channelId: 'C0FAKE0002', threadTs: '1700000000.000300', messageTs: '1700000000.000400', at: minutesAgo(3) },
];

describe('unified inbox slack source', () => {
  it('lists one item per sampled row, reports the full count', async () => {
    const seen: unknown[] = [];
    const inbox = await readUnifiedInbox({
      ...others(),
      readSlackStatus: ((o: unknown) => { seen.push(o); return status('ok', 7, rows)(o); }) as never,
    });
    expect(inbox.sources.slack).toEqual({ state: 'healthy', pending: 7 });
    const slack = inbox.items.filter(i => i.source === 'slack');
    expect(slack).toHaveLength(2);
    expect(inbox.total).toBe(3); // needs-you + two listed slack items
    const old = slack.find(i => i.id === 'slack:C0FAKE0002:1700000000.000200')!;
    const fresh = slack.find(i => i.id === 'slack:C0FAKE0002:1700000000.000400')!;
    expect(old).toMatchObject({
      kind: 'slack-request', severity: 'warn', blocking: false, since: rows[0]!.at, expiresAt: null,
      title: 'Slack request in C0FAKE0002 waiting 40m, no same-thread reply',
      detail: 'thread 1700000000.000100 · RECEIVED, not ASSIGNED',
      act: ['phm channels slack status --json'],
    });
    expect(fresh.severity).toBe('info');
    expect(fresh.title).toBe('Slack request in C0FAKE0002 waiting 3m, no same-thread reply');
    expect(seen[0]).toMatchObject({ runsDir, stateRoot: join(root, 'slack') });
  });

  it('degraded replies report degraded with no slack items; other sources still list', async () => {
    const inbox = await readUnifiedInbox({ ...others(), readSlackStatus: status('degraded', 2, rows) });
    expect(inbox.sources.slack.state).toBe('degraded');
    expect(inbox.items.some(i => i.source === 'slack')).toBe(false);
    expect(inbox.items.map(i => i.id)).toContain('needs-you:nm-1');
  });

  it('a throwing seam reports unavailable without throwing', async () => {
    const inbox = await readUnifiedInbox({ ...others(), readSlackStatus: () => { throw new Error('boom'); } });
    expect(inbox.sources.slack).toEqual({ state: 'unavailable', pending: 0 });
    expect(inbox.items.map(i => i.id)).toContain('needs-you:nm-1');
  });

  it('missing replies report missing', async () => {
    const inbox = await readUnifiedInbox({ ...others(), readSlackStatus: status('missing', 0, []) });
    expect(inbox.sources.slack).toEqual({ state: 'missing', pending: 0 });
  });

  it('items carry nothing beyond channel id, ts and minutes', async () => {
    const inbox = await readUnifiedInbox({ ...others(), readSlackStatus: status('ok', 2, rows) });
    for (const item of inbox.items.filter(i => i.source === 'slack')) {
      expect(item.title).toMatch(/^Slack request in C0FAKE0002 waiting \d+m, no same-thread reply$/);
      expect(item.detail).toMatch(/^thread \d+\.\d+ · RECEIVED, not ASSIGNED$/);
    }
  });
});
