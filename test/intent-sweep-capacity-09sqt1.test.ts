import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyLedger, IntentError, MAX_EVIDENCE, type IntentEvidence, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';
import { sweepStale } from '../src/core/intent/sweep.js';

const start = '2026-11-01T00:00:00.000Z';
const first = '2026-11-01T00:00:02.000Z';
const second = '2026-11-01T00:00:04.000Z';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function item(id: string, evidence: IntentEvidence[] = []): IntentItem {
  return { id, title: `Fake ${id}`, source: 'fake source', owner: 'owner', rq: ['RQ-FAKE-1'], prs: [], status: 'in-progress',
    evidence, provenance: [{ source: 'fake source', date: start, verbatim: true, partial: false }], partial: false,
    closureProposal: null, lastTouchedAt: start, staleAfterMs: 1000, createdAt: start, updatedAt: start };
}

function evidence(count: number): IntentEvidence[] {
  const kinds = ['pr', 'release', 'verification', 'import', 'note'] as const;
  return Array.from({ length: count }, (_, index) => ({ at: start, kind: kinds[index % kinds.length]!, ref: `fake-${index}`, note: `retained ${index}` }));
}

it('refuses a late full directive atomically and permits a read-only preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-capacity-')); roots.push(root);
  const items = [item('earlier', evidence(1)), item('full', evidence(MAX_EVIDENCE))];
  await writeLedger({ ...emptyLedger(), items }, root);
  const path = intentLedgerPath(root);
  const before = await readFile(path);
  expect((await sweepStale({ root, now: first })).stale.map(row => row.id)).toEqual(['earlier', 'full']);
  expect(await readFile(path)).toEqual(before);
  await expect(sweepStale({ root, now: first, apply: true })).rejects.toThrow(IntentError);
  await expect(sweepStale({ root, now: first, apply: true })).rejects.toThrow(/full.*capacity/i);
  expect(await readFile(path)).toEqual(before);
  expect((await readLedger(root)).items).toEqual(items);
});

it('uses the last slot, retains matching recommendations, and preserves transitions and terminal records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-capacity-')); roots.push(root);
  const room = item('room', evidence(MAX_EVIDENCE - 1));
  const merged = { ...item('merged', evidence(MAX_EVIDENCE - 1)), status: 'merged' as const };
  const terminal = { ...item('terminal', evidence(MAX_EVIDENCE)), status: 'verified' as const };
  await writeLedger({ ...emptyLedger(), items: [room, merged, terminal] }, root);
  const result = await sweepStale({ root, now: first, apply: true });
  expect(result.stale.map(row => [row.id, row.status, row.action])).toEqual([
    ['room', 'queued', 'requeue'], ['merged', 'merged', 'await-verification'],
  ]);
  let saved = await readLedger(root);
  expect(saved.items[0]!.evidence.slice(0, -1)).toEqual(room.evidence);
  expect(saved.items[1]!.evidence.slice(0, -1)).toEqual(merged.evidence);
  expect(saved.items[2]).toEqual(terminal);
  // Requeue now recommends supersession and cannot fit; the merged duplicate must not hide that failure.
  const path = intentLedgerPath(root);
  const before = await readFile(path);
  await expect(sweepStale({ root, now: second, apply: true })).rejects.toThrow(/room.*capacity/i);
  expect(await readFile(path)).toEqual(before);
  // Isolate the merged record to exercise repeated identical recommendations at capacity.
  await writeLedger({ ...emptyLedger(), items: [saved.items[1]!, terminal] }, root);
  for (const now of [second, '2026-11-01T00:00:06.000Z']) {
    expect((await sweepStale({ root, now, apply: true })).stale[0]).toMatchObject({ action: 'await-verification', status: 'merged' });
  }
  saved = await readLedger(root);
  expect(saved.items[0]!.evidence).toEqual([...merged.evidence, { at: first, kind: 'sweep', ref: 'await-verification', note: 'Local stale tracking refreshed; no job dispatched.' }]);
  expect(saved.items[0]!.provenance).toEqual(merged.provenance);
  expect(saved.items[0]!.lastTouchedAt).toBe('2026-11-01T00:00:06.000Z');
  expect(saved.items[2]).toBeUndefined();
  expect(saved.items[1]).toEqual(terminal);
});
