import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { HANDOFF_RECEIVE_BEGIN, HANDOFF_RECEIVE_END, receiveHandoffBus } from '../src/core/fleet/handoff-bus-receive.js';

let root: string, bus: string, temp: string, snapshot: string, capture: string, stderr: string;
const options = () => ({ root: bus, now: () => 1000 });
const sink = (write: (text: string) => void) => new Writable({
  write(chunk, _encoding, done) { write(String(chunk)); done(); },
});
const io = () => ({ stdout: sink(() => undefined), stderr: sink(text => { stderr += text; }) });
const child = () => [process.execPath, '-e',
  'const fs=require("fs");fs.appendFileSync(process.argv[1],"start\\n");let s="";' +
  'process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{' +
  'fs.appendFileSync(process.argv[1],JSON.stringify(s)+"\\n");process.exitCode=7})', capture];
const post = (id: string, to: string, prompt: string) => appendBusInbox({
  id, from: 'planner', to, priority: 'P3', ttl: 60_000,
  body: { kind: 'worker-handoff', taskId: 'TASK-PAGED-1', prompt },
}, options());
const receive = (id: string) => receiveHandoffBus({ id, to: 'worker-target', snapshot, argv: child() }, options(), io());

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-paged-'));
  bus = join(root, 'bus'); temp = join(root, 'temp'); snapshot = join(root, 'snapshot.json');
  capture = join(root, 'capture'); stderr = '';
  vi.stubEnv('HOME', root); vi.stubEnv('TMPDIR', temp);
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  await mkdir(temp, { mode: 0o700 });
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'TASK-PAGED-1', upstreamJobIds: [] },
    tasks: [{ jobId: 'TASK-PAGED-1', text: 'snapshot context marker' }], outputs: [], byteBudget: 8192 }), { mode: 0o600 });
  expect(BUS_INBOX_MAX_READ + 1).toBeLessThan(BUS_INBOX_MAX_MESSAGES);
  for (let i = 0; i < BUS_INBOX_MAX_READ; i++) {
    expect(post(`noise-${i}`, `other-${i}`, `unrelated prompt ${i}`).status).toBe('posted');
  }
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('handoff receive with a paged inbox', () => {
  it('runs the requested retained handoff beyond the first page exactly once', async () => {
    expect(post('target', 'worker-target', 'requested prompt marker').status).toBe('posted');
    const first = listBusInboxAfter(0, BUS_INBOX_MAX_READ, options());
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('inbox unavailable');
    expect(first.messages).toHaveLength(BUS_INBOX_MAX_READ);
    expect(first.messages.some(row => row.envelope.id === 'target')).toBe(false);
    expect(await receive('target')).toBe(7);
    const lines = (await readFile(capture, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('start');
    const input = JSON.parse(lines[1]!) as string;
    expect(input).toContain(HANDOFF_RECEIVE_BEGIN);
    expect(input).toContain('requested prompt marker');
    expect(input).toContain(HANDOFF_RECEIVE_END);
    expect(input).toContain('snapshot context marker');
    expect(input).not.toContain('unrelated prompt');
    expect(await readdir(temp)).toEqual([]);
  }, 30000);

  it('refuses an absent target without invoking the child', async () => {
    expect(await receive('absent')).toBe(1);
    expect(stderr).toContain('no live handoff with that id');
    expect(existsSync(capture)).toBe(false);
    expect(await readdir(temp)).toEqual([]);
  }, 30000);
});
