import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildContextPack, compactContext, packTokens } from '../src/core/fleet/context-pack.js';

let root: string;
const now = Date.UTC(2026, 10, 1);
const EVENTS = '2026-11-01 00:00:00 MERGED job=old\n'
  + '2026-11-01 23:50:00 LAUNCH new phantom claude opus code\n'
  + '2026-11-02 00:00:00 OUTCOME new merged usage=0.2\n';
const options = (clock: () => number = () => now) => ({
  job: 'JOB-1', lane: 'claude', root: join(root, 'bus'), runsDir: root,
  home: join(root, 'home'), now: clock,
});
const logPath = () => join(root, 'queue', 'dispatch-events.log');
const section = (pack: string, name: string) =>
  (JSON.parse(pack) as { sections: { name: string; rows: Record<string, unknown>[] }[] })
    .sections.find((entry) => entry.name === name)!.rows;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctx2910-'));
  await mkdir(join(root, 'queue'), { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({
    last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50,
    lanes: { claude: { running: 0, target: 1, queued: 0, held: false } },
  }));
  await writeFile(logPath(), EVENTS);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function post(id: string, body: object): void {
  expect(appendBusInbox({ id, from: 'core', to: 'claude', priority: 'P0', ttl: 60000, body }, options()).status).toBe('posted');
}

it('returns byte-identical JSON across a small clock advance and appends only CTXPACK metadata', async () => {
  post('thread', { job: 'JOB-1', text: 'Discuss this job' });
  const first = await buildContextPack(options());
  const second = await buildContextPack(options(() => now + 1000));
  expect(second).toBe(first);
  expect(first).toContain('Discuss this job');
  expect(first.indexOf('OUTCOME new merged')).toBeLessThan(first.indexOf('MERGED job=old'));
  const log = await readFile(logPath(), 'utf8');
  const accounting = log.split('\n').filter((line) => line.includes('CTXPACK'));
  expect(accounting).toHaveLength(2);
  for (const line of accounting) {
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} CTXPACK job=JOB-1 lane=claude pack_tokens=\d+$/);
  }
  expect(log).toContain(`pack_tokens=${packTokens(first)}`);
  expect(log.startsWith(EVENTS)).toBe(true);
  expect(log).not.toContain('Discuss this job');
});

it('drops the lowest-priority multibyte section inside the exact UTF-8 budget and scrubs secret shapes', () => {
  const json = compactContext('job', 'lane', [
    { name: 'blockers', rows: ['keep'] },
    { name: 'threads', rows: ['世界'.repeat(10000)] },
  ], 256);
  expect(packTokens(json)).toBeLessThanOrEqual(256);
  expect(json).toContain('keep');
  expect(json).not.toContain('世界');
  const secret = `ghp_${'a'.repeat(36)}`;
  const scrubbed = compactContext('job', 'lane', [
    { name: 'threads', rows: [{ text: secret, password: 'fixture-password', token: 'short secret' }] },
  ], 2000);
  for (const leaked of [secret, 'fixture-password', 'short secret']) expect(scrubbed).not.toContain(leaked);
  expect(scrubbed).toContain('[REDACTED]');
});

it('includes the parent thread and clears resolved blockers from parsed sections', async () => {
  post('parent', { text: 'forum parent' });
  post('reply', { inReplyTo: 'parent', job: 'JOB-1', status: 'blocked' });
  let pack = await buildContextPack(options());
  expect(section(pack, 'threads').map((row) => row.id)).toEqual(expect.arrayContaining(['parent', 'reply']));
  expect(JSON.stringify(section(pack, 'threads'))).toContain('forum parent');
  expect(section(pack, 'blockers')).toHaveLength(1);
  post('resolved', { inReplyTo: 'reply', status: 'resolved' });
  pack = await buildContextPack(options());
  expect(section(pack, 'blockers')).toHaveLength(0);
  expect(section(pack, 'threads').map((row) => row.id)).toContain('resolved');
});
