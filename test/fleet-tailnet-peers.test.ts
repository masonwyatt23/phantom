import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetPeers } from '../src/cli/fleet-peers.js';
import { parseTailnetStatus, readTailnetPeers, type TailnetExec } from '../src/core/fleet/tailnet-peers.js';

const raw = readFileSync(new URL('./fixtures/fleet/tailnet-status.fake.json', import.meta.url), 'utf8');
const fixture: unknown = JSON.parse(raw);
const now = new Date('2026-11-13T20:00:00Z');
const ok: TailnetExec = async () => raw;

afterEach(() => vi.restoreAllMocks());

function capture(): { out: () => string } {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => { lines.push(String(s)); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { out: () => lines.join('\n') };
}

describe('parseTailnetStatus', () => {
  it('returns self plus online peers', () => {
    const r = parseTailnetStatus(fixture, now);
    expect(r.asOf).toBe(now.toISOString());
    expect(r.self).toEqual({ hostName: 'fleet-mac-a', os: 'macOS', online: true, lastSeen: 'unknown', isSelf: true });
    const b = r.peers.find(p => p.hostName === 'fleet-mac-b');
    expect(b).toEqual({ hostName: 'fleet-mac-b', os: 'macOS', online: true, lastSeen: '2026-11-13T18:00:00.000Z', isSelf: false });
    expect(r.peers.filter(p => p.online)).toHaveLength(2);
    expect(r.reasons).toEqual([]);
  });

  it('keeps an offline peer with its lastSeen', () => {
    const c = parseTailnetStatus(fixture, now).peers.find(p => p.hostName === 'fleet-linux-c');
    expect(c).toMatchObject({ online: false, lastSeen: '2026-11-12T09:30:00.000Z', os: 'linux' });
  });

  it.each([null, 'x', 42, [], {}, { Self: 3, Peer: 'nope' }])('never throws on malformed input %j', bad => {
    const r = parseTailnetStatus(bad, now);
    expect(r.peers).toEqual([]);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('skips malformed peer entries with a reason', () => {
    const r = parseTailnetStatus({ Self: { HostName: 'a' }, Peer: { k: { OS: 'linux' }, j: 7 } }, now);
    expect(r.peers).toEqual([]);
    expect(r.reasons).toContain('2 malformed peer entries skipped');
  });
});

describe('readTailnetPeers', () => {
  it('runs only read-only `tailscale status --json` with a 5s timeout', async () => {
    const exec = vi.fn(ok);
    const r = await readTailnetPeers(exec, now);
    expect(exec).toHaveBeenCalledWith('tailscale', ['status', '--json'], { timeoutMs: 5000 });
    expect(r.available && r.peers).toHaveLength(3);
  });

  it('reports a missing binary', async () => {
    const r = await readTailnetPeers(async () => { throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }); });
    expect(r).toEqual({ available: false, reason: 'tailscale binary not found' });
  });

  it('reports a non-zero exit', async () => {
    const r = await readTailnetPeers(async () => { throw new Error('Command failed: tailscale status\nstopped'); });
    expect(r).toEqual({ available: false, reason: 'tailscale status failed: Command failed: tailscale status' });
  });

  it('turns malformed JSON output into empty peers plus a reason', async () => {
    const r = await readTailnetPeers(async () => '{not json', now);
    expect(r).toMatchObject({ available: true, peers: [], reasons: ['tailscale status output is not valid JSON'] });
  });
});

describe('cmdFleetPeers', () => {
  it('prints a table and no IPs or key fields', async () => {
    const cap = capture();
    expect(await cmdFleetPeers([], ok)).toBe(0);
    const out = cap.out();
    expect(out).toContain('HOST');
    expect(out).toContain('fleet-mac-a (self)');
    expect(out).toContain('fleet-linux-c');
    expect(out).not.toMatch(/100\.64\.|nodekey|PublicKey|tag:|tailnet-fake/);
  });

  it('--json omits every IP, key, id, tag and login field', async () => {
    const cap = capture();
    expect(await cmdFleetPeers(['--json'], ok)).toBe(0);
    const out = cap.out();
    const parsed = JSON.parse(out);
    expect(parsed.available).toBe(true);
    expect(Object.keys(parsed.self).sort()).toEqual(['hostName', 'isSelf', 'lastSeen', 'online', 'os']);
    expect(out).not.toMatch(/100\.64\.|nodekey|PublicKey|TailscaleIPs|Tags|UserID|"ID"|tag:|DNSName/);
  });

  it('exits 1 when tailscale is unavailable and 2 on a bad flag', async () => {
    const cap = capture();
    const missing: TailnetExec = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
    expect(await cmdFleetPeers([], missing)).toBe(1);
    expect(cap.out()).toContain('tailnet unavailable: tailscale binary not found');
    expect(await cmdFleetPeers(['--bogus'], ok)).toBe(2);
  });
});
