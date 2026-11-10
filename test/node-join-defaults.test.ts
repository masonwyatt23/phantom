import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNodeFleet, type NodeFleetDeps } from '../src/cli/node-fleet.js';
import { defaultNodeId, joinDefaults } from '../src/core/drive/nodes/join-defaults.js';

let dir = '';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function home() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-join-defaults-')));
  vi.stubEnv('ASHLR_HOME', dir);
}

async function cli(args: string[], deps: NodeFleetDeps = {}) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdNodeFleet('join', args, deps);
  const out = log.mock.calls.map(c => String(c[0])).join('\n');
  const err = error.mock.calls.map(c => String(c[0])).join('\n');
  log.mockRestore(); error.mockRestore();
  return { code, out, err };
}

const identity = { ghLogin: () => 'octocat', caps: () => ['gh', 'build'], host: () => 'My Mac.local' };

describe('node join defaults', () => {
  it('joins with hostname, gh-login owner and detected caps when flags are omitted', async () => {
    home();
    const r = await cli(['--json'], { joinDefaults: identity });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      schemaVersion: 1, command: 'join', nodeId: 'my-mac.local',
      owners: ['person:octocat'], caps: ['build', 'gh'],
    });
  });

  it('explicit flags always win over defaults', async () => {
    home();
    const r = await cli(['--node', 'box', '--owner', 'acme', '--caps', 'deploy', '--json'], { joinDefaults: identity });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ nodeId: 'box', owners: ['acme'], caps: ['deploy'] });
  });

  it('fills only the flags that are missing', async () => {
    home();
    const r = await cli(['--owner', 'acme', '--json'], { joinDefaults: identity });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ nodeId: 'my-mac.local', owners: ['acme'], caps: ['build', 'gh'] });
  });

  it('accepts --flag=value spellings as explicit', async () => {
    home();
    const r = await cli(['--owner=acme', '--node=box', '--json'], { joinDefaults: { ...identity, caps: () => [] } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ nodeId: 'box', owners: ['acme'], caps: [] });
  });

  it('refuses with a fix when there is no gh login and no --owner', async () => {
    home();
    const r = await cli(['--node', 'x'], { joinDefaults: { ghLogin: () => null, caps: () => [], host: () => 'h' } });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--owner is required');
    expect(r.err).toContain('gh auth login');
  });

  it('joins without caps when detection finds none', async () => {
    home();
    const r = await cli(['--json'], { joinDefaults: { ghLogin: () => 'octocat', caps: () => [], host: () => 'h' } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ owners: ['person:octocat'], caps: [] });
  });
});

describe('joinDefaults helpers', () => {
  it('folds hostnames into valid node ids', () => {
    expect(defaultNodeId(() => 'MacBook-Pro.local')).toBe('macbook-pro.local');
    expect(defaultNodeId(() => '!!!')).toBeUndefined();
    expect(defaultNodeId(() => 'a'.repeat(300))).toHaveLength(200);
  });

  it('computes only the wanted defaults', () => {
    const d = joinDefaults({ owner: true }, { ghLogin: () => 'octocat', caps: () => { throw new Error('must not run'); }, host: () => 'h' });
    expect(d).toEqual({ owners: ['person:octocat'] });
  });
});
