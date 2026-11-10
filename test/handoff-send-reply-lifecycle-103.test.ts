import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReply } from '../src/cli/fleet-handoff-reply.js';
import { cmdFleetHandoffSend } from '../src/cli/fleet-handoff-send.js';
import { listBusInboxAfter, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import { CONTEXT_END, CONTEXT_START } from '../src/core/fleet/context-worker-run.js';
import { HANDOFF_RECEIVE_BEGIN, HANDOFF_RECEIVE_END } from '../src/core/fleet/handoff-bus-receive.js';
import { isFleetJobId } from '../src/core/fleet/runs-job-detail.js';
import type { WorkerHandoff } from '../src/core/verse/handoff.js';

let root: string, tmp: string, busRoot: string, spoolDir: string;
let handoffFile: string, snapshot: string, runsFile: string, captureFile: string;
let out: string, err: string, logs: string[];

const TASK = 'WORK-LIFECYCLE-103';
const MESSAGE_ID = 'handoff-msg-103';
const REPLY_ID = 'handoff-msg-103-exit';
const TASK_MARKER = 'synthetic lifecycle task marker-a2a103';
const CONTEXT_MARKER = 'snapshot retained context marker-ctx103';
const STDOUT_MARKER = 'child-stdout-marker-103';
const SEND_TTL_MS = 86_400_000; // stamped by handoff-send itself

const handoff: WorkerHandoff = {
  id: TASK,
  task: TASK_MARKER,
  files: [{ path: 'src/core/fleet/bus-inbox.ts', why: 'durable bus under test' }],
  constraints: [{ rule: 'reply through the public bus only', reason: 'the joined path is the contract' }],
  check: 'the worker-exit reply reaches the original sender',
};
const pack = {
  node: { jobId: TASK, upstreamJobIds: [] },
  tasks: [{ jobId: TASK, text: CONTEXT_MARKER }],
  outputs: [],
  byteBudget: 8192,
};
const sink = (write: (s: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const bus = (): BusInboxOptions => ({ root: busRoot });
const send = () => cmdFleetHandoffSend(
  ['--file', handoffFile, '--id', MESSAGE_ID, '--from', 'planner', '--to', 'worker', '--apply', '--json'],
  bus());
// Built lazily: runsFile/captureFile are assigned in beforeEach.
const childScript = () =>
  `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(runsFile)},'x');` +
  `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{` +
  `fs.writeFileSync(${JSON.stringify(captureFile)},s);` +
  `process.stdout.write(${JSON.stringify(STDOUT_MARKER)});});`;
const reply = () => cmdFleetHandoffReply(
  ['--id', MESSAGE_ID, '--to', 'worker', '--snapshot', snapshot, '--reply-id', REPLY_ID,
    '--spool-dir', spoolDir, '--timeout-ms', '30000', '--', process.execPath, '-e', childScript()],
  bus(), io());

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'handoff-lifecycle-103-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  tmp = join(root, 'tmp');
  vi.stubEnv('TMPDIR', tmp);
  mkdirSync(join(root, '.ashlr-runs'), { mode: 0o700 });
  mkdirSync(tmp, { mode: 0o700 });
  busRoot = join(root, 'bus');
  spoolDir = join(root, 'spool');
  handoffFile = join(root, 'handoff.json');
  snapshot = join(root, 'snapshot.json');
  runsFile = join(root, 'child-runs');
  captureFile = join(root, 'child-stdin');
  out = ''; err = ''; logs = [];
  writeFileSync(handoffFile, JSON.stringify(handoff), { mode: 0o600 });
  writeFileSync(snapshot, JSON.stringify(pack), { mode: 0o600 });
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { logs.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('joins public send, one worker run and a durable reply back to the sender', async () => {
  expect(isFleetJobId(TASK)).toBe(true);

  // Public send --apply posts exactly one worker-handoff request.
  expect(await send()).toBe(0);
  expect(JSON.parse(logs.at(-1)!)).toMatchObject({ v: 1, status: 'posted', id: MESSAGE_ID, cursor: 1 });

  // Send replay is deduped against the durable store: no second request row.
  expect(await send()).toBe(0);
  expect(JSON.parse(logs.at(-1)!)).toMatchObject({ v: 1, status: 'duplicate', id: MESSAGE_ID, cursor: 1 });
  const firstPage = listBusInboxAfter(0, 50, bus());
  if (firstPage.status !== 'ok') throw new Error(`inbox unavailable: ${firstPage.status}`);
  expect(firstPage.messages.filter(m => m.envelope.id === MESSAGE_ID)).toHaveLength(1);

  // Public reply launches the explicit argv once and publishes the worker-exit reply.
  expect(await reply()).toBe(0);
  expect(err).toContain('"workerExit":{"status":"returned","exitCode":0}');
  expect(err).toContain('"delivery":{"status":"posted"}');
  expect(readFileSync(runsFile, 'utf8')).toBe('x');

  // The child received the handoff task and the retained snapshot context, both
  // inside the untrusted stdin sections and never on argv.
  const stdin = readFileSync(captureFile, 'utf8');
  expect(stdin.startsWith(HANDOFF_RECEIVE_BEGIN)).toBe(true);
  expect(stdin).toContain(TASK_MARKER);
  expect(stdin).toContain(HANDOFF_RECEIVE_END);
  expect(stdin).toContain('BEGIN UNTRUSTED BUS REQUEST JSON');
  expect(stdin).toContain(CONTEXT_START);
  expect(stdin).toContain(CONTEXT_MARKER);
  expect(stdin.endsWith(CONTEXT_END)).toBe(true);

  // Child stdout reached only the runner's stdout sink; receipts, diagnostics
  // and the published reply carry no task text or child output.
  expect(out).toContain(STDOUT_MARKER);
  expect(logs.join('\n') + err).not.toContain(TASK_MARKER);
  expect(logs.join('\n') + err).not.toContain(CONTEXT_MARKER);
  expect(logs.join('\n') + err).not.toContain(STDOUT_MARKER);

  // A fresh reader context on the same storage still finds the reply: the
  // answer is durable, not process-local state.
  vi.resetModules();
  const fresh = await import('../src/core/fleet/bus-inbox.js');
  const page = fresh.listBusInboxAfter(0, 50, bus());
  if (page.status !== 'ok') throw new Error(`fresh reader unavailable: ${page.status}`);
  expect(page.messages).toHaveLength(2);
  expect(page.messages.filter(m => m.envelope.id === MESSAGE_ID)).toHaveLength(1);
  const replies = page.messages.filter(m => m.envelope.id === REPLY_ID);
  expect(replies).toHaveLength(1);
  const replyEnvelope = replies[0]!.envelope;
  // Provenance: routed request.to -> request.from on the request's priority,
  // correlated by inReplyTo, with remaining TTL bounded by the send's stamp.
  expect([replyEnvelope.from, replyEnvelope.to]).toEqual(['worker', 'planner']);
  expect(replyEnvelope.priority).toBe('P3');
  expect(replyEnvelope.ttl).toBeGreaterThan(0);
  expect(replyEnvelope.ttl).toBeLessThanOrEqual(SEND_TTL_MS);
  expect(replyEnvelope.body).toEqual({
    inReplyTo: MESSAGE_ID, kind: 'worker-exit', exitCode: 0, succeeded: true,
  });
  expect(JSON.stringify(replyEnvelope)).not.toContain(TASK_MARKER);
  expect(JSON.stringify(replyEnvelope)).not.toContain(STDOUT_MARKER);

  // No staged request/prompt workspace or spooled record survives the run.
  expect(readdirSync(tmp)).toEqual([]);
  expect(existsSync(spoolDir)).toBe(true);
  expect(readdirSync(spoolDir).filter(n => /^reply-[0-9a-f]{32}\.json$/.test(n))).toEqual([]);
}, 30000);
