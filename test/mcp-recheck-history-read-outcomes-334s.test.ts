import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { recheckLogPath } from '../src/core/fleet/recheck-record.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const savedHome = process.env.ASHLR_HOME;
const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map(client => client.close()));
  } finally {
    if (savedHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = savedHome;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recheck-history-private-'));
  roots.push(root);
  process.env.ASHLR_HOME = root;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer();
  const client = new Client({ name: 'history-read-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { root, file: recheckLogPath(root), client };
}

async function read(client: Client, root: string) {
  const result = await client.callTool({ name: 'fleet_recheck_history', arguments: { last: 5 } });
  expect(result.isError).toBeUndefined();
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(root);
  expect(serialized).not.toMatch(/EISDIR:|illegal operation|stack trace/i);
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]!.text) as unknown;
}

describe('fleet_recheck_history default disk reader over MCP', () => {
  it('reports an absent log without creating it', async () => {
    const { root, file, client } = await fixture();
    const before = readdirSync(root);
    expect(await read(client, root)).toEqual({ rows: [], skipped: 0, missing: true });
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(root)).toEqual(before);
  });

  it('reports a successfully read empty log', async () => {
    const { root, file, client } = await fixture();
    mkdirSync(join(root, 'fleet'));
    writeFileSync(file, '');
    const before = readFileSync(file);
    expect(await read(client, root)).toEqual({ rows: [], skipped: 0, missing: false, outcome: 'ok' });
    expect(readFileSync(file)).toEqual(before);
  });

  it('counts malformed-only history without treating it as clean empty history', async () => {
    const { root, file, client } = await fixture();
    mkdirSync(join(root, 'fleet'));
    writeFileSync(file, '{broken private-content\nnot-json\n');
    const before = readFileSync(file);
    const result = await read(client, root);
    expect(result).toEqual({ rows: [], skipped: 2, missing: false, outcome: 'ok' });
    expect(JSON.stringify(result)).not.toContain('private-content');
    expect(readFileSync(file)).toEqual(before);
  });

  it('reports a deterministic read failure without exposing the error or writing a log', async () => {
    const { root, file, client } = await fixture();
    mkdirSync(file, { recursive: true });
    writeFileSync(join(file, 'marker'), 'unchanged');
    const before = readdirSync(file);
    const marker = readFileSync(join(file, 'marker'));
    expect(await read(client, root)).toEqual({ rows: [], skipped: 0, missing: false, outcome: 'unreadable', failure: 'EISDIR' });
    expect(readdirSync(file)).toEqual(before);
    expect(readFileSync(join(file, 'marker'))).toEqual(marker);
  });
});
