/**
 * coord-computers-352.test.ts — RQ-PHX-COORDSTRIPCOMPUTERS352. The strip's
 * `Computers` row reports tailnet peers and is evidence only: it never moves
 * verdict, missing, exampleTask or lastVerified, and is not part of LOADING.
 */
import { describe, expect, it } from 'vitest';
import { formatRelative } from '../autonomy/format.js';
import type { ChannelHealthView } from '../fleet-channels/channel-health-model.js';
import type { RuntimeIdentityView } from '../fleet-host/runtime-identity-model.js';
import type { TailnetPeerRow, TailnetPeersView } from '../fleet-host/tailnet-peers-model.js';
import { deriveCoordAnswer, type CoordAnswerInput } from './coord-answer-model.js';

const NOW = Date.parse('2026-11-13T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const runtime: RuntimeIdentityView = {
  generatedAt: ago(1000), host: 'fake-mac-a', platform: 'darwin', asOf: ago(1000),
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  tailnetName: 'fake-mac-a.tailnet.fake', fleetState: { ageSeconds: 10, stale: false }, reasons: [],
};
const channels: ChannelHealthView = {
  available: true, asOf: ago(1000),
  channels: [{ channel: 'slack', configured: true, processAlive: true, runtimeHost: null, lastInboundAt: null, lastReplyAt: ago(1000), unansweredCount: 0, state: 'LIVE', missing: [] }],
};
const board = {
  inbox: 'ok', asOf: ago(1000),
  items: [
    { id: 'fake-task-1', state: 'RUNNING', channelRef: 'fake-team/fake-chan/1.2', receivedAt: ago(5000), asOf: ago(4000), owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-1:1:1' },
    { id: 'fake-task-0', state: 'VERIFIED', channelRef: null, receivedAt: ago(9000), asOf: ago(8000), owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-0:1:1' },
  ],
};
const peer = (name: string, online: TailnetPeerRow['online']): TailnetPeerRow =>
  ({ name, os: 'macOS', online, lastSeen: ago(1000), ageSeconds: 1 });
const view = (peers: TailnetPeerRow[], reasons: string[] = []): TailnetPeersView =>
  ({ asOf: ago(30_000), self: 'fake-mac-a', peers, dropped: 0, reasons });
const base: CoordAnswerInput = { runtime, channels, board, now: NOW };
const computers = (tailnet: CoordAnswerInput['tailnet']) =>
  deriveCoordAnswer({ ...base, tailnet }).rows.find((r) => r.label === 'Computers');
const asOf = `as of ${formatRelative(ago(30_000), NOW)}`;

describe('Computers row', () => {
  it('2 online + 1 offline', () => {
    expect(computers(view([peer('fake-mac-b', true), peer('fake-mac-c', true), peer('fake-mac-d', false)])))
      .toEqual({ label: 'Computers', value: `2 online · 1 offline · self fake-mac-a · ${asOf}`, ok: true });
  });
  it('0 peers is unknown', () => {
    expect(computers(view([]))).toEqual({ label: 'Computers', value: `0 online · 0 offline · self fake-mac-a · ${asOf}`, ok: 'unknown' });
  });
  it('all offline is false; unknown peers are counted', () => {
    expect(computers(view([peer('fake-mac-b', false), peer('fake-mac-c', 'unknown')])))
      .toEqual({ label: 'Computers', value: `0 online · 1 offline · 1 unknown · self fake-mac-a · ${asOf}`, ok: false });
  });
  it('undefined and null', () => {
    expect(computers(undefined)).toEqual({ label: 'Computers', value: 'unknown', ok: 'unknown' });
    expect(computers(null)).toEqual({ label: 'Computers', value: 'not on this build', ok: 'unknown' });
  });
  it('appends the first reason only', () => {
    expect(computers(view([peer('fake-mac-b', true)], ['fake-reason-1', 'fake-reason-2']))!.value)
      .toBe(`1 online · 0 offline · self fake-mac-a · ${asOf} · fake-reason-1`);
  });
  it('sits right after Runtime', () => {
    const labels = deriveCoordAnswer({ ...base, tailnet: null }).rows.map((r) => r.label);
    expect(labels.indexOf('Computers')).toBe(labels.indexOf('Runtime') + 1);
  });
});

describe('evidence only', () => {
  const tailnets: CoordAnswerInput['tailnet'][] = [
    undefined, null, view([]), view([peer('fake-mac-b', true)]), view([peer('fake-mac-b', false)], ['fake-reason-1']),
  ];
  const others: CoordAnswerInput[] = [
    base,
    { ...base, runtime: { ...runtime, fleetState: { ageSeconds: 9999, stale: true } } },
    { ...base, board: null },
    { ...base, channels: { available: false } },
    { ...base, runtime: undefined },
    { ...base, channels: undefined },
    { ...base, board: undefined },
  ];
  it('verdict/missing/exampleTask/lastVerified are identical with and without tailnet', () => {
    for (const input of others) {
      const ref = deriveCoordAnswer({ ...input, tailnet: undefined });
      for (const tailnet of tailnets) {
        const got = deriveCoordAnswer({ ...input, tailnet });
        expect(got.verdict).toBe(ref.verdict);
        expect(got.missing).toEqual(ref.missing);
        expect(got.exampleTask).toEqual(ref.exampleTask);
        expect(got.lastVerified).toEqual(ref.lastVerified);
      }
    }
  });
  it('tailnet undefined does not cause LOADING when the other three inputs are settled', () => {
    expect(deriveCoordAnswer({ ...base, tailnet: undefined }).verdict).toBe('REACHABLE');
  });
});
