import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import type { PoolReach, PoolReachDeps } from '../src/core/fleet/pool-reach.js';

// Preserve the real join/parser; replace only the default dependency factory.
const seam = vi.hoisted(() => ({ factory: vi.fn<() => PoolReachDeps>() }));
vi.mock('../src/core/fleet/pool-reach.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/pool-reach.js')>(),
  defaultPoolReachDeps: seam.factory,
}));
import { createFleetServer } from '../src/mcp/fleet-server.js';

it('stamps config failure and retargeted recovery with fresh default-reader evidence', async () => {
  // Complements pool-config-original-mcp-793s: its failure uses the initial
  // clock and its recovery does not assert LastSeen/ageSeconds.
  const times = ['2026-11-22T12:00:00.000Z', '2026-11-22T12:01:00.000Z', '2026-11-22T12:02:00.000Z'];
  const lastSeen = '2026-11-22T12:01:30.000Z';
  const diagnostic = 'SYNTHETIC_PRIVATE_827S /home/synthetic-private/config.json';
  let phase = 0;
  const readConfig = vi.fn(() => {
    if (phase === 1) throw new Error(diagnostic);
    return { role: 'worker' as const, primary: phase === 0 ? 'old-primary' : 'new-primary',
      backup: 'backup', owner: 'synthetic-owner', node: 'synthetic-node' };
  });
  const exec = vi.fn(() => JSON.stringify({ BackendState: 'Running', Self: { HostName: 'self' }, Peer: {
    a: { HostName: phase === 0 ? 'old-primary' : 'new-primary', Online: phase !== 2,
      LastSeen: phase === 2 ? lastSeen : times[0] },
    b: { HostName: 'backup', Online: true, LastSeen: times[0] },
  } }));
  seam.factory.mockReturnValue({ readConfig, peers: {
    now: () => new Date(times[phase]!), homeDir: () => '/home/synthetic-private', exec,
  } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(); // No readers.poolReach injection.
  const client = new Client({ name: 'default-pool-827s', version: '1' });
  try {
    await server.connect(st);
    await client.connect(ct);
    const call = async () => {
      const response = await client.callTool({ name: 'fleet_pool_reach', arguments: {} });
      expect(response.isError).toBeFalsy();
      const wire = JSON.stringify(response);
      for (const forbidden of ['SYNTHETIC_PRIVATE_827S', '/home/synthetic-private', 'synthetic-owner', 'synthetic-node']) {
        expect(wire).not.toContain(forbidden);
      }
      return JSON.parse((response.content as Array<{ text: string }>)[0]!.text) as PoolReach;
    };
    const healthy = await call();
    expect(healthy).toMatchObject({ asOf: times[0], reasons: [], hosts: [{ alias: 'old-primary', online: true }, { online: true }] });
    phase = 1;
    const failed = await call();
    expect(failed).toEqual({ asOf: times[1], self: 'self', role: 'unknown', hosts: [],
      reasons: ['pool config: pool config unreadable'] });
    expect(JSON.stringify(failed)).not.toContain(times[0]);
    expect(JSON.stringify(failed)).not.toContain('old-primary');
    phase = 2;
    const recovered = await call();
    expect(recovered).toEqual({ asOf: times[2], self: 'self', role: 'worker', reasons: [], hosts: [
      { slot: 'primary', alias: 'new-primary', matched: 'new-primary', online: false, lastSeen, ageSeconds: 30, isSelf: false },
      { slot: 'backup', alias: 'backup', matched: 'backup', online: true, lastSeen: times[0], ageSeconds: 120, isSelf: false },
    ] });
    expect(seam.factory).toHaveBeenCalledTimes(3);
    expect(readConfig).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls).toEqual(Array.from({ length: 3 }, () => ['tailscale', ['status', '--json']]));
  } finally {
    await client.close();
    await server.close();
  }
});
