import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHandoffRun } from '../src/cli/fleet-handoff-run.js';
import {
  HANDOFF_RUN_MAX_BYTE_BUDGET,
  HANDOFF_RUN_MAX_TIMEOUT_MS,
  HANDOFF_RUN_MAX_UPSTREAM,
  runHandoffWorker,
} from '../src/core/fleet/handoff-worker-run.js';

vi.mock('../src/core/fleet/handoff-worker-run.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/handoff-worker-run.js')>(),
  runHandoffWorker: vi.fn(),
}));

const worker = vi.mocked(runHandoffWorker);
const file = join(tmpdir(), 'fake handoff.json');
const cwd = join(tmpdir(), 'fake worker directory');
const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
const io = { stdout: sink(), stderr: sink() };
const base = ['--file', file];
const command = ['--', 'fake-program'];

beforeEach(() => {
  worker.mockReset();
  worker.mockResolvedValue(0);
});

describe('handoff-run command argv contract', () => {
  it('forwards validated options and preserves child arguments verbatim', async () => {
    const argv = ['fake program', 'two words', '雪 ☃', '--file', '--', '--timeout-ms', '0'];
    const status = await cmdFleetHandoffRun([
      ...base, '--upstream', 'JOB-1', '--upstream', 'JOB-2', '--upstream', 'JOB-1',
      '--bus-address', 'WORKER-1', '--bus-after', String(Number.MAX_SAFE_INTEGER),
      '--byte-budget', String(HANDOFF_RUN_MAX_BYTE_BUDGET), '--cwd', cwd,
      '--timeout-ms', String(HANDOFF_RUN_MAX_TIMEOUT_MS), '--', ...argv,
    ], io);
    expect(status).toBe(0);
    expect(worker).toHaveBeenCalledExactlyOnceWith({
      file, upstreamJobIds: ['JOB-1', 'JOB-2'], busAddress: 'WORKER-1',
      busAfter: Number.MAX_SAFE_INTEGER, byteBudget: HANDOFF_RUN_MAX_BYTE_BUDGET,
      cwd, timeoutMs: HANDOFF_RUN_MAX_TIMEOUT_MS, argv,
    }, io);
  });

  it('accepts the maximum number of distinct upstream IDs', async () => {
    const ids = Array.from({ length: HANDOFF_RUN_MAX_UPSTREAM }, (_, i) => `JOB-${i}`);
    expect(await cmdFleetHandoffRun([...base, ...ids.flatMap(id => ['--upstream', id]), ...command], io)).toBe(0);
    expect(worker.mock.calls[0]?.[0].upstreamJobIds).toEqual(ids);
  });

  const singletonValues: [string, string][] = [
    ['--file', file], ['--bus-address', 'WORKER-1'], ['--bus-after', '1'],
    ['--byte-budget', '1'], ['--cwd', cwd], ['--timeout-ms', '1'],
  ];
  it.each(singletonValues)('rejects duplicate singleton %s', async (flag, value) => {
    const prefix = flag === '--file' ? [] : base;
    expect(await cmdFleetHandoffRun([...prefix, flag, value, flag, value, ...command], io)).toBe(2);
    expect(worker).not.toHaveBeenCalled();
  });

  const invalid: [string, string[]][] = [
    ['missing separator', [...base, 'fake-program']],
    ['missing program', [...base, '--']],
    ['missing file', command],
    ['missing option value', [...base, '--timeout-ms', ...command]],
    ['relative file', ['--file', 'handoff.json', ...command]],
    ['relative cwd', [...base, '--cwd', 'relative', ...command]],
    ['invalid upstream ID', [...base, '--upstream', 'bad id', ...command]],
    ['unsafe cursor', [...base, '--bus-address', 'WORKER-1', '--bus-after', String(Number.MAX_SAFE_INTEGER + 1), ...command]],
    ['cursor without address', [...base, '--bus-after', '1', ...command]],
    ['unsafe timeout', [...base, '--timeout-ms', String(Number.MAX_SAFE_INTEGER + 1), ...command]],
    ['timeout over maximum', [...base, '--timeout-ms', String(HANDOFF_RUN_MAX_TIMEOUT_MS + 1), ...command]],
    ['zero timeout', [...base, '--timeout-ms', '0', ...command]],
    ['budget over maximum', [...base, '--byte-budget', String(HANDOFF_RUN_MAX_BYTE_BUDGET + 1), ...command]],
    ['zero budget', [...base, '--byte-budget', '0', ...command]],
    ['upstream overflow', [...base, ...Array.from({ length: HANDOFF_RUN_MAX_UPSTREAM + 1 }, (_, i) => ['--upstream', `JOB-${i}`]).flat(), ...command]],
  ];
  it.each(invalid)('rejects %s before invoking the worker', async (_name, args) => {
    expect(await cmdFleetHandoffRun(args, io)).toBe(2);
    expect(worker).not.toHaveBeenCalled();
  });

  it('prints help without invoking the worker', async () => {
    expect(await cmdFleetHandoffRun(['--help'], io)).toBe(0);
    expect(worker).not.toHaveBeenCalled();
  });

  it('returns the worker failure status unchanged', async () => {
    worker.mockResolvedValue(17);
    expect(await cmdFleetHandoffRun([...base, ...command], io)).toBe(17);
    expect(worker).toHaveBeenCalledOnce();
  });
});
