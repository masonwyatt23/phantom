import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';
import type { TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';

const fake = vi.hoisted(() => ({ readConfig: vi.fn() }));
vi.mock('../src/core/drive/nodes/pool-host.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/drive/nodes/pool-host.js')>(),
  readPoolConfig: fake.readConfig,
}));
vi.mock('../src/core/fleet/tailnet-peers.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/tailnet-peers.js')>(),
  defaultTailnetPeersDeps: () => peers,
}));

import { readPoolReach } from '../src/core/fleet/pool-reach.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const config: PoolConfig = { role: 'worker', primary: 'primary', backup: 'backup', owner: 'owner', node: 'node' };
const peers: TailnetPeersDeps = {
  now: () => new Date('2026-11-14T12:00:00Z'),
  homeDir: () => '/home/fake-private-home',
  exec: () => JSON.stringify({ BackendState: 'Running', Self: { HostName: 'self' }, Peer: {
    a: { HostName: 'primary', Online: true }, b: { HostName: 'backup', Online: true },
  } }),
};
const diagnostic = 'FAKE_PRIVATE_DIAGNOSTIC /home/fake-private-home/config';

function assertRefusal(value: unknown) {
  expect(value).toMatchObject({ role: 'unknown', hosts: [], reasons: ['pool config: pool config unreadable'] });
  expect(JSON.stringify(value)).not.toContain('FAKE_PRIVATE_DIAGNOSTIC');
  expect(JSON.stringify(value)).not.toContain('/home/fake-private-home');
}

describe('original pool config refusal through MCP', () => {
  it('refuses Error and non-Error diagnostics and recovers fresh host evidence', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createFleetServer();
    const client = new Client({ name: 'test', version: '1' });
    await server.connect(st);
    await client.connect(ct);
    try {
      for (const failure of [new Error(diagnostic), diagnostic]) {
        fake.readConfig.mockImplementation(() => { throw failure; });
        assertRefusal(readPoolReach({ readConfig: fake.readConfig, peers }));
        const response = await client.callTool({ name: 'fleet_pool_reach', arguments: {} });
        expect(response.isError).toBeFalsy();
        expect(JSON.stringify(response)).not.toContain('FAKE_PRIVATE_DIAGNOSTIC');
        expect(JSON.stringify(response)).not.toContain('/home/fake-private-home');
        assertRefusal(JSON.parse((response.content as Array<{ text: string }>)[0]!.text));
      }
      fake.readConfig.mockReturnValue(config);
      const response = await client.callTool({ name: 'fleet_pool_reach', arguments: {} });
      const result = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
      expect(result).toMatchObject({ role: 'worker', reasons: [], hosts: [
        { alias: 'primary', matched: 'primary', online: true },
        { alias: 'backup', matched: 'backup', online: true },
      ] });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
