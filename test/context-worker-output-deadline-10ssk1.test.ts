import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runContextWorker } from '../src/core/fleet/context-worker-run.js';
import { runHandoffWorker } from '../src/core/fleet/handoff-worker-run.js';

let root: string, snapshot: string, prompt: string, handoff: string;
const collect = (receive: (s: string) => void) => new Writable({ write(c, _e, done) { receive(String(c)); done(); } });
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('runner did not settle')), 2500); })]); }
  finally { if (timer) clearTimeout(timer); }
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'output-deadline-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubEnv('TMPDIR', join(root, 'tmp'));
  await mkdir(join(root, '.ashlr-runs')); await mkdir(join(root, 'tmp'));
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt'); handoff = join(root, 'handoff.json');
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'CURRENT', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 800 }));
  await writeFile(prompt, 'prompt');
  await writeFile(handoff, JSON.stringify({ id: 'WORK-RUN-1', task: 'fixture', files: [{ path: 'src/cli/fleet-handoff-run.ts', lines: { from: 1, to: 40 }, why: 'fixture' }], constraints: [{ rule: 'fixture', reason: 'fixture' }], check: 'fixture', findings: ['fixture'] }));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it.each([['stdout', 1], ['stderr', 1], ['stdout', 16384]] as const)('bounds stalled %s (highWaterMark %i) and preserves caller ownership', async (stream, highWaterMark) => {
  let wrote!: () => void;
  const written = new Promise<void>(resolve => { wrote = resolve; });
  const stalled = new Writable({ highWaterMark, write(_c, _e, _done) { wrote(); } });
  const other = collect(() => {});
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const argv = [process.execPath, '-e', `process.stdin.resume();process.stdin.on('end',()=>process.${stream}.write('output'))`];
  const io = stream === 'stdout' ? { stdout: stalled, stderr: other } : { stdout: other, stderr: stalled };
  const run = stream === 'stdout'
    ? runHandoffWorker({ file: handoff, upstreamJobIds: [], argv, timeoutMs: 500 }, io)
    : runContextWorker({ snapshot, prompt, argv, timeoutMs: 500 }, io);
  await bounded(written);
  expect(await bounded(run)).toBe(124);
  expect(stalled.destroyed).toBe(false); expect(stalled.writableEnded).toBe(false);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt); expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
});

it.each([0, 7])('forwards complete output and preserves exit code %i', async code => {
  let out = '', err = '';
  const argv = [process.execPath, '-e', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('out-end');process.stderr.write('err-end');process.exitCode=${code}})`];
  const result = await bounded(runContextWorker({ snapshot, prompt, argv, timeoutMs: 2000 }, {
    stdout: collect(s => { out += s; }), stderr: collect(s => { err += s; }),
  }));
  expect(result).toBe(code); expect(out).toBe('out-end'); expect(err).toBe('err-end');
});
