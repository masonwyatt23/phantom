import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetNodes } from '../src/cli/fleet-nodes.js';
import { NODE_OFFLINE_MS } from '../src/core/drive/nodes/router.js';

const now = Date.parse('2026-11-02T12:00:30Z');
const priorHome = process.env['ASHLR_HOME'];
let home = '';
afterEach(() => {
  vi.restoreAllMocks();
  if (priorHome === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = priorHome;
  if (home) rmSync(home, { recursive: true, force: true });
});
function setup() {
  home = mkdtempSync(join(tmpdir(), 'nodes-proof-'));
  process.env['ASHLR_HOME'] = home;
  mkdirSync(join(home, 'nodes'));
  return join(home, 'nodes', 'nodes.json');
}
function run(json = true) {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s); });
  const code = cmdFleetNodes([...(json ? ['--json'] : []), '--now', new Date(now).toISOString()]);
  log.mockRestore();
  return { code, output: lines.join('\n') };
}
it('preserves the composed inventory workflow with current heartbeat and lease rules', () => {
  const file = setup();
  const node = (nodeId: string, session: number, heartbeatAt: number) => ({ nodeId, session, heartbeatAt, expiresAt: now + 1000 });
  const job = (id: string, session: number, expiresAt: number, state = 'running') => ({ id, state, claim: { jobId: id, nodeId: 'alpha', session, token: 5, leaderToken: 5, expiresAt }, ...(state === 'completed' ? { result: 'ok' } : {}) });
  const state = { version: 'drive.nodes.v1', sequence: 5, observedAt: now, nodes: [node('future', 2, now + 1), node('edge', 3, now - NODE_OFFLINE_MS), node('before', 4, now - NODE_OFFLINE_MS + 1), node('alpha', 1, now - 1000)], leader: { nodeId: 'alpha', session: 1, token: 5, expiresAt: now + 1 }, jobs: [job('live', 1, now + 1), job('expired', 1, now), job('old-session', 2, now + 1), job('finished', 1, now + 1, 'completed')] };
  writeFileSync(file, JSON.stringify(state));
  const bytes = readFileSync(file);
  const first = run();
  expect(first.code).toBe(0);
  expect(run()).toEqual(first);
  const result = JSON.parse(first.output);
  expect(result.leaderId).toBe('alpha');
  expect(result.nodes.map((n: { id: string; status: string }) => [n.id, n.status])).toEqual([['alpha', 'ready'], ['before', 'stale'], ['edge', 'down'], ['future', 'unknown']]);
  expect(result.nodes[0]).toMatchObject({ role: 'leader', leader: true, liveJobs: ['live'] });
  const text = run(false);
  expect(run(false)).toEqual(text);
  expect(text.output).toContain('leader: alpha');
  expect(text.output).toContain('alpha  leader  ready  heartbeat 1s  jobs 1');
  expect(readFileSync(file)).toEqual(bytes);
  state.leader.session = 2;
  writeFileSync(file, JSON.stringify(state));
  const mismatchBytes = readFileSync(file);
  expect(JSON.parse(run().output).leaderId).toBeNull();
  expect(run(false).output).toContain('leader: none (no live lease)');
  expect(readFileSync(file)).toEqual(mismatchBytes);
  state.leader.session = 1;
  state.leader.expiresAt = now;
  writeFileSync(file, JSON.stringify(state));
  const expiredBytes = readFileSync(file);
  expect(JSON.parse(run().output).leaderId).toBeNull();
  expect(readFileSync(file)).toEqual(expiredBytes);
});
it('distinguishes absent, corrupt and valid empty inventories without mutation', () => {
  const file = setup();
  expect(JSON.parse(run().output).error).toBe('inventory missing');
  expect(run().code).toBe(1);
  expect(readdirSync(join(home, 'nodes'))).toEqual([]);
  writeFileSync(file, '{');
  const malformed = readFileSync(file);
  expect(JSON.parse(run().output).error).toBe('inventory is not valid JSON');
  expect(run().code).toBe(1);
  expect(readFileSync(file)).toEqual(malformed);
  writeFileSync(file, JSON.stringify({ version: 'drive.nodes.v1', sequence: 0, observedAt: 0, nodes: [], leader: null, jobs: [] }));
  const empty = readFileSync(file);
  expect(JSON.parse(run().output)).toMatchObject({ error: null, nodes: [], leaderId: null });
  expect(run().code).toBe(0);
  expect(readFileSync(file)).toEqual(empty);
});
