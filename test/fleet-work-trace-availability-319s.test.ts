/** `fleet work-trace` exit-code availability contract (RQ-PHX-WORKTRACEAVAILABILITY319S):
 * exit 0 when a trace printed — absent durable stores are a valid read —
 * exit 1 when either durable source is unavailable, after the diagnostic
 * output is still printed, and exit 2 on usage errors. Fixtures are real tmp
 * durable stores with controlled corrupt files; every run must leave the
 * fixture bytes untouched. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { cmdFleetWorkTrace } from '../src/cli/fleet-work-trace.js';

let root: string, now: number;
const ID = 'RQ-PHX-FAKE-319S';
const inboxFile = () => join(root, 'bus-inbox', 'messages.json');
const claimsFile = () => join(root, 'bus-work-claims', 'claims.json');

function snapshot(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(`${relative(root, path)}:${readFileSync(path).toString('base64')}`);
    }
  };
  try { walk(root); } catch { /* empty root */ }
  return out.sort().join('\n');
}
const post = () => {
  expect(appendBusInbox({ id: ID, from: 'fake-requester', to: 'fake-lane', priority: 'P1',
    ttl: 10_000_000, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
};
const acquire = () => {
  const claim = mutateBusWorkClaim({ action: 'acquire', id: ID, owner: 'fake-owner', leaseMs: 600_000, root });
  expect(claim.status).toBe('acquired');
  return claim;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-trace-avail-'));
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('cmdFleetWorkTrace availability exit codes', { timeout: 60_000 }, () => {
  it('a valid empty root is a valid read: exit 0 with both sources missing', async () => {
    const before = snapshot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace(['--id', 'RQ-NOPE', '--root', root, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({
      state: 'RECEIVED', asOf: 'unknown', inbox: 'missing', claims: 'missing' });
    expect(await cmdFleetWorkTrace(['--id', 'RQ-NOPE', '--root', root])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toContain('inbox=missing claims=missing');
    expect(snapshot()).toBe(before);
  });

  it('a received request with live stores still exits 0', async () => {
    post();
    acquire();
    const before = snapshot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', root, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({
      state: 'RUNNING', inbox: 'found', claims: 'available' });
    expect(snapshot()).toBe(before);
  });

  it('a corrupt inbox prints the trace then exits 1, JSON and text', async () => {
    post();
    writeFileSync(inboxFile(), '{broken', { mode: 0o600 });
    const before = snapshot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', root, '--json'])).toBe(1);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ id: ID, inbox: 'unavailable', claims: 'missing' });
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', root])).toBe(1);
    const line = String(log.mock.calls.at(-1)![0]);
    expect(line).toContain(`${ID} `);
    expect(line).toContain('inbox=unavailable claims=missing');
    expect(snapshot()).toBe(before);
    expect(readFileSync(inboxFile(), 'utf8')).toBe('{broken');
  });

  it('a corrupt claims table prints the trace then exits 1', async () => {
    post();
    acquire();
    writeFileSync(claimsFile(), '{broken', { mode: 0o600 });
    const before = snapshot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', root, '--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({
      inbox: 'found', claims: 'unavailable' });
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', root])).toBe(1);
    expect(String(log.mock.calls.at(-1)![0])).toContain('inbox=found claims=unavailable');
    expect(snapshot()).toBe(before);
    expect(readFileSync(claimsFile(), 'utf8')).toBe('{broken');
  });

  it('usage errors still exit 2 and --help documents the exit contract', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace([])).toBe(2);
    expect(await cmdFleetWorkTrace(['--id', ID, '--bogus'])).toBe(2);
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', 'relative/path'])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    expect(await cmdFleetWorkTrace(['--help'])).toBe(0);
    const help = String(log.mock.calls.at(-1)![0]);
    expect(help).toContain('Exit 0');
    expect(help).toContain('exit 1');
    expect(help).toContain('exit 2');
  });
});
