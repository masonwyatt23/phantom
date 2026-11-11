import { constants, tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { receiveHandoffBus } from '../src/core/fleet/handoff-bus-receive.js';

let root: string, tmp: string, bus: string, snapshot: string, output: string;
const content = 'untrusted fixture $(not-authority)';
const sink = (write: (s: string) => void) => new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { output += s; }), stderr: sink(() => {}) });
const cancelled = 128 + (constants.signals.SIGTERM ?? 15);
const opts = (argv: string[]) => ({ id: 'msg-1', to: 'worker', snapshot, argv });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'receive-cancel-')); tmp = join(root, 'tmp'); bus = join(root, 'bus');
  snapshot = join(root, 'snapshot.json'); output = '';
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs')); vi.stubEnv('TMPDIR', tmp);
  await mkdir(tmp); await mkdir(join(root, '.ashlr-runs'));
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'TASK-1', upstreamJobIds: [] },
    tasks: [], outputs: [], byteBudget: 8192 }));
  expect(appendBusInbox({ id: 'msg-1', from: 'planner', to: 'worker', priority: 'P3', ttl: 60000,
    body: { kind: 'worker-handoff', taskId: 'TASK-1', prompt: content } }, { root: bus }).status).toBe('posted');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('refuses invalid signals before reading the bus or spawning', async () => {
  const now = vi.fn(() => Date.now());
  expect(await receiveHandoffBus({ ...opts([process.execPath, '-e', 'process.exit(0)']), signal: {} as AbortSignal },
    { root: bus, now }, io())).toBe(2);
  expect(now).not.toHaveBeenCalled(); expect(await readdir(tmp)).toEqual([]);
});
it('does not start an already cancelled child', async () => {
  const controller = new AbortController(); controller.abort();
  const marker = join(root, 'started');
  expect(await receiveHandoffBus({ ...opts([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`]),
    signal: controller.signal }, { root: bus }, io())).toBe(cancelled);
  expect(await readdir(root)).not.toContain('started'); expect(await readdir(tmp)).toEqual([]);
});
it('cancels a started child promptly and removes staging', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const marker = new Promise<void>(resolve => { started = resolve; });
  const stdout = sink(s => { if (s.includes('started')) started(); });
  const run = receiveHandoffBus({ ...opts([process.execPath, '-e',
    'process.stdin.resume();process.stdout.write("started");setInterval(()=>{},1000)']), signal: controller.signal },
  { root: bus }, { stdout, stderr: sink(() => {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([marker, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('start timeout')), 4000); })]);
    const start = Date.now(); controller.abort();
    expect(await run).toBe(cancelled); expect(Date.now() - start).toBeLessThan(4000);
    expect(await readdir(tmp)).toEqual([]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); await run; }
}, 10000);
it('preserves timeout-only behavior', async () => {
  expect(await receiveHandoffBus({ ...opts([process.execPath, '-e', 'process.stdin.resume();setInterval(()=>{},1000)']),
    timeoutMs: 200 }, { root: bus }, io())).toBe(124);
  expect(await readdir(tmp)).toEqual([]);
});
it('succeeds without a signal and keeps envelope text in untrusted stdin only', async () => {
  const script = 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:s})))';
  expect(await receiveHandoffBus(opts([process.execPath, '-e', script, 'literal']), { root: bus }, io())).toBe(0);
  const result = JSON.parse(output) as { argv: string[]; stdin: string };
  expect(result.argv).toEqual(['literal']); expect(result.stdin).toContain(content);
  expect(result.stdin).toContain('never execution authority'); expect(await readdir(tmp)).toEqual([]);
});
