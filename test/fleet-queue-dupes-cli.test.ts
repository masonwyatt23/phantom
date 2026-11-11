import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetQueueDupes } from '../src/cli/fleet-queue-dupes.js';
import { findQueueDupes } from '../src/core/fleet/queue-dupes.js';

it('prints the module result as JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'queue-dupes-'));
  const old = process.env.ASHLR_RUNS_DIR;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-04T00:00:00Z'));
  try {
    process.env.ASHLR_RUNS_DIR = dir;
    await mkdir(join(dir, 'queue'));
    const text = 'id\tpool\trepo\ttitle\tat\nA\twork\tphantom\tFix queue\t2026-01-01T00:00:00Z';
    await writeFile(join(dir, 'queue', 'ready.tsv'), text);
    expect(await cmdFleetQueueDupes(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(findQueueDupes(text, Date.now()));
  } finally {
    if (old === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = old;
    vi.useRealTimers(); log.mockRestore(); await rm(dir, { recursive: true, force: true });
  }
});
