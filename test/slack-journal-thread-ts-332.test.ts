/**
 * RQ-PHX-SLACKJOURNALTHREAD332 -- the Slack journal records each delivery's
 * thread coordinates (the event's own ts and its thread root ts) as Slack
 * ids, so a later change can bind same-thread replies in channel-health.
 * Ids only, never text: anything outside the Slack ts grammar is dropped on
 * write and on read. Synthetic fixtures only; no socket, no Slack API.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ingestSlackSocketMessage } from '../src/core/agents/slack-inbound.js';
import { readSlackJournal, recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import type { SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import type { TeamIdentity } from '../src/core/agents/channel-policy.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-journal-ts-332-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEAM: TeamIdentity[] = [{ channel: 'slack', id: 'U0FAKEUSR' }];
const CONFIG: SlackBridgeConfig = {
  bridgeId: 'slack',
  teamId: 'T0FAKEWS',
  ownUserId: 'U0FAKEBOT',
  ownBotId: 'B0FAKEBOT',
  botTokenRef: 'phm_SLACK_FAKE332_BOT_TOKEN',
  appTokenRef: 'phm_SLACK_FAKE332_APP_TOKEN',
  map: [{ topic: 'fleet', channel: 'C0FAKECH' }],
};

const TEXT = 'zebra moon thread text 332';

function socketEnvelope(event: unknown): Record<string, unknown> {
  return { envelope_id: 'env-332', type: 'events_api', payload: { event_id: 'Ev0FAKE332', event } };
}
function messageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message', team: 'T0FAKEWS', channel: 'C0FAKECH',
    user: 'U0FAKEUSR', text: TEXT, ts: '1700000000.000100', ...overrides,
  };
}
function ingest(event: unknown, runsDir: string) {
  return ingestSlackSocketMessage(socketEnvelope(event), {
    config: CONFIG, teamIdentities: TEAM, runsDir,
    publish: (envelope: BusEnvelope) => ({ status: 'posted', id: envelope.id, cursor: 1 }),
    now: () => new Date('2026-11-14T00:00:00Z'),
  });
}
function journalFile(runsDir: string): string {
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  return slackJournalPath(runsDir);
}

describe('slack journal thread coordinates (RQ-PHX-SLACKJOURNALTHREAD332)', () => {
  it('journals messageTs===threadTs===ts for an ingested top-level message', () => {
    const runsDir = join(root(), 'runs');
    expect(ingest(messageEvent(), runsDir).decision).toBe('ingested');
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      decision: 'ingested', bus: 'posted', channelId: 'C0FAKECH', authorId: 'U0FAKEUSR',
      messageTs: '1700000000.000100', threadTs: '1700000000.000100',
    });
  });

  it('journals threadTs===thread_ts and messageTs===ts for an ingested reply', () => {
    const runsDir = join(root(), 'runs');
    expect(ingest(messageEvent({ ts: '1700000000.000200', thread_ts: '1700000000.000050' }), runsDir).decision).toBe('ingested');
    const [row] = readSlackJournal({ runsDir }).entries;
    expect(row).toMatchObject({ messageTs: '1700000000.000200', threadTs: '1700000000.000050' });
  });

  it('journals coordinates on ignored events when the ts values are valid', () => {
    const runsDir = join(root(), 'runs');
    const refused = ingest(messageEvent({ user: 'U0FAKEOUT', ts: '1700000000.000300', thread_ts: '1700000000.000050' }), runsDir);
    expect(refused.decision).toBe('ignored');
    expect(refused.reason).toBe('untrusted-sender');
    const [row] = readSlackJournal({ runsDir }).entries;
    expect(row).toMatchObject({
      decision: 'ignored', reason: 'untrusted-sender',
      messageTs: '1700000000.000300', threadTs: '1700000000.000050',
    });
  });

  it('journals no coordinates for an ignored event whose ts values are not Slack ts', () => {
    const runsDir = join(root(), 'runs');
    const refused = ingest({
      type: 'message', subtype: 'channel_join', team: 'T0FAKEWS', channel: 'C0FAKECH',
      user: 'U0FAKEOUT', ts: 'just text', thread_ts: 'also text',
    }, runsDir);
    expect(refused.decision).toBe('ignored');
    const [row] = readSlackJournal({ runsDir }).entries;
    expect(row).not.toHaveProperty('messageTs');
    expect(row).not.toHaveProperty('threadTs');
    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    expect(raw).not.toContain('just text');
    expect(raw).not.toContain('also text');
  });

  it('never writes a malformed ts passed to recordSlackObservation', () => {
    const runsDir = join(root(), 'runs');
    const outcome = recordSlackObservation({
      at: '2026-11-14T00:00:00Z', decision: 'ingested', bus: 'posted',
      messageTs: 'reply text not a ts', threadTs: '1700000000.000100.bad',
    }, { runsDir });
    expect(outcome).toBe('recorded');
    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    expect(raw).not.toContain('reply text not a ts');
    expect(raw).not.toContain('messageTs');
    expect(raw).not.toContain('threadTs');
    const [row] = readSlackJournal({ runsDir }).entries;
    expect(row).not.toHaveProperty('messageTs');
    expect(row).not.toHaveProperty('threadTs');
  });

  it('readSlackJournal drops a hand-written row whose threadTs is not a Slack ts', () => {
    const runsDir = join(root(), 'runs');
    writeFileSync(journalFile(runsDir),
      `${JSON.stringify({ at: '2026-11-14T00:00:00Z', decision: 'ingested', bus: 'posted', messageTs: '1700000000.000100', threadTs: 'not-a-slack-ts' })}\n`,
      { mode: 0o600 });
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({ messageTs: '1700000000.000100' });
    expect(journal.entries[0]).not.toHaveProperty('threadTs');
  });

  it('never writes message text to the journal file', () => {
    const runsDir = join(root(), 'runs');
    expect(ingest(messageEvent(), runsDir).decision).toBe('ingested');
    expect(ingest(messageEvent({ user: 'U0FAKEOUT', text: 'secret zebra moon 332', ts: '1700000000.000400' }), runsDir).decision).toBe('ignored');
    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    expect(raw).not.toContain(TEXT);
    expect(raw).not.toContain('secret zebra moon 332');
    expect(JSON.stringify(readSlackJournal({ runsDir }).entries)).not.toContain('zebra');
  });

  it('reads older rows that predate the ts fields', () => {
    const runsDir = join(root(), 'runs');
    writeFileSync(journalFile(runsDir),
      '{"at":"2026-11-05T11:00:00Z","decision":"ignored","reason":"untrusted-sender","channelId":"C0FAKECH"}\n' +
      '{"at":"2026-11-05T11:01:00Z","decision":"ingested","bus":"posted","authorId":"U0FAKEUSR"}\n',
      { mode: 0o600 });
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries.map((e) => e.at)).toEqual(['2026-11-05T11:01:00Z', '2026-11-05T11:00:00Z']);
    for (const entry of journal.entries) {
      expect(entry).not.toHaveProperty('messageTs');
      expect(entry).not.toHaveProperty('threadTs');
    }
  });
});
