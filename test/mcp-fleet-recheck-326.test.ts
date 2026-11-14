/**
 * RQ-PHX-RECHECKMCPTOOL326 — fleet_recheck: read-only joined verdict over MCP.
 * Hermetic: in-memory transports and an injected recheck reader with fake hosts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(c => c.close())); });

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'recheck-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args?: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { result, text };
}

const ASOF = '2026-01-01T00:00:00.000Z';
const FAKE: FleetRecheck = {
  schema: 'fleet.recheck.v1',
  asOf: ASOF,
  sections: {
    runtime: {
      state: 'VERIFIED', source: 'runtime-identity', asOf: ASOF, host: 'host-a', tailnetName: 'tail-a',
      installedVersion: '1.2.3', sourceVersion: '1.2.3', fleetState: { ageSeconds: 5, stale: false }, missing: [],
    },
    claims: {
      state: 'VERIFIED', source: 'coordination', asOf: ASOF, active: 1, expiredClaims: 0,
      top: [{ agent: 'agent-a', repo: 'repo-a', task: 'task text', expiresAt: ASOF }], missing: [],
    },
    bridge: {
      state: 'VERIFIED', source: 'channel-health', asOf: ASOF, missingBridge: null, missing: [],
      channels: [
        { channel: 'slack', state: 'LIVE', runtimeHost: 'host-a', processAlive: true, missingBridge: null },
        { channel: 'imessage', state: 'LIVE', runtimeHost: 'host-a', processAlive: true, missingBridge: null },
      ],
    },
    task: {
      state: 'VERIFIED', source: 'work-board', asOf: ASOF, unowned: 0, unclaimed: 0, missing: [],
      task: { id: 'JOB-1', state: 'RUNNING', owner: 'agent-a', claimReceipt: 'receipt-1', ledgerClaim: null, asOf: ASOF, source: 'work-board' },
    },
  },
  overall: { state: 'VERIFIED', missing: [] },
};

describe('fleet_recheck MCP tool', () => {
  it('is listed with a closed schema holding one optional boolean reply', async () => {
    const { tools } = await (await connect({ recheck: async () => FAKE })).listTools();
    const tool = tools.find(t => t.name === 'fleet_recheck');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({ properties: { reply: { type: 'boolean' } }, additionalProperties: false });
    expect(tool!.inputSchema.required ?? []).toEqual([]);
  });

  it('returns the fleet.recheck.v1 verdict by default', async () => {
    const { result, text } = await call(await connect({ recheck: async () => FAKE }), 'fleet_recheck');
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(text) as FleetRecheck;
    expect(parsed.schema).toBe('fleet.recheck.v1');
    expect(parsed.overall.state).toBe('VERIFIED');
  });

  it('reply:true returns paste-ready text that never says routed or dispatched', async () => {
    const { result, text } = await call(await connect({ recheck: async () => FAKE }), 'fleet_recheck', { reply: true });
    expect(result.isError).toBeFalsy();
    expect(text.split('\n')[0]).toMatch(/^Phantom recheck/);
    expect(text).not.toMatch(/\b(routed|dispatched)\b/i);
  });

  it('reply:false returns JSON', async () => {
    const { text } = await call(await connect({ recheck: async () => FAKE }), 'fleet_recheck', { reply: false });
    expect(JSON.parse(text).schema).toBe('fleet.recheck.v1');
  });

  it.each([{ root: '/tmp' }, { cwd: '.' }, { limit: 1 }, { reply: true, path: 'x' }, { reply: 'yes' }, { reply: null }])(
    'refuses %j', async (args) => {
      const client = await connect({ recheck: async () => FAKE });
      await expect(call(client, 'fleet_recheck', args)).rejects.toThrow(/Invalid fleet tool arguments/);
    },
  );

  it('a throwing reader returns an MCP error result without leaking the cause', async () => {
    const client = await connect({ recheck: async () => { throw new Error('boom /Users/someone sk-secret'); } });
    for (const args of [undefined, { reply: true }]) {
      const { result, text } = await call(client, 'fleet_recheck', args);
      expect(result.isError).toBe(true);
      expect(text).not.toMatch(/boom|sk-|Users/);
    }
  });
});
