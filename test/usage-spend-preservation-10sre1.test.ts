import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { projectUsageSpend, readUsageSpend } from '../src/core/usage/spend.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import * as command from '../src/cli/fleet-usage-spend.js';

const now = Date.parse('2026-11-09T16:00:00Z');
const raw = (tick: string, reading: unknown) => ({ schema: 'dispatchd.status.v1', last_tick: tick, budget: { custom: { use_it_all: reading } } });
const reading = { known: true, stale: false, used_pct: 20, reset_at: '2026-11-10T02:00:00Z', burn_pct_per_hour: 0 };

describe('spend preservation', () => {
  it('accepts zero burn and fails closed on future ticks, bad values and passed resets', () => {
    const row = (value: unknown) => projectUsageSpend(value, now).pools.find(r => r.pool === 'custom')!;
    expect(row(raw(new Date(now).toISOString(), reading)).projectedUnusedPercent).toBe(80);
    expect(row(raw(new Date(now + 1).toISOString(), reading)).reason).toBe('status missing or stale');
    for (const change of [{ reset_at: new Date(now).toISOString() }, { used_pct: 101 }, { burn_pct_per_hour: -1 }, { burn_pct_per_hour: NaN }, { known: false }]) {
      const result = row(raw(new Date(now).toISOString(), { ...reading, ...change }));
      expect(result.reason).not.toBeNull();
      expect(result.usedPercent).toBeNull();
    }
  });
  it('reads a real fixture and safely handles malformed, oversized and unreadable files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-spend-'));
    const path = join(dir, 'status.json');
    try {
      await writeFile(path, JSON.stringify(raw(new Date().toISOString(), { ...reading, reset_at: new Date(Date.now() + 3600000).toISOString() })));
      expect((await readUsageSpend(path)).pools.find(r => r.pool === 'custom')?.burnPerHour).toBe(0);
      for (const content of ['private malformed marker', 'private oversized marker'.repeat(60000)]) {
        await writeFile(path, content);
        const result = await readUsageSpend(path);
        expect(JSON.stringify(result)).not.toContain('private');
        expect(result.pools.every(r => r.usedPercent === null)).toBe(true);
      }
      expect((await readUsageSpend(dir)).pools.every(r => r.usedPercent === null)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reads a fake status through the CLI JSON command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-spend-cli-'));
    const previous = process.env.HOME;
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.env.HOME = dir;
      const queue = join(dir, '.ashlr-runs', 'queue');
      await mkdir(queue, { recursive: true });
      await writeFile(join(queue, 'status.json'), JSON.stringify(raw(new Date().toISOString(), { ...reading, reset_at: new Date(Date.now() + 3600000).toISOString() })));
      expect(await command.cmdFleetUsageSpend(['--json'])).toBe(0);
      const snapshot = JSON.parse(String(output.mock.calls[0]?.[0])) as { pools: { pool: string; burnPerHour: number | null }[] };
      expect(snapshot.pools.find(r => r.pool === 'custom')?.burnPerHour).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      output.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('exports the convention name and rejects extra arguments', async () => {
    expect(resolveFleetSubcommand('usage-spend')).toEqual({ module: './fleet-usage-spend.js', exportName: 'cmdFleetUsageSpend' });
    expect(typeof command.cmdFleetUsageSpend).toBe('function');
    expect(await command.cmdFleetUsageSpend(['--bad'])).toBe(2);
  });
});
