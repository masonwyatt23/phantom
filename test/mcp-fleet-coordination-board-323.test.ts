/**
 * RQ-PHX-COORDMCPBOARD323 — fleet_coordination_board: an MCP agent reads the
 * host coordination ledger (fleet.coordination.v1 — live claims, messages and
 * assignment proposals) through the isolated fleet MCP server, the same
 * readFleetBoard listing as `ashlr fleet coordination board`, never a second
 * reader. Read-only: it never claims, releases, renews, hands off or posts.
 *
 * Hermetic: PHANTOM_FLEET_LEDGER_PATH pointed at a temp ledger, in-memory MCP
 * transports, the real coordination writers as fixtures, no daemon or network.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { claimFleetWork, postFleetMessage, proposeFleetAssignment } from '../src/core/fleet/coordination.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';

let root: string, ledgerPath: string, now: number;
const connections: Client[] = [];
const CLAIM_TTL_MS = 3_600_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-coordination-board-323-'));
  ledgerPath = join(root, 'coordination.jsonl');
  vi.stubEnv('ASHLR_HOME', root);
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledgerPath);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Real protocol round trip; coordinationBoard defaults to the canonical reader. */
async function connect(readers: FleetReaders = {
  status: async () => ({}),
  loop: async () => ({}),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'coordination-board-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callBoard(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_coordination_board', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

const rows = (parsed: Record<string, unknown>, key: string) => parsed[key] as Array<Record<string, unknown>>;

describe('RQ-PHX-COORDMCPBOARD323 fleet_coordination_board MCP tool', () => {
  it('is listed beside the existing read-only tools with a closed schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_coordination_board');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('grant no execution, dispatch, claim or merge authority');
    expect(tool?.description).toContain('never a second reader');
    expect(tool?.description).toContain('state "unknown"');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['repo', 'agent']);
    expect(tool?.inputSchema.required ?? []).toEqual([]);
  });

  it.each([
    [{ path: '/tmp/fake-ledger' }], [{ root: '/tmp' }], [{ cwd: '.' }], [{ ledger: 'x' }],
    [{ limit: 1 }], [{ repo: 5 }], [{ repo: null }], [{ repo: 'not a repo' }], [{ repo: '/tmp/x' }],
    [{ repo: 'example/fake', path: '/tmp/x' }], [{ agent: 7 }], [{ agent: null }],
    [{ agent: 'white space' }], [{ agent: '' }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const coordinationBoard = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), coordinationBoard });
    await expect(client.callTool({ name: 'fleet_coordination_board', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(coordinationBoard).not.toHaveBeenCalled();
  });

  it('passes validated filters to the injected reader seam', async () => {
    const coordinationBoard = vi.fn(async () => ({ fake: 'board' }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), coordinationBoard });
    const { parsed } = await callBoard(client);
    expect(parsed).toEqual({ fake: 'board' });
    expect(coordinationBoard).toHaveBeenLastCalledWith({ repo: undefined, agent: undefined });
    await callBoard(client, { repo: 'example/fake', agent: 'fake-agent-a' });
    expect(coordinationBoard).toHaveBeenLastCalledWith({ repo: 'example/fake', agent: 'fake-agent-a' });
  });

  it('returns a live claim with holder fields and no lease material anywhere', async () => {
    const claimed = claimFleetWork({ repo: 'example/fake', task: 'Fake task', agent: 'fake-agent-a' });
    if (!claimed.ok) throw new Error('claim failed');
    const { parsed, text } = await callBoard(await connect());
    expect(parsed).toMatchObject({ schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0 });
    expect(parsed['asOf']).toBe(new Date(now).toISOString());
    const claims = rows(parsed, 'claims');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      id: claimed.value.claim.id, repo: 'example/fake', task: 'Fake task',
      agent: 'fake-agent-a', claimedAt: now, expiresAt: now + CLAIM_TTL_MS,
    });
    expect(Object.keys(claims[0]!)).not.toContain('lease');
    expect(Object.keys(claims[0]!)).not.toContain('leaseHash');
    expect(text).not.toContain('lease');
    expect(text).not.toContain(claimed.value.lease);
  });

  it('filters claims and proposals by repo, and claims, messages and proposals by agent', async () => {
    expect(claimFleetWork({ repo: 'example/fake', task: 'Fake task one', agent: 'fake-agent-a' }).ok).toBe(true);
    expect(claimFleetWork({ repo: 'example/other', task: 'Fake task two', agent: 'fake-agent-b' }).ok).toBe(true);
    expect(postFleetMessage({ from: 'fake-agent-b', to: 'fake-agent-a', body: 'fake note' }).ok).toBe(true);
    expect(postFleetMessage({ from: 'fake-agent-b', to: 'all', body: 'fake broadcast' }).ok).toBe(true);
    expect(proposeFleetAssignment({ repo: 'example/fake', task: 'Fake proposal', to: 'fake-agent-b' }).ok).toBe(true);
    const client = await connect();
    const byRepo = (await callBoard(client, { repo: 'example/fake' })).parsed;
    expect(rows(byRepo, 'claims').map(claim => claim['task'])).toEqual(['Fake task one']);
    expect(rows(byRepo, 'proposals').map(proposal => proposal['task'])).toEqual(['Fake proposal']);
    expect(rows(byRepo, 'messages')).toEqual([]);
    const byAgent = (await callBoard(client, { agent: 'fake-agent-a' })).parsed;
    expect(rows(byAgent, 'claims').map(claim => claim['agent'])).toEqual(['fake-agent-a']);
    expect(rows(byAgent, 'messages').map(message => message['body'])).toEqual(['fake note', 'fake broadcast']);
    expect(rows(byAgent, 'proposals')).toEqual([]);
    const unmatched = (await callBoard(client, { repo: 'example/fake', agent: 'fake-agent-a' })).parsed;
    expect(rows(unmatched, 'claims')).toHaveLength(1);
    expect(rows(unmatched, 'proposals')).toEqual([]);
    expect(unmatched['state']).toBe('known');
  });

  it('reports state unknown for a corrupt or missing ledger, never an invented known board', async () => {
    const client = await connect();
    const missing = (await callBoard(client)).parsed;
    expect(missing).toMatchObject({
      schema: 'fleet.coordination.v1', state: 'unknown',
      claims: [], messages: [], proposals: [], expiredClaims: null,
    });
    writeFileSync(ledgerPath, 'not-json\n', { mode: 0o600 });
    const corrupt = (await callBoard(client)).parsed;
    expect(corrupt).toMatchObject({
      schema: 'fleet.coordination.v1', state: 'unknown',
      claims: [], messages: [], proposals: [], expiredClaims: null,
    });
    expect(corrupt['asOf']).toBe(new Date(now).toISOString());
  });

  it('leaves the ledger bytes untouched across reads', async () => {
    expect(claimFleetWork({ repo: 'example/fake', task: 'Fake task', agent: 'fake-agent-a' }).ok).toBe(true);
    const before = readFileSync(ledgerPath);
    const client = await connect();
    await callBoard(client);
    await callBoard(client, { repo: 'example/fake', agent: 'fake-agent-a' });
    await callBoard(client, { agent: 'fake-agent-b' });
    expect(readFileSync(ledgerPath)).toEqual(before);
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_coordination_board` \|/m);
  });
});
