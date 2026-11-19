/**
 * RQ-PHX-POOLCONFIGBOUNDARY614S: the shared readPoolReach reader is the config
 * exception boundary for fleet_pool_reach. Over ONE retained MCP connection:
 * valid config, an Error and a non-Error config throw carrying private markers,
 * then a changed config at a later clock. Serialized output must omit thrown
 * text, show unknown role and no hosts on failure, and recover fresh hosts and
 * time. Hermetic: only config, clock and tailscale exec seams; reachability
 * evidence only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { readPoolReach, type PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const NAME = 'fleet_pool_reach';
const HOME = '/Users/fakehome';
const MARKER = 'PRIVATE-MARKER-614s-FAKE';
const FAKE_PATH = `${HOME}/.ashlr/node-pool/fake-config.json`;
const T1 = '2026-11-18T19:00:00.000Z';
const T2 = '2026-11-18T19:01:00.000Z';
const T3 = '2026-11-18T19:02:00.000Z';
const T4 = '2026-11-18T19:03:00.000Z';
const FAILED: string[] = ['pool config: pool config unreadable'];

const CONFIG_A: PoolConfig = { role: 'worker', primary: 'mac-primary', backup: 'mac-backup', owner: 'fake-owner', node: 'fake-node' };
const CONFIG_B: PoolConfig = { role: 'backup', primary: 'mac-gamma', backup: 'mac-backup', owner: 'fake-owner', node: 'fake-node' };

function status(peers: Array<[string, boolean, string]>): string {
  const peerMap: Record<string, unknown> = {};
  for (const [name, online, lastSeen] of peers) {
    peerMap[`key-${name}`] = { HostName: name, OS: 'macOS', Online: online, LastSeen: lastSeen };
  }
  return JSON.stringify({ BackendState: 'Running', Self: { HostName: 'mac-self' }, Peer: peerMap });
}
const STATUS_A = status([['mac-primary', true, '2026-11-18T18:59:00.000Z'], ['mac-backup', false, '2026-11-18T18:58:00.000Z']]);
const STATUS_B = status([['mac-gamma', true, '2026-11-18T19:02:30.000Z'], ['mac-backup', false, '2026-11-18T19:01:30.000Z']]);

type ConfigMode = 'a' | 'throw-error' | 'throw-value' | 'b';

// Mutable seams: each phase flips these on the same retained connection.
let nowMs = Date.parse(T1);
let configMode: ConfigMode = 'a';
let configReads = 0;
let execReads = 0;

const deps: PoolReachDeps = {
  readConfig: () => {
    configReads += 1;
    if (configMode === 'throw-error') throw new Error(`pool parse failed: ${MARKER} at ${FAKE_PATH}`);
    // Non-Error value whose String() form would also leak the marker.
    if (configMode === 'throw-value') throw { detail: `${MARKER} ${FAKE_PATH}` };
    return configMode === 'b' ? CONFIG_B : CONFIG_A;
  },
  peers: {
    now: () => new Date(nowMs),
    homeDir: () => HOME,
    exec: () => {
      execReads += 1;
      return configMode === 'b' ? STATUS_B : STATUS_A;
    },
  },
};

const readers: FleetReaders = {
  status: async () => ({}),
  loop: async () => ({}),
  // The REAL readPoolReach is the only reader; no completed report is injected.
  poolReach: async () => readPoolReach(deps),
};

const clients: Client[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  servers.push(server);
  const client = new Client({ name: 'pool-config-boundary-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client): Promise<{ raw: string; parsed: Record<string, unknown> }> {
  const result = await client.callTool({ name: NAME });
  expect(result.isError).toBeFalsy();
  const raw = (result.content as Array<{ text: string }>)[0]!.text;
  return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
}

function phase(at: string, config: ConfigMode): void {
  nowMs = Date.parse(at);
  configMode = config;
}

describe('fleet_pool_reach config failure boundary over one MCP connection', () => {
  it('omits thrown text on Error and non-Error config failures, then recovers fresh config and clock', async () => {
    const client = await connect();

    phase(T1, 'a');
    const valid = await call(client);
    expect(valid.parsed).toMatchObject({ asOf: T1, self: 'mac-self', role: 'worker', reasons: [] });
    expect(valid.parsed.hosts).toEqual([
      { slot: 'primary', alias: 'mac-primary', matched: 'mac-primary', online: true, lastSeen: '2026-11-18T18:59:00.000Z', ageSeconds: 60, isSelf: false },
      { slot: 'backup', alias: 'mac-backup', matched: 'mac-backup', online: false, lastSeen: '2026-11-18T18:58:00.000Z', ageSeconds: 120, isSelf: false },
    ]);

    // Config throws an Error: unknown role, no hosts, fixed reason, fresh peer as-of.
    phase(T2, 'throw-error');
    const errored = await call(client);
    expect(errored.parsed).toEqual({ asOf: T2, self: 'mac-self', role: 'unknown', hosts: [], reasons: FAILED });
    for (const leak of [MARKER, FAKE_PATH, 'pool parse failed', HOME, 'mac-primary', 'mac-backup']) {
      expect(errored.raw).not.toContain(leak);
    }

    // Config throws a non-Error value: same contract, nothing stringified.
    phase(T3, 'throw-value');
    const thrownValue = await call(client);
    expect(thrownValue.parsed).toEqual({ asOf: T3, self: 'mac-self', role: 'unknown', hosts: [], reasons: FAILED });
    for (const leak of [MARKER, FAKE_PATH, '[object Object]', HOME, 'detail']) {
      expect(thrownValue.raw).not.toContain(leak);
    }

    // Changed config at a later clock: fresh role, hosts and time; no stale failure or config-A host.
    phase(T4, 'b');
    const recovered = await call(client);
    expect(recovered.parsed).toEqual({
      asOf: T4,
      self: 'mac-self',
      role: 'backup',
      hosts: [
        { slot: 'primary', alias: 'mac-gamma', matched: 'mac-gamma', online: true, lastSeen: '2026-11-18T19:02:30.000Z', ageSeconds: 30, isSelf: false },
        { slot: 'backup', alias: 'mac-backup', matched: 'mac-backup', online: false, lastSeen: '2026-11-18T19:01:30.000Z', ageSeconds: 90, isSelf: false },
      ],
      reasons: [],
    });
    expect(recovered.raw).not.toContain('mac-primary');
    expect(recovered.raw).not.toContain('pool config');

    // Every call re-read config and tailscale on the one retained connection.
    expect(configReads).toBe(4);
    expect(execReads).toBe(4);
  });
});
