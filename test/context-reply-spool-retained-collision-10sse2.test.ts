import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import {
  contextReplyRecordPath, deliverSpooledContextReply, savePendingContextReply,
} from '../src/core/fleet/context-reply-spool.js';

let root: string, spoolDir: string, busRoot: string;
const reply = (id: string, text: string): BusEnvelope =>
  ({ id, from: 'worker', to: 'requester', priority: 'P2', ttl: 600000, body: { text } });
const save = (value: BusEnvelope, preparedAt: number, exitCode = 0) =>
  savePendingContextReply(spoolDir, { reply: value, preparedAt, workerExit: { status: 'returned', exitCode } });
const recordOf = (id: string) => contextReplyRecordPath(spoolDir, id)!;
const names = async () => (await readdir(spoolDir)).filter(n => /^reply-[0-9a-f]{32}\.json$/.test(n));
const wireOf = (value: BusEnvelope) => {
  const checked = validateBusEnvelope(value);
  if (!checked.ok) throw new Error('bad fixture');
  return checked.json;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reply-spool-collision-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  spoolDir = join(root, 'spool'); busRoot = join(root, 'bus');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('keeps the first reply, exit code and preparedAt when a different reply reuses the id', async () => {
  const preparedAt = Date.now() - 1000;
  expect(save(reply('same', 'result A'), preparedAt, 3)).toBe('saved');
  const before = await readFile(recordOf('same'), 'utf8');
  expect(save(reply('same', 'result B'), Date.now(), 0)).not.toBe('saved');
  expect(await readFile(recordOf('same'), 'utf8')).toBe(before);
  const kept = JSON.parse(before);
  expect(kept).toMatchObject({ wire: wireOf(reply('same', 'result A')), preparedAt, workerExit: { status: 'returned', exitCode: 3 } });
  expect(await names()).toHaveLength(1);
});

it('keeps the record when only the worker outcome differs', async () => {
  expect(save(reply('same', 'result A'), 1000, 0)).toBe('saved');
  const before = await readFile(recordOf('same'), 'utf8');
  expect(save(reply('same', 'result A'), 1000, 9)).not.toBe('saved');
  expect(await readFile(recordOf('same'), 'utf8')).toBe(before);
});

it('treats an identical repeated save as idempotent and keeps the original age', async () => {
  const preparedAt = Date.now() - 5000;
  expect(save(reply('same', 'result A'), preparedAt, 2)).toBe('saved');
  const before = await readFile(recordOf('same'), 'utf8');
  expect(save(reply('same', 'result A'), Date.now(), 2)).toBe('saved');
  expect(await readFile(recordOf('same'), 'utf8')).toBe(before);
  expect(JSON.parse(before).preparedAt).toBe(preparedAt);
});

it('still saves distinct ids normally', async () => {
  expect(save(reply('one', 'A'), 1)).toBe('saved');
  expect(save(reply('two', 'B'), 2)).toBe('saved');
  expect(await names()).toHaveLength(2);
});

it('delivers the original retained payload, not the rejected later one', async () => {
  const now = Date.now();
  expect(save(reply('same', 'result A'), now - 10)).toBe('saved');
  expect(save(reply('same', 'result B'), now)).not.toBe('saved');
  const result = deliverSpooledContextReply(recordOf('same'), { root: busRoot });
  expect(result).toMatchObject({ delivery: { status: 'posted' }, exitCode: 0, workerExit: { status: 'returned', exitCode: 0 } });
  const page = listBusInboxAfter(0, 50, { root: busRoot });
  if (page.status !== 'ok') throw new Error('inbox unavailable');
  expect(page.messages).toHaveLength(1);
  expect(JSON.stringify(page.messages[0])).toContain('result A');
  expect(JSON.stringify(page.messages[0])).not.toContain('result B');
});

it.each(['malformed', 'unsafe-mode'] as const)('does not overwrite a %s existing record', async kind => {
  expect(save(reply('other', 'x'), 1)).toBe('saved'); // creates the private spool directory
  const path = recordOf('same');
  const content = kind === 'malformed' ? 'not json' : JSON.stringify({ version: 1 });
  await writeFile(path, content, { mode: 0o600 });
  if (kind === 'unsafe-mode') await chmod(path, 0o666);
  expect(save(reply('same', 'result A'), Date.now())).not.toBe('saved');
  expect(await readFile(path, 'utf8')).toBe(content);
});

it('lets only one of two independent processes win a shared id', async () => {
  const modulePath = pathToFileURL(resolve('src/core/fleet/context-reply-spool.ts')).href;
  expect(save(reply('warm', 'x'), 1)).toBe('saved'); // creates the private spool directory
  const child = (text: string) => new Promise<string>((done, fail) => {
    const script = `import { savePendingContextReply } from ${JSON.stringify(modulePath)};
      process.stdout.write(savePendingContextReply(${JSON.stringify(spoolDir)}, { preparedAt: 4242,
        workerExit: { status: 'returned', exitCode: 0 },
        reply: { id: 'race', from: 'worker', to: 'requester', priority: 'P2', ttl: 600000, body: { text: ${JSON.stringify(text)} } } }));`;
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { env: { ...process.env, HOME: root, ASHLR_HOME: join(root, '.ashlr') }, timeout: 60000 },
      (error, stdout) => (error ? fail(error) : done(stdout)));
  });
  const results = await Promise.all([child('from process A'), child('from process B')]);
  // Contention may yield 'unavailable' for the loser; neither may replace the winner.
  expect(results.filter(r => r === 'saved').length).toBeGreaterThanOrEqual(1);
  const kept = JSON.parse(await readFile(recordOf('race'), 'utf8'));
  const winners = ['from process A', 'from process B'].filter(t => kept.wire === wireOf(reply('race', t)));
  expect(winners).toHaveLength(1);
  // Re-saving the loser stays refused and the winner's bytes survive.
  const loser = ['from process A', 'from process B'].find(t => t !== winners[0])!;
  const before = await readFile(recordOf('race'), 'utf8');
  expect(save(reply('race', loser), Date.now())).not.toBe('saved');
  expect(await readFile(recordOf('race'), 'utf8')).toBe(before);
  expect(kept.preparedAt).toBe(4242);
}, 90000);
