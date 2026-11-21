import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetPoolReadings } from '../src/cli/fleet-pool-readings.js';
import { showPoolReadings } from '../src/core/usage/pool-reading.js';

const now = 1_800_000_000;
let root = '';
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('measured pool readings', () => {
  it('reports historical measurements and refuses invalid files without modifying them', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    root = await mkdtemp(join(tmpdir(), 'pool-readings-'));
    const queue = join(root, 'queue'); await mkdir(queue);
    const records: Record<string, string> = {
      zero: JSON.stringify({ pct: 0, ts: now - 5, reset_at: now + 100, src: 'fixture zero' }),
      old: JSON.stringify({ pct: 42, ts: now - 28800, reset_at: now + 100, src: 'fixture old' }),
      expired: JSON.stringify({ pct: 7, ts: now - 60, reset_at: now - 1, src: 'fixture expired' }),
      malformed: '{', range: JSON.stringify({ pct: 101, ts: now, reset_at: now + 1, src: 'fixture' }),
      future: JSON.stringify({ pct: 3, ts: now + 1, reset_at: now + 2, src: 'fixture' }),
      large: 'x'.repeat(4096), extra: JSON.stringify({ pct: 0, ts: now, reset_at: now + 1, src: 'fixture', extra: true }),
    };
    for (const [name, contents] of Object.entries(records)) await writeFile(join(queue, `${name}-reading.json`), contents);
    await mkdir(join(queue, 'directory-reading.json'));
    let symlinkCreated = false;
    try { await symlink(join(queue, 'zero-reading.json'), join(queue, 'link-reading.json')); symlinkCreated = true; }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    const result = await showPoolReadings(undefined, root);
    const byName = Object.fromEntries(result.readings.map(view => [view.pool, view]));
    expect(byName.zero).toMatchObject({ reading: { pct: 0, reset_at: now + 100, src: 'fixture zero' }, stale: false });
    expect(byName.old).toMatchObject({ reading: { pct: 42 }, stale: true });
    expect(byName.expired).toMatchObject({ reading: { pct: 7, reset_at: now - 1, src: 'fixture expired' }, stale: true });
    for (const name of ['malformed', 'range', 'future', 'large', 'extra', 'directory', ...(symlinkCreated ? ['link'] : [])]) {
      expect(byName[name]).toMatchObject({ reading: null, stale: true, error: 'Reading missing or invalid' });
    }
    expect((await showPoolReadings('absent', root)).readings[0]).toMatchObject({ pool: 'absent', reading: null, stale: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reader = (pool?: string) => showPoolReadings(pool, root);
    expect(await cmdFleetPoolReadings(['expired', '--json'], reader)).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).readings[0]).toMatchObject(byName.expired);
    expect(await cmdFleetPoolReadings(['expired'], reader)).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(`reset ${now - 1}`);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('stale');
    for (const [name, contents] of Object.entries(records)) expect(await readFile(join(queue, `${name}-reading.json`), 'utf8')).toBe(contents);
  });

  it('rejects invalid arguments without reading', async () => {
    const reader = vi.fn(); vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--bad'], ['Bad'], ['a', 'b'], ['--json', '--json']]) expect(await cmdFleetPoolReadings(args, reader)).toBe(2);
    expect(reader).not.toHaveBeenCalled();
  });
});
