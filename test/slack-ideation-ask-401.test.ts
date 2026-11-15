/** RQ-PHX-SLACKIDEATIONASK401 — exact "ideation"/"ideas"/"strategy" asks in the
 * Slack leader thread are answered in-thread with the newest
 * docs/strategy/IDEATION-<day>.md on the checkout. Fake repo roots and fake
 * plan content only; the real package tree is never read. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ledger from '../src/core/agentnet/peer-ledger.js';
import * as ideationReply from '../src/core/fleet/ideation-reply.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { isIdeationAsk } from '../src/core/fleet/ideation-ask.js';
import { formatIdeationReply, readLatestIdeation } from '../src/core/fleet/ideation-reply.js';

const NOW = new Date('2026-11-15T06:00:00.000Z');
const RUNS = '/nonexistent/fake-runs-401';
const ABSENT = 'No ideation plan on this checkout yet (docs/strategy/IDEATION-*.md absent).';

const plan = (day: string, proposals: number): string =>
  `# Ideation ${day}\n\nfake vision prose\n\nAdvisory; normal admission and review apply. Local artifact, no publication authority.\n\n## Selected\n\n` +
  Array.from({ length: proposals }, (_, i) =>
    `- RQ-IDEA-FAKE${i}: fake scope ${i} Acceptance: fake test ${i} Leverage x vision: ${20 - i}; research score: 9; evidence: S1.`).join('\n') +
  '\n\n## Archive\n\n- RQ-IDEA-DROPPED: rank-limit\n';

const repoWith = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'slack-ideation-401-'));
  mkdirSync(join(root, 'docs', 'strategy'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, 'docs', 'strategy', name), text, { mode: 0o600 });
  }
  return root;
};

const peersReport: ledger.PeerLedgerReport = {
  v: 1, authority: 'none', status: 'ok', asOf: NOW.toISOString(), liveRows: 0,
  capacity: 1024, windowMs: 60_000, pairLimit: 6, maxHops: 8,
  pairs: [], origins: [], truncated: { pairs: false, origins: false },
};

afterEach(() => vi.restoreAllMocks());

describe('isIdeationAsk', () => {
  it.each(['ideation', 'ideas', 'strategy', 'latest ideation', 'Ideation?', '  STRATEGY!  ', 'ideas?!.'])(
    'accepts %s', text => expect(isIdeationAsk(text)).toBe(true));
  it.each(['ideation plan please', 'strategy doc', 'idea', 'ideation latest', 'status', 'peers', '',
    'ideation\nplease', `ideation${'?'.repeat(36)}`])(
    'rejects %s', text => expect(isIdeationAsk(text)).toBe(false));
});

describe('readLatestIdeation', () => {
  it('chooses the newest file by filename date and caps titles at 5', async () => {
    const root = repoWith({
      'IDEATION-2026-11-14.md': plan('2026-11-14', 7),
      'IDEATION-2026-11-12.md': plan('2026-11-12', 1),
      'NOTES.md': '# not an ideation file',
    });
    try {
      const read = await readLatestIdeation(root);
      expect(read.status).toBe('ok');
      expect(read.day).toBe('2026-11-14');
      expect(read.relPath).toBe('docs/strategy/IDEATION-2026-11-14.md');
      expect(read.titles).toHaveLength(5);
      expect(read.titles?.[0]).toMatch(/^RQ-IDEA-FAKE0: fake scope 0/);
      for (const title of read.titles ?? []) expect(title.length).toBeLessThanOrEqual(120);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ignores directories and invalid dates named like ideation files', async () => {
    const root = repoWith({ 'IDEATION-2026-11-10.md': plan('2026-11-10', 1) });
    try {
      mkdirSync(join(root, 'docs', 'strategy', 'IDEATION-2026-11-13.md'));
      writeFileSync(join(root, 'docs', 'strategy', 'IDEATION-2026-13-99.md'), plan('2026-13-99', 1));
      const read = await readLatestIdeation(root);
      expect(read.day).toBe('2026-11-10');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports absent when no IDEATION file exists', async () => {
    const missing = join(tmpdir(), `slack-ideation-401-nodir-${process.pid}`);
    expect(await readLatestIdeation(missing)).toEqual({ status: 'absent' });
    const root = repoWith({ 'OTHER.md': '# fake' });
    try {
      expect(await readLatestIdeation(root)).toEqual({ status: 'absent' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports unavailable when the file read fails', async () => {
    const root = repoWith({ 'IDEATION-2026-11-14.md': plan('2026-11-14', 1) });
    try {
      const read = await readLatestIdeation(root, { readFile: async () => { throw new Error('fake private read failure'); } });
      expect(read).toEqual({ status: 'unavailable', reason: 'ideation file unreadable' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('formatIdeationReply', () => {
  it('marks a newest file older than 2 days stale', () => {
    const out = formatIdeationReply(
      { status: 'ok', day: '2026-11-12', relPath: 'docs/strategy/IDEATION-2026-11-12.md', titles: ['RQ-IDEA-FAKE0: fake'] },
      NOW);
    expect(out).toContain('Ideation plan 2026-11-12 · 3 days old · stale');
    expect(out.endsWith(`source: docs/strategy/IDEATION-2026-11-12.md, as of ${NOW.toISOString()}`)).toBe(true);
  });

  it('does not mark a 2-day-old file stale', () => {
    const out = formatIdeationReply(
      { status: 'ok', day: '2026-11-13', relPath: 'docs/strategy/IDEATION-2026-11-13.md', titles: [] }, NOW);
    expect(out).toContain('2 days old');
    expect(out).not.toContain('stale');
  });

  it('returns the fixed absent and unknown strings', () => {
    expect(formatIdeationReply({ status: 'absent' }, NOW)).toBe(ABSENT);
    expect(formatIdeationReply({ status: 'unavailable', reason: 'ideation file unreadable' }, NOW))
      .toBe('Ideation unknown: ideation file unreadable');
  });
});

describe('ownerStatusReply ideation branch', () => {
  it('asks and composes the ideation text, never the status digest', async () => {
    const root = repoWith({ 'IDEATION-2026-11-14.md': plan('2026-11-14', 2) });
    try {
      const brief = vi.fn(async () => 'Morning leader brief\nFAKE DIGEST');
      const reply = ownerStatusReply({ ideationRepoRoot: root, brief });
      expect(ownerStatusReply().ask('ideation')).toBe(true);
      expect(reply.ask('latest ideation')).toBe(true);
      expect(reply.ask('ideas?')).toBe(true);
      const out = await reply.compose(RUNS, NOW, 'ideation');
      expect(out).toContain('Ideation plan 2026-11-14 · 1 day old');
      expect(out).toContain('RQ-IDEA-FAKE0: fake scope 0');
      expect(out.endsWith(`source: docs/strategy/IDEATION-2026-11-14.md, as of ${NOW.toISOString()}`)).toBe(true);
      expect(out).not.toContain('FAKE DIGEST');
      expect(brief).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('answers absent and reader-failure with the fixed strings', async () => {
    const missing = join(tmpdir(), `slack-ideation-401-noroot-${process.pid}`);
    expect(await ownerStatusReply({ ideationRepoRoot: missing }).compose(RUNS, NOW, 'strategy')).toBe(ABSENT);
    vi.spyOn(ideationReply, 'readLatestIdeation').mockImplementation(() => { throw new Error('fake private failure'); });
    expect(await ownerStatusReply({ ideationRepoRoot: missing }).compose(RUNS, NOW, 'ideation'))
      .toBe('Ideation unknown: ideation reader failed');
  });

  it('keeps peers and orders asks routed as before', async () => {
    vi.spyOn(ledger, 'readPeerLedger').mockImplementation(() => peersReport);
    const orders = vi.fn(async () => 'FAKE ORDERS TEXT');
    const brief = vi.fn(async () => 'Morning leader brief\nFAKE DIGEST');
    const reply = ownerStatusReply({ orders, brief, ideationRepoRoot: join(tmpdir(), 'none-401') });
    expect(reply.ask('peers')).toBe(true);
    expect(reply.ask('orders')).toBe(true);
    const peersOut = await reply.compose(RUNS, NOW, 'peers');
    expect(peersOut.startsWith('Peers (as of')).toBe(true);
    expect(await reply.compose(RUNS, NOW, 'orders')).toBe('FAKE ORDERS TEXT');
    expect(orders).toHaveBeenCalledOnce();
    expect(brief).not.toHaveBeenCalled();
  });
});
