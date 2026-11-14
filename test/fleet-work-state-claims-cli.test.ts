import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetWorkState } from '../src/cli/fleet-work-state.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

let base: string, root: string;
const envelope = (id: string): BusEnvelope => ({ id, from: 'slack', to: 'worker-a', priority: 'P1', ttl: 120_000,
  body: { kind: 'work', text: 'fake payload' } });
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String(c[0]));

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'work-state-claims-'));
  root = join(base, 'bus');
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, '.ashlr'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('missing table exits 0 and says so', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkState(['--from-claims', '--root', root])).toBe(0);
  expect(lines(log)).toEqual(['no claims recorded (source missing)']);
  log.mockClear();
  expect(await cmdFleetWorkState(['--from-claims', '--root', root, '--json'])).toBe(0);
  expect(JSON.parse(lines(log)[0]!)).toEqual({ source: 'missing', items: [] });
});

it('classifies real claims written through mutateBusWorkClaim', { timeout: 30_000 }, async () => {
  for (const id of ['job-live', 'job-done']) expect(appendBusInbox(envelope(id), { root }).status).toBe('posted');
  const live = mutateBusWorkClaim({ action: 'acquire', id: 'job-live', owner: 'worker-a', leaseMs: 60_000, root });
  const done = mutateBusWorkClaim({ action: 'acquire', id: 'job-done', owner: 'worker-b', leaseMs: 60_000, root });
  expect([live.status, done.status]).toEqual(['acquired', 'acquired']);
  expect(mutateBusWorkClaim({ action: 'complete', id: 'job-done', token: done.token, root }).status).toBe('completed');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkState(['--from-claims', '--root', root])).toBe(0);
  const out = lines(log);
  expect(out).toHaveLength(2);
  expect(out.find(l => l.startsWith('job-live '))).toMatch(/^job-live RUNNING .*source=bus-claim-lease missing=none$/);
  expect(out.find(l => l.startsWith('job-done '))).toMatch(/^job-done ASSIGNED .*source=claim:bus-claim:job-done@\d+ missing=none$/);
  expect(out.join('\n')).not.toMatch(/VERIFIED|[a-f0-9]{64}/);
  log.mockClear();
  expect(await cmdFleetWorkState(['--from-claims', '--root', root, '--json'])).toBe(0);
  const parsed = JSON.parse(lines(log)[0]!);
  expect(parsed).toMatchObject({ source: 'available', items: [{ id: expect.any(String) }, { id: expect.any(String) }] });
  expect(typeof parsed.asOf).toBe('string');
});

it('a corrupt table exits 1 and is never printed as zero items', async () => {
  expect(appendBusInbox(envelope('job-x'), { root }).status).toBe('posted');
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'job-x', owner: 'worker-a', leaseMs: 60_000, root }).status).toBe('acquired');
  const file = join(root, 'bus-work-claims', 'claims.json');
  chmodSync(file, 0o600); writeFileSync(file, '{not json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetWorkState(['--from-claims', '--root', root])).toBe(1);
  expect(lines(err)).toEqual(['error: claims table unavailable']);
  expect(log).not.toHaveBeenCalled();
});

it('rejects bad flag combinations with exit 2', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetWorkState(['--from-claims', '--evidence', join(base, 'e.json')])).toBe(2);
  expect(await cmdFleetWorkState(['--from-claims', '--root', 'relative/dir'])).toBe(2);
  expect(await cmdFleetWorkState(['--evidence', join(base, 'e.json'), '--root', root])).toBe(2);
  expect(await cmdFleetWorkState([])).toBe(2);
  expect(err).toHaveBeenCalledTimes(4);
});
