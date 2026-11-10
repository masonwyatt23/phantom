import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHandoffPipe } from '../src/cli/fleet-handoff-pipe.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'handoff-shape-')); });
const args = ['--stdin', '--id', 'fixture-1', '--from', 'planner', '--to', 'worker', '--apply'];
const events = ['data', 'end', 'error', 'close'] as const;
const signals = ['SIGINT', 'SIGTERM'] as const;
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it.each([
  [{ privatePayload: 'do-not-print-this' }, true],
  [{ privatePayload: 'do-not-print-this' }, false],
  [42, true],
  [42, false],
])('rejects unsupported chunk %# without leaking, writing, or retaining listeners', async (chunk, json) => {
  const root = join(dir, 'bus');
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation((value: unknown) => { output.push(String(value)); });
  const input = new Readable({ objectMode: true, read() {} });
  const baseline = events.map(event => input.listenerCount(event));
  const signalBaseline = signals.map(signal => process.listenerCount(signal));
  const pending = cmdFleetHandoffPipe([...args, ...(json ? ['--json'] : [])], { stdin: input, root, tempRoot: dir });
  input.push(chunk);
  expect(await pending).toBe(1);
  expect(output.join()).toContain('unsupported input chunk');
  expect(output.join()).not.toContain('do-not-print-this');
  expect(input.destroyed).toBe(false);
  expect(events.map(event => input.listenerCount(event))).toEqual(baseline);
  expect(signals.map(signal => process.listenerCount(signal))).toEqual(signalBaseline);
  expect(existsSync(root)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
  input.destroy();
});

it('sends supported string and Buffer chunks to an isolated bus', async () => {
  const root = join(dir, 'bus');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const content = JSON.stringify({ id: 'task-1', task: 'Inspect fixture', files: [{ path: 'src/fixture.ts', lines: { from: 1, to: 3 } }], constraints: [{ rule: 'Keep interface', reason: 'Used by callers' }], check: 'Verify fixture' });
  const input = Readable.from([content.slice(0, 20), Buffer.from(content.slice(20))]);
  expect(await cmdFleetHandoffPipe([...args, '--json'], { stdin: input, root, tempRoot: dir })).toBe(0);
  const result = listBusInboxAfter(0, 50, { root });
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('inbox unavailable');
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]!.envelope.id).toBe('fixture-1');
  expect(readdirSync(dir).filter(name => name.startsWith('ashlr-handoff-pipe-'))).toEqual([]);
});
