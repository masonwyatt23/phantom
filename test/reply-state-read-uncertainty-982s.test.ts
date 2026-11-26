import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { readReplyState } from '../src/core/comms/reply-state.js';

let root: string;
const now = Date.parse('2026-11-12T22:29:00Z');
const files = {
  inbox: ['bus-inbox', 'messages.json'],
  claims: ['bus-work-claims', 'claims.json'],
  coordination: ['coordination', 'claims.json'],
} as const;
const labels = { inbox: 'bus inbox', claims: 'work claims', coordination: 'coordination lease evidence' } as const;
const read = () => readReplyState('fake-request', { root, now });
const corrupt = (source: keyof typeof files) => {
  const [dir, file] = files[source];
  mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, dir, file), 'invalid fake store', { mode: 0o600 });
};
const post = () => expect(appendBusInbox({ id: 'fake-request', from: 'fake-peer', to: 'fake-lane',
  priority: 'P2', ttl: 10_000_000, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-uncertainty-'));
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each(['inbox', 'claims', 'coordination'] as const)('discloses an unavailable %s independently', source => {
  post();
  corrupt(source);
  const result = read();
  expect(result.records[source]).toBe('unavailable');
  expect(result.state).toBe('RECEIVED');
  expect(result.owner).toBeNull();
  expect(result.evidence.blocked).toBeNull();
  expect(result.text).toContain(`Evidence could not be read: ${labels[source]}; ownership and current execution cannot be fully corroborated.`);
  for (const other of Object.keys(labels) as (keyof typeof labels)[]) {
    if (other !== source) expect(result.text).not.toContain(labels[other]);
  }
  expect(result.text).not.toContain('invalid fake store');
});

it('lists multiple unavailable sources once in stable order', () => {
  for (const source of ['inbox', 'claims', 'coordination'] as const) corrupt(source);
  const result = read();
  expect(result.records).toEqual({ inbox: 'unavailable', claims: 'unavailable', coordination: 'unavailable' });
  expect(result.text.split('\n').at(-1)).toBe('Evidence could not be read: bus inbox, work claims, coordination lease evidence; ownership and current execution cannot be fully corroborated.');
  expect(read()).toEqual(result);
});

it('retains recorded ownership and running evidence when coordination cannot be read', () => {
  post();
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'fake-request', owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
  corrupt('coordination');
  const result = read();
  expect(result).toMatchObject({ state: 'RUNNING', owner: 'fake-owner', records: {
    inbox: 'found', claims: 'available', coordination: 'unavailable' }, evidence: { blocked: null } });
  expect(result.claim).toContain('bus-claim:fake-request');
  expect(result.evidence.running).not.toBeNull();
  expect(result.text).toContain('owner fake-owner, claim bus-claim:fake-request');
  expect(result.text).toContain('Evidence could not be read: coordination lease evidence;');
});

it('does not warn for healthy or genuinely missing sources', () => {
  const absent = read();
  expect(absent.records).toEqual({ inbox: 'missing', claims: 'missing', coordination: 'missing' });
  expect(absent.text).not.toContain('Evidence could not be read');
  post();
  const healthy = read();
  expect(healthy.records).toEqual({ inbox: 'found', claims: 'missing', coordination: 'missing' });
  expect(healthy.text).not.toContain('Evidence could not be read');
});
