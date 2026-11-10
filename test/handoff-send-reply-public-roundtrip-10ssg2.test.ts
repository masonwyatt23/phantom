import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetHandoffSend } from '../src/cli/fleet-handoff-send.js';
import { cmdFleetHandoffReply } from '../src/cli/fleet-handoff-reply.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

let dir = '';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it('composes public send and reply with deduplication and preflight refusal', async () => {
  dir = mkdtempSync(join(tmpdir(), 'public-handoff-'));
  vi.stubEnv('HOME', dir);
  vi.stubEnv('ASHLR_RUNS_DIR', join(dir, 'runs'));
  vi.stubEnv('ASHLR_HOME', join(dir, 'ashlr'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const root = join(dir, 'bus'), file = join(dir, 'handoff.json'), snapshot = join(dir, 'snapshot.json');
  const marker = join(dir, 'runs.txt');
  writeFileSync(file, JSON.stringify({ id: 'WORK-PUBLIC-1', task: 'Synthetic task', files: [{ path: 'src/example.ts' }], constraints: [], check: 'Verify result' }));
  const pack = (jobId: string) => JSON.stringify({ node: { jobId, upstreamJobIds: [] },
    tasks: [{ jobId, text: 'Synthetic context' }], outputs: [], byteBudget: 8192 });
  writeFileSync(snapshot, pack('WORK-PUBLIC-1'));
  const send = () => cmdFleetHandoffSend(['--file', file, '--id', 'msg-public-1', '--from', 'planner',
    '--to', 'worker', '--apply', '--json'], { root });
  expect(await send()).toBe(0);
  expect(await send()).toBe(0);
  const requests = listBusInboxAfter(0, 50, { root });
  expect(requests.status).toBe('ok');
  if (requests.status !== 'ok') throw new Error('inbox unavailable');
  expect(requests.messages).toHaveLength(1);
  expect(requests.messages[0]!.envelope).toMatchObject({ id: 'msg-public-1', from: 'planner', to: 'worker',
    body: { kind: 'worker-handoff', taskId: 'WORK-PUBLIC-1' } });
  let output = '';
  const stdout = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('synthetic result'))`;
  const reply = (to: string) => cmdFleetHandoffReply(['--id', 'msg-public-1', '--to', to, '--snapshot', snapshot,
    '--reply-id', 'msg-public-exit', '--spool-dir', join(dir, 'spool'), '--timeout-ms', '10000',
    '--', process.execPath, '-e', script], { root }, { stdout, stderr });
  expect(await reply('other')).toBe(1);
  writeFileSync(snapshot, pack('WORK-OTHER-1'));
  expect(await reply('worker')).toBe(1);
  expect(existsSync(marker)).toBe(false);
  writeFileSync(snapshot, pack('WORK-PUBLIC-1'));
  expect(await reply('worker')).toBe(0);
  expect(readFileSync(marker, 'utf8')).toBe('x');
  expect(output).toContain('synthetic result');
  const page = listBusInboxAfter(0, 50, { root });
  expect(page.status).toBe('ok');
  if (page.status !== 'ok') throw new Error('inbox unavailable');
  expect(page.messages).toHaveLength(2);
  expect(page.messages[1]!.envelope).toMatchObject({ id: 'msg-public-exit', from: 'worker', to: 'planner',
    body: { kind: 'worker-exit', inReplyTo: 'msg-public-1', exitCode: 0, succeeded: true } });
}, 30000);
