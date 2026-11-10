import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildNodesSnapshot } from '../src/core/nodes/view.js';
import { cmdNodes } from '../src/cli/nodes.js';

const NOW = Date.parse('2026-11-02T12:00:30Z');

function homeWith(nodes: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'nodes-home-'));
  mkdirSync(join(home, 'nodes'));
  writeFileSync(join(home, 'nodes', 'nodes.json'), typeof nodes === 'string' ? nodes : JSON.stringify(nodes));
  return home;
}

const STATE = {
  version: 'drive.nodes.v1', sequence: 4, observedAt: NOW,
  nodes: [
    { nodeId: 'mac-mini-1', session: 1, heartbeatAt: NOW - 30_000, expiresAt: NOW + 100_000, caps: ['gh', 'os:darwin'], owners: ['team'], auth: 'ok' },
    { nodeId: 'lima-vm-2', session: 2, heartbeatAt: NOW - 210_000, expiresAt: NOW + 100_000, caps: ['os:linux'] },
  ],
  leader: { nodeId: 'mac-mini-1', session: 1, token: 2, expiresAt: NOW + 60_000 },
  jobs: [],
};

afterEach(() => { vi.restoreAllMocks(); delete process.env['ASHLR_HOME']; });

describe('nodes view', () => {
  it('reports role, caps, heartbeat age, live jobs and the leader badge deterministically', () => {
    const dir = join(homeWith(STATE), 'nodes');
    const a = buildNodesSnapshot({ nowMs: NOW, dir });
    const b = buildNodesSnapshot({ nowMs: NOW, dir });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.error).toBeNull();
    expect(a.leaderId).toBe('mac-mini-1');
    expect(a.nodes.map((n) => [n.id, n.role, n.status, n.heartbeatAgeMs, n.leader])).toEqual([
      ['lima-vm-2', 'worker', 'stale', 210_000, false],
      ['mac-mini-1', 'leader', 'ready', 30_000, true],
    ]);
    expect(a.nodes[1]!.caps).toEqual(['gh', 'os:darwin']);
  });

  it('gives no leader once the lease expires', () => {
    const dir = join(homeWith(STATE), 'nodes');
    const late = buildNodesSnapshot({ nowMs: NOW + 600_000, dir });
    expect(late.leaderId).toBeNull();
    expect(late.nodes.find((n) => n.id === 'mac-mini-1')).toMatchObject({ leader: false });
  });

  it('reports a missing or malformed inventory as an error, never inventing nodes', () => {
    const missing = buildNodesSnapshot({ nowMs: NOW, dir: join(mkdtempSync(join(tmpdir(), 'nodes-none-')), 'nodes') });
    expect(missing.error).toBe('inventory missing');
    expect(missing.nodes).toEqual([]);
    const bad = buildNodesSnapshot({ nowMs: NOW, dir: join(homeWith('{'), 'nodes') });
    expect(bad.error).toBe('inventory is not valid JSON');
  });
});

describe('phm nodes', () => {
  it('prints parseable --json and a human table, and rejects bad flags with a fix', () => {
    process.env['ASHLR_HOME'] = homeWith(STATE);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(m); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(cmdNodes(['--json', '--now', '2026-11-02T12:00:30Z'])).toBe(0);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.schema).toBe('phantom.nodes.v1');
    expect(parsed.leaderId).toBe('mac-mini-1');
    out.length = 0;
    expect(cmdNodes(['--now', '2026-11-02T12:00:30Z'])).toBe(0);
    expect(out.join('\n')).toContain('★ mac-mini-1');
    expect(cmdNodes(['--bogus'])).toBe(2);
    expect(err.mock.calls[0]![0]).toContain('Usage: phm nodes');
    expect(cmdNodes(['--now', 'soon'])).toBe(2);
  });

  it('exits 1 when the inventory cannot be read', () => {
    process.env['ASHLR_HOME'] = mkdtempSync(join(tmpdir(), 'nodes-empty-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(cmdNodes(['--json'])).toBe(1);
  });
});
