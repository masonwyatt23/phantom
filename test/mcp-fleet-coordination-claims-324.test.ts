/**
 * RQ-PHX-COORDCLAIMSMCP324 — fleet_coordination_claims: read-only,
 * argument-free MCP evidence of the advisory coordination claims ledger — the
 * same readFleetBoard read as `ashlr fleet coordination board`, never a second
 * ledger, with messages, proposals and lease material never included.
 * Hermetic: in-memory transports, injected readers, and a temp
 * PHANTOM_FLEET_LEDGER_PATH for the default-reader case.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { claimFleetWork, type FleetBoard, type FleetClaim } from '../src/core/fleet/coordination.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';

const connections: Client[] = [];
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-coord-claims-324-')); });
afterEach(async () => {
  await Promise.all(connections.splice(0).map(c => c.close()));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'coordination-claims-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_coordination_claims', arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { result, text, parsed: JSON.parse(text) as Record<string, unknown> };
}

const claim = (id: string, claimedAt: number, extra: Record<string, unknown> = {}): FleetClaim => ({
  id, repo: 'example/repo', task: `task-${id}`, agent: 'fake-agent',
  claimedAt, expiresAt: claimedAt + 3_600_000, ...extra,
});

/** A board that also carries a message and a proposal the tool must drop. */
const board = (claims: FleetClaim[], over: Partial<FleetBoard> = {}): FleetBoard => ({
  schema: 'fleet.coordination.v1', state: 'known', claims,
  messages: [{ id: 'fake-message', from: 'fake-agent', to: 'other-agent', body: 'FAKE-BODY-SENTINEL-324', at: 1, expiresAt: 2 }],
  proposals: [{ id: 'fake-proposal', repo: 'example/repo', task: 'FAKE-PROPOSAL-SENTINEL-324', to: 'other-agent', at: 1, expiresAt: 2, executionAuthorized: false }],
  expiredClaims: 3, ...over,
});

describe('fleet_coordination_claims MCP tool', () => {
  it('is listed with a closed, argument-free schema', async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find(t => t.name === 'fleet_coordination_claims');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    expect(tool!.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
  });

  it('returns claims newest first with ISO times and never messages, proposals or lease material', async () => {
    const claims = [
      claim('claim-old', 1_700_000_000_000, { leaseHash: 'a'.repeat(64) }),
      claim('claim-new', 1_700_000_100_000, { lease: 'FAKE-LEASE-SENTINEL-324' }),
    ];
    const { result, text, parsed } = await call(await connect({ coordinationClaims: () => board(claims) }));
    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      schema: 'fleet.coordination.v1', state: 'known', source: 'coordination-ledger', expiredClaims: 3,
    });
    expect(typeof parsed['asOf']).toBe('string');
    const list = parsed['claims'] as Array<Record<string, unknown>>;
    expect(list.map(c => c['id'])).toEqual(['claim-new', 'claim-old']);
    expect(list[0]).toEqual({
      id: 'claim-new', repo: 'example/repo', task: 'task-claim-new', agent: 'fake-agent',
      claimedAt: new Date(1_700_000_100_000).toISOString(),
      expiresAt: new Date(1_700_000_100_000 + 3_600_000).toISOString(),
    });
    for (const needle of ['FAKE-BODY-SENTINEL-324', 'FAKE-PROPOSAL-SENTINEL-324', 'FAKE-LEASE-SENTINEL-324',
      'messages', 'proposals', 'lease']) {
      expect(text).not.toContain(needle);
    }
  });

  it('a throwing reader reports unknown with a fixed reason, never an invented known board', async () => {
    const { result, text, parsed } = await call(await connect({
      coordinationClaims: () => { throw new Error('boom /Users/someone sk-secret'); },
    }));
    expect(result.isError).toBeFalsy();
    expect(parsed).toEqual({ status: 'unknown', reason: 'coordination ledger: reader failed' });
    expect(text).not.toMatch(/boom|sk-|Users/);
  });

  it('passes a reader-reported unknown state through with no claims', async () => {
    const { parsed } = await call(await connect({
      coordinationClaims: () => board([], { state: 'unknown', expiredClaims: null }),
    }));
    expect(parsed).toMatchObject({
      schema: 'fleet.coordination.v1', state: 'unknown', source: 'coordination-ledger',
      claims: [], expiredClaims: null,
    });
  });

  it.each([[{ root: '/tmp' }], [{ cwd: '.' }], [{ path: 'x' }], [{ limit: 1 }], [{ agent: 'fake-agent' }]])(
    'refuses arguments before invoking the reader: %j', async args => {
      const coordinationClaims = vi.fn(() => board([]));
      const client = await connect({ coordinationClaims });
      await expect(call(client, args)).rejects.toThrow(/Invalid fleet tool arguments/);
      expect(coordinationClaims).not.toHaveBeenCalled();
    },
  );

  it('caps claims at 50, newest first', async () => {
    const claims = Array.from({ length: 60 }, (_, i) =>
      claim(`claim-${String(i).padStart(2, '0')}`, 1_700_000_000_000 + i * 1_000));
    const { parsed } = await call(await connect({ coordinationClaims: () => board(claims) }));
    const list = parsed['claims'] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(50);
    expect(list[0]!['id']).toBe('claim-59');
    expect(list[49]!['id']).toBe('claim-10');
  });

  it('the default reader reads only the server default ledger path', async () => {
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', join(dir, 'coordination.jsonl'));
    expect(claimFleetWork({ repo: 'example/repo', task: 'default-reader-task', agent: 'fake-agent' }).ok).toBe(true);
    const { parsed } = await call(await connect());
    expect(parsed['state']).toBe('known');
    const list = parsed['claims'] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ repo: 'example/repo', task: 'default-reader-task', agent: 'fake-agent' });
    expect(list[0]).not.toHaveProperty('leaseHash');
  });

  it('is documented in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_coordination_claims` \|/m);
  });
});
