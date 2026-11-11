import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CONTEXT_END, CONTEXT_START } from '../src/core/fleet/context-worker-run.js';
import { runHandoffWorker } from '../src/core/fleet/handoff-worker-run.js';

let root: string;
let file: string;
let capture: string;
let calls: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-upstream-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.stubEnv('TMPDIR', join(root, 'tmp'));
  await mkdir(join(root, '.ashlr-runs'));
  await mkdir(join(root, 'tmp'));
  file = join(root, 'handoff.json');
  capture = join(root, 'capture.json');
  calls = join(root, 'calls');
  await writeFile(file, JSON.stringify({ id: 'WORK-1', task: 'Implement the selected routing fix',
    files: [{ path: 'routing.ts' }], constraints: [], check: 'Run the focused test' }));
  await writeFile(join(root, '.ashlr-runs', 'UPSTREAM-1.notes.md'),
    'Prior finding: keep the routing order stable.\n' + 'padding '.repeat(300));
  await writeFile(join(root, '.ashlr-runs', 'UNRELATED-1.notes.md'), 'Unrelated private fixture marker.\n');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('delivers only selected retained context to one caller-selected child and returns its exit status', async () => {
  const script = `const fs = require('node:fs');
fs.appendFileSync(process.argv[2], 'run\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(process.argv[1], JSON.stringify({ input, argv: process.argv.slice(1) }));
  process.exit(7);
});`;
  const args = [capture, calls, 'literal space', '$(fake command)'];
  const budget = 700;
  const code = await runHandoffWorker({ file, upstreamJobIds: ['UPSTREAM-1'], byteBudget: budget,
    argv: [process.execPath, '-e', script, ...args] });
  expect(code).toBe(7);
  expect(await readFile(calls, 'utf8')).toBe('run\n');
  const result = JSON.parse(await readFile(capture, 'utf8')) as { input: string; argv: string[] };
  expect(result.argv).toEqual(args);
  expect(result.input).toContain('Implement the selected routing fix');
  expect(result.input).not.toContain('Unrelated private fixture marker');
  expect(result.input).not.toContain('UNRELATED-1');
  const start = result.input.indexOf(CONTEXT_START);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(result.input.endsWith(CONTEXT_END)).toBe(true);
  const pack = result.input.slice(start + CONTEXT_START.length, -CONTEXT_END.length);
  expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(budget);
  const rows = pack.trim().split('\n').map(line => JSON.parse(line) as
    { jobId: string; kind: string; text: string; truncated: boolean });
  expect(rows).toContainEqual(expect.objectContaining({ jobId: 'UPSTREAM-1', kind: 'output',
    text: expect.stringContaining('Prior finding: keep the routing order stable.'), truncated: true }));
});
