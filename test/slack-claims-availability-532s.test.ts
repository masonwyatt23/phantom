import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSlackWorkStatus, slackWorkStatusLine, type SlackWorkStatus } from '../src/core/agents/slack-status.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const REF = 'slack:T0FAKETEAM:C0FAKECHAN:1700000000.000100';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'slack-claims-532s-'));
  roots.push(dir);
  const root = join(dir, 'bus'), runsDir = join(dir, 'runs');
  const request = (id: string): BusEnvelope => ({
    id, from: 'fake-owner', to: 'leader', priority: 'P1', ttl: 600_000,
    channel: 'slack', channel_ref: REF, external: false,
    sender: { agent_id: 'fake-owner', vendor: 'fake', human: true, team: true },
    body: { kind: 'note', text: 'fake status request' },
  });
  for (const id of ['fake-request-a', 'fake-request-b']) {
    expect(appendBusInbox(request(id), { root, now: () => NOW }).status).toBe('posted');
  }
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  writeFileSync(join(runsDir, 'queue/status.json'), JSON.stringify({ last_tick: new Date(NOW - 60_000).toISOString() }));
  const claimsDir = join(root, 'bus-work-claims'), claimsFile = join(claimsDir, 'claims.json');
  const writeClaims = (text: string) => {
    mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
    writeFileSync(claimsFile, text, { mode: 0o600 });
  };
  const read = () => readSlackWorkStatus({ busRoot: root, runsDir, channelRef: REF, now: () => new Date(NOW) });
  const line = () => slackWorkStatusLine(read(), { inReplyTo: 'fake-request-a' });
  // Snapshot all fixture bytes and names around observations, including an absent table.
  const snapshot = () => readdirSync(dir, { recursive: true, withFileTypes: true })
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path, entry.isDirectory() ? 'directory' : readFileSync(path).toString('hex')];
    }).sort((a, b) => a[0]!.localeCompare(b[0]!));
  const observe = (source: 'missing' | 'available' | 'unavailable') => {
    const before = snapshot();
    expect(listWorkBoard({ root, now: NOW, channelRef: REF }).claims).toBe(source);
    const work = read();
    expect(work.claims).toBe(source);
    expect(snapshot()).toEqual(before);
    return work;
  };
  return { root, claimsFile, writeClaims, read, line, observe };
}

const tail = '; fleet as of 2026-11-17T11:59Z from fleet tick';

describe('Slack claims-read availability (532s)', () => {
  it('distinguishes absent, validated empty, malformed and restored tables on each read', () => {
    const f = fixture();
    const lines: string[] = [];
    for (const source of ['missing', 'available', 'unavailable', 'available'] as const) {
      if (source === 'available') f.writeClaims('[]');
      if (source === 'unavailable') f.writeClaims('{ fake malformed ownership table');
      const work = f.observe(source);
      expect(work.inbox).toBe('ok');
      expect(work.items).toHaveLength(2);
      expect(work.items.every(item => item.state === 'RECEIVED' && item.owner === null && item.claimReceipt === null)).toBe(true);
      const line = slackWorkStatusLine(work, { inReplyTo: 'fake-request-a' });
      expect(line).toContain(`claims read ${source}`);
      expect(line).toMatch(/^RECEIVED; owner unknown; claim unknown;/);
      expect(line.endsWith(tail)).toBe(true);
      expect(line).not.toMatch(/ASSIGNED|RUNNING|fake malformed|claims\.json|connected/);
      lines.push(line);
    }
    expect(new Set(lines).size).toBe(3);
    expect(lines[3]).toBe(lines[1]);
    rmSync(f.claimsFile);
    f.observe('missing');
  });

  it.each(['missing', 'available', 'unavailable'] as const)('retains %s claims observation during an inbox failure', source => {
    const f = fixture();
    if (source !== 'missing') f.writeClaims(source === 'available' ? '[]' : 'not-json');
    const inboxFile = join(f.root, 'bus-inbox/messages.json');
    const original = readFileSync(inboxFile);
    writeFileSync(inboxFile, 'malformed fake inbox');
    const work = f.observe(source);
    expect(work.inbox).toBe('unavailable');
    expect(work.items).toEqual([]);
    const line = slackWorkStatusLine(work, { inReplyTo: 'fake-request-a' });
    expect(line).toContain(`claims read ${source}`);
    expect(line).toContain('; inbox read unavailable;');
    expect(line).toMatch(/^UNKNOWN; owner unknown; claim unknown;/);
    expect(line.endsWith(tail)).toBe(true);
    expect(line).not.toMatch(/malformed fake|messages\.json|ENOENT|EACCES/);
    writeFileSync(inboxFile, original);
    expect(f.observe(source).inbox).toBe('ok');
  });

  it('preserves result details and exact binding while qualifying a failed claims read', () => {
    const f = fixture();
    f.writeClaims('{');
    expect(postBusReply('fake-request-a', 'fake-blocker', { blocked: { dependency: 'fake-review' } },
      { root: f.root, now: () => NOW }).outcome).toBe('posted');
    expect(f.line()).toBe(`BLOCKED; dependency fake-review; claims read unavailable (ownership inspection failed)${tail}`);
    expect(postBusReply('fake-request-b', 'fake-verifier', { verified: { pr: 42, head: 'abcdef123' } },
      { root: f.root, now: () => NOW }).outcome).toBe('posted');
    const work = f.observe('unavailable');
    const digest = (id: string) => createHash('sha256').update(JSON.stringify(['slack', id])).digest('hex');
    for (const body of [{ inReplyTo: 'fake-request-b' }, { in_reply_to: 'fake-request-b' }, { requestId: digest('fake-request-b') }]) {
      expect(slackWorkStatusLine(work, body)).toBe(`VERIFIED; PR 42; head abcdef123; claims read unavailable (ownership inspection failed)${tail}`);
    }
    for (const body of [{ inReplyTo: 'fake-request-a', requestId: digest('fake-request-b') },
      { inReplyTo: 'fake-absent' }, { thread: REF }]) {
      const line = slackWorkStatusLine(work, body);
      expect(line).toMatch(/^UNKNOWN; owner unknown; claim unknown;/);
      expect(line).not.toMatch(/PR 42|fake-review/);
    }
  });

  it('keeps legacy fixture availability unknown and formats safely', () => {
    const legacy: SlackWorkStatus = { asOf: null, inbox: 'ok', truncated: false, items: [] };
    expect(slackWorkStatusLine(legacy, {})).toBe('UNKNOWN; owner unknown; claim unknown; claims read unknown; fleet as of unknown');
  });
});
