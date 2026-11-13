/**
 * RQ-PHX-BUSPROTOCOLOWNER307S — owner-parity qualification for PR #5101
 * (RQ-PHX-BUSPROTOCOLEXACT160, head cd105c15b833369cdefe805b28a8a717645ad6c2).
 *
 * The owner suites test/bus-protocol-exact-160.test.ts and
 * test/bus-protocol-salvage-140.test.ts already landed on master (the salvage
 * file semantically identical; the exact file with one corrected assertion —
 * see BRIDGE_NOTES.md). This file adds only the cross-path invariants those
 * suites and the current tests do not execute: real
 * appendBusInbox/listBusInboxAfter/claimNextBusWork/mutateBusWorkClaim calls
 * against a temporary root, no mocks and no source-string proof.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNextBusWork } from '../src/core/fleet/bus-next-claim.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { protocolOf } from '../src/core/fleet/bus-protocol.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-owner-parity-307s-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const envelope = (id: string, to: string, body: unknown, priority: 'P0' | 'P1' | 'P2' | 'P3' = 'P2') =>
  ({ id, from: 'fake-owner', to, priority, ttl: 120_000, body });
const protocolTask = (id: string, to: string, extra: Record<string, unknown> = {}, priority?: 'P0' | 'P1' | 'P2' | 'P3') =>
  envelope(id, to, { protocol: { version: 1, kind: 'task', topic: to, ...extra } }, priority);
const post = (input: unknown) => appendBusInbox(input, { root });
const claim = (to: string, owner: string) =>
  claimNextBusWork({ to, owner, leaseMs: 60_000, root });
const acquiredId = (result: ReturnType<typeof claim>) => {
  if (result.status !== 'acquired' || !('receipt' in result)) throw new Error(`expected a claim, got ${result.status}`);
  return result.receipt.envelope.id;
};

it('orders protocol tasks and legacy work on one label by the same priority rule', () => {
  // isClaimableWork has two branches (protocol kind 'task', legacy kind
  // 'work'); claimNextBusWork must rank both through one priority+cursor sort.
  // No owner or current suite mixes the two conventions at different
  // priorities on a single `to` label.
  expect(post(protocolTask('fake-mixed-task-low', 'fleet.mixed', {}, 'P1')).status).toBe('posted');
  expect(post(envelope('fake-mixed-legacy-high', 'fleet.mixed', { kind: 'work' }, 'P0')).status).toBe('posted');
  const first = claim('fleet.mixed', 'fake-a');
  expect(first.status).toBe('acquired');
  expect(acquiredId(first)).toBe('fake-mixed-legacy-high');
  const second = claim('fleet.mixed', 'fake-b');
  expect(second.status).toBe('acquired');
  expect(acquiredId(second)).toBe('fake-mixed-task-low');
  expect(claim('fleet.mixed', 'fake-c')).toEqual({ status: 'empty' });

  // The reverse pairing proves the sort is by priority, not by convention:
  // a P0 protocol task outranks a P1 legacy work item.
  expect(post(protocolTask('fake-mixed-task-high', 'fleet.reverse', {}, 'P0')).status).toBe('posted');
  expect(post(envelope('fake-mixed-legacy-low', 'fleet.reverse', { kind: 'work' }, 'P1')).status).toBe('posted');
  expect(acquiredId(claim('fleet.reverse', 'fake-d'))).toBe('fake-mixed-task-high');
  expect(acquiredId(claim('fleet.reverse', 'fake-e'))).toBe('fake-mixed-legacy-low');
});

it('keeps the opaque payload ref intact on the receipt a second claimant receives after release', () => {
  // exact-160 proves release issues a fresh token and fences the old one, and
  // salvage-140 proves the stored body is verbatim — but no suite reads the
  // re-claimed receipt's body. The ref must stay opaque across the whole
  // claim -> release -> re-claim path, never resolved or rewritten.
  const ref = 'artifact:fake/owner-parity-307s/blob.bin';
  const posted = protocolTask('fake-reclaim', 'fleet.reclaim', { payload_ref: ref });
  (posted.body as Record<string, unknown>).text = 'fake bounded ref';
  expect(post(posted).status).toBe('posted');
  const first = claim('fleet.reclaim', 'fake-a');
  expect(first.status).toBe('acquired');
  if (first.status !== 'acquired' || !('token' in first)) throw new Error('expected a claim');
  expect(mutateBusWorkClaim({ action: 'release', id: 'fake-reclaim', token: first.token, root }))
    .toMatchObject({ status: 'released' });
  const second = claim('fleet.reclaim', 'fake-b');
  expect(second.status).toBe('acquired');
  if (second.status !== 'acquired' || !('receipt' in second) || !('token' in second)) {
    throw new Error('expected a re-claim');
  }
  expect(second.token).not.toBe(first.token);
  expect(second.receipt.envelope.id).toBe('fake-reclaim');
  // The second claimant sees the identical opaque protocol block; the bus
  // never fetches, expands or strips the reference.
  expect(protocolOf(second.receipt.envelope.body)).toEqual({
    version: 1, kind: 'task', topic: 'fleet.reclaim', payload_ref: ref,
  });
  expect(second.receipt.envelope.body).toMatchObject({ text: 'fake bounded ref' });
  // And the first claimant's token is still fenced after the handoff.
  expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-reclaim', token: first.token, root }))
    .toMatchObject({ status: 'mismatched-token' });
  expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-reclaim', token: second.token, root }))
    .toMatchObject({ status: 'completed' });
});

it('admits the next protocol task on a topic after the previous one completes', () => {
  // Completion tombstones are per message ID: finishing one protocol task
  // must not retire the topic. exact-160 completes its task but never posts
  // a successor; fleet-bus-next-claim proves this only for legacy work.
  expect(post(protocolTask('fake-seq-1', 'fleet.seq')).status).toBe('posted');
  const first = claim('fleet.seq', 'fake-a');
  expect(first.status).toBe('acquired');
  if (first.status !== 'acquired' || !('token' in first)) throw new Error('expected a claim');
  expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-seq-1', token: first.token, root }))
    .toMatchObject({ status: 'completed' });
  expect(post(protocolTask('fake-seq-2', 'fleet.seq')).status).toBe('posted');
  const second = claim('fleet.seq', 'fake-b');
  expect(second.status).toBe('acquired');
  expect(acquiredId(second)).toBe('fake-seq-2');
  // The completed ID stays fenced: it cannot be claimed or re-completed.
  expect(claim('fleet.seq', 'fake-c')).toEqual({ status: 'empty' });
});
