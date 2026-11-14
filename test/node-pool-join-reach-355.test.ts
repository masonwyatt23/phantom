import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ read: vi.fn(), configure: vi.fn(), call: vi.fn(), capacity: vi.fn() }));
vi.mock('../src/core/drive/nodes/pool-host.js', () => ({ readPoolConfig: deps.read, configurePool: deps.configure, callPool: deps.call }));
vi.mock('../src/core/drive/nodes/worker.js', () => ({ probeNodeLanes: () => ['codex'] }));
vi.mock('../src/core/drive/nodes/capacity.js', () => ({ readNodeCapacity: deps.capacity }));
import { ashlrHome } from '../src/core/cloud/store.js';
import { cmdNodePool } from '../src/cli/node-pool.js';
import type { PoolReach } from '../src/core/fleet/pool-reach.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const SAVED: PoolConfig = { role: 'worker', node: 'air', owner: 'mason', primary: 'mac-a', backup: 'mac-b' };
const OFFLINE_BACKUP: PoolReach = {
  asOf: '2026-11-14T12:00:00.000Z', self: 'mac-self', role: 'worker',
  hosts: [
    { slot: 'primary', alias: 'mac-a', matched: 'mac-a', online: true, lastSeen: '2026-11-14T11:59:00.000Z', ageSeconds: 60, isSelf: false },
    { slot: 'backup', alias: 'mac-b', matched: 'mac-b', online: false, lastSeen: '2026-11-14T11:58:40.000Z', ageSeconds: 80, isSelf: false },
  ],
  reasons: [],
};

function capture() {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  return out;
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.read.mockReturnValue(null);
  deps.capacity.mockReturnValue({ slots: 2, held: null });
  deps.call.mockImplementation(() => { throw new Error('ssh unavailable'); });
});

describe('failed node join reach evidence', () => {
  it('prints reach and a hint naming the offline backup on a first join', async () => {
    const out = capture();
    const readReach = vi.fn(() => OFFLINE_BACKUP);
    const code = await cmdNodePool('join', ['--primary', 'mac-a', '--backup', 'mac-b', '--owner', 'mason', '--json'], { readReach });
    expect(code).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.registered).toBe(false);
    expect(printed.approvalSteps).toHaveLength(2);
    expect(printed.reach).toEqual(OFFLINE_BACKUP);
    expect(printed.hint).toBe('backup mac-b is offline on the tailnet (last seen 2026-11-14T11:58:40.000Z); start it or check tailscale before retrying');
    // The in-memory config the operator typed is what the reach read sees.
    expect(readReach).toHaveBeenCalledWith(expect.objectContaining({ role: 'worker', primary: 'mac-a', backup: 'mac-b', owner: 'mason' }));
    expect(deps.configure).not.toHaveBeenCalled();
    expect(out.join('\n')).not.toMatch(/100\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it('names the saved pool hosts on a repeat join refusal', async () => {
    const out = capture();
    deps.read.mockReturnValue(SAVED);
    const readReach = vi.fn(() => OFFLINE_BACKUP);
    expect(await cmdNodePool('join', ['--json'], { readReach })).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.registered).toBe(false);
    expect(printed.hint).toContain('backup mac-b is offline on the tailnet');
    expect(readReach).toHaveBeenCalledWith(SAVED);
  });

  it('still exits 1 with a fixed hint when the reach reader itself throws', async () => {
    const out = capture();
    const readReach = vi.fn(() => { throw new Error('reader exploded'); });
    expect(await cmdNodePool('join', ['--primary', 'mac-a', '--backup', 'mac-b', '--owner', 'mason', '--json'], { readReach })).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.registered).toBe(false);
    expect(printed.reach).toBeNull();
    expect(printed.hint).toBe('tailnet reach unknown (reader failed)');
  });
});

describe('catch-all reach evidence', () => {
  it('never adds reach or hint to a flag-parse error, even when a pool config exists', async () => {
    const out = capture();
    mkdirSync(join(ashlrHome(), 'node-pool'), { recursive: true });
    writeFileSync(join(ashlrHome(), 'node-pool', 'config.json'), JSON.stringify(SAVED));
    const readReach = vi.fn(() => OFFLINE_BACKUP);
    expect(await cmdNodePool('join', ['--primary', 'mac-a', '--backup', 'mac-b', '--bogus', '--json'], { readReach })).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.error).toContain('Node pool operation refused or unavailable');
    expect(printed).not.toHaveProperty('reach');
    expect(printed).not.toHaveProperty('hint');
    expect(readReach).not.toHaveBeenCalled();
  });

  it('adds reach when the parsed config fails a later check', async () => {
    const out = capture();
    deps.read.mockReturnValue(SAVED);
    const readReach = vi.fn(() => OFFLINE_BACKUP);
    // --owner other mismatches the saved identity: parsed config exists, join is refused.
    expect(await cmdNodePool('join', ['--owner', 'other', '--json'], { readReach })).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.reach).toEqual(OFFLINE_BACKUP);
    expect(printed.hint).toContain('backup mac-b is offline on the tailnet');
    expect(readReach).toHaveBeenCalledWith(SAVED);
  });

  it('adds reach when a saved config exists but cannot be parsed', async () => {
    const out = capture();
    mkdirSync(join(ashlrHome(), 'node-pool'), { recursive: true });
    writeFileSync(join(ashlrHome(), 'node-pool', 'config.json'), 'not json');
    deps.read.mockImplementation(() => { throw new Error('Invalid node pool config'); });
    const readReach = vi.fn(() => OFFLINE_BACKUP);
    expect(await cmdNodePool('join', ['--json'], { readReach })).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.reach).toEqual(OFFLINE_BACKUP);
    expect(printed.hint).toContain('backup mac-b is offline on the tailnet');
    expect(readReach.mock.calls[0]![0]).toBeUndefined();
  });

  it('adds reach to a refused pool verb on a configured Mac', async () => {
    const out = capture();
    deps.read.mockReturnValue(SAVED);
    const readReach = vi.fn(() => OFFLINE_BACKUP);
    expect(await cmdNodePool('beat', ['--json'], { readReach })).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.error).toContain('Node pool operation refused or unavailable');
    expect(printed.reach).toEqual(OFFLINE_BACKUP);
    expect(printed.hint).toContain('backup mac-b is offline on the tailnet');
  });

  it('omits reach when no config exists and none was parsed', async () => {
    const out = capture();
    // Earlier cases write config.json into this worker's shared temp home.
    rmSync(join(ashlrHome(), 'node-pool'), { recursive: true, force: true });
    const readReach = vi.fn(() => OFFLINE_BACKUP);
    expect(await cmdNodePool('rpc', ['--json'], { readReach })).toBe(1);
    const printed = JSON.parse(out.join('\n'));
    expect(printed).not.toHaveProperty('reach');
    expect(printed).not.toHaveProperty('hint');
    expect(readReach).not.toHaveBeenCalled();
  });
});
