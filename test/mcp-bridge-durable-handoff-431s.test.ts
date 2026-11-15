import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`fixture mutation failed: ${result.error}`);
  return result.value;
}

it('observes durable handoff, fenced return, replay and ledger recovery through MCP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-mcp-431s-'));
  const path = join(dir, 'ledger.jsonl');
  const options = { path, now: Date.parse('2026-11-15T12:00:00.000Z') };
  const privateTask = 'private-fixture-task-431s';
  const corruption = 'private-corruption-marker-431s';
  const leases: string[] = [];
  let runtimeAvailable = true;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    bridgeCheck: () => readFleetBridgeCheck({
      now: () => options.now,
      runtime: async () => runtimeAvailable
        ? { host: 'fake-host', lastFleetStateRead: { ageSeconds: 1 } }
        : { status: 'unavailable', lastFleetStateRead: { ageSeconds: 1 } },
      peers: () => ({ status: 'ok' }),
      claims: () => projectCoordinationClaims(readFleetBoard(options), options.now),
    }) });
  const client = new Client({ name: 'bridge-mcp-431s', version: '1.0.0' });
  async function check(live: number | null, missing: string[]) {
    const before = readFileSync(path);
    const files = readdirSync(dir).sort();
    const asOf = new Date(options.now).toISOString();
    const result = await client.callTool({ name: 'fleet_bridge_check', arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    const value = JSON.parse(text);
    expect(value).toMatchObject({ verdict: missing.length ? 'BLOCKED' : 'READY', asOf, missing,
      claims: { source: 'coordination-ledger', asOf, state: live === null ? 'unknown' : 'known', live },
      runtime: { source: 'fleet-runtime', asOf }, peers: { source: 'peer-ledger', asOf } });
    expect(text).not.toContain('RUNNING');
    for (const secret of [privateTask, corruption, ...leases]) expect(text).not.toContain(secret);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(files);
    options.now += 1000;
  }
  try {
    writeFileSync(path, '', { mode: 0o600 });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await check(0, []);
    runtimeAvailable = false;
    await check(0, ['runtime']);
    runtimeAvailable = true;
    const claimed = must(claimFleetWork({ repo: 'fake/repo', task: privateTask, agent: 'fake-a', ttlMs: 60_000 }, options));
    leases.push(claimed.lease);
    await check(1, []);
    const handed = must(handoffFleetClaim({ id: claimed.claim.id, agent: 'fake-a', lease: claimed.lease, to: 'fake-b' }, options));
    leases.push(handed.lease);
    expect(readFleetBoard(options).claims).toMatchObject([{ id: claimed.claim.id, agent: 'fake-b' }]);
    await check(1, []);
    const oldReturn = { id: claimed.claim.id, agent: 'fake-a', lease: claimed.lease, artifact: 'fake-artifact' };
    expect(returnFleetClaim(oldReturn, options)).toMatchObject({ ok: false, outcome: 'not-owner' });
    expect(readFleetBoard(options).claims).toMatchObject([{ id: claimed.claim.id, agent: 'fake-b' }]);
    await check(1, []);
    const currentReturn = { ...oldReturn, agent: 'fake-b', lease: handed.lease };
    expect(returnFleetClaim(currentReturn, options)).toMatchObject({ ok: true, outcome: 'returned' });
    expect(readFleetBoard(options).messages).toHaveLength(1);
    await check(0, []);
    const returnedBytes = readFileSync(path);
    expect(returnFleetClaim(currentReturn, options)).toMatchObject({ ok: true, outcome: 'already-returned' });
    expect(readFleetBoard(options).messages).toHaveLength(1);
    expect(readFileSync(path)).toEqual(returnedBytes);
    await check(0, []);
    writeFileSync(path, `${corruption}\n`, { mode: 0o600 });
    await check(null, ['claims']);
    writeFileSync(path, returnedBytes, { mode: 0o600 });
    await check(0, []);
  } finally {
    await client.close();
    await server.close();
    await clientTransport.close();
    await serverTransport.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
