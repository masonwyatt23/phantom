import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteShippedRelease } from '../src/core/intent/release.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const first = '2026-11-01T00:00:00.000Z';
const later = '2026-11-02T00:00:00.000Z';
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

function item(id: string, status: IntentItem['status'] = 'merged'): IntentItem {
  return {
    id, title: id, source: 'fixture', owner: 'fixture', rq: ['RQ-SHARED-1'], prs: [], status,
    evidence: Array.from({ length: 30 }, (_, i) => ({ at: first, kind: i % 2 ? 'release' : 'pr', ref: `old-${i}` })),
    provenance: [], partial: false, closureProposal: null, lastTouchedAt: first,
    staleAfterMs: 1000, createdAt: first, updatedAt: first,
  };
}

it('retains distinct receipts and timestamps across retries, including newly matching directives', async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-retention-'));
  await writeLedger({ ...emptyLedger(), items: [item('work'), item('verified', 'verified'), item('closed', 'closed')] }, root);
  const release = { release: '  fake\nrelease  ', rq: ['RQ-SHARED-1'] };
  const matches = [{ id: 'work', status: 'shipped' }, { id: 'verified', status: 'verified' }, { id: 'closed', status: 'closed' }];
  expect(await noteShippedRelease(release, { root, now: first })).toEqual({ updated: 3, matches });
  const snapshot = await readFile(intentLedgerPath(root), 'utf8');
  const initial = await readLedger(root);
  expect(initial.items[0]!.evidence).toHaveLength(31);
  expect(initial.items[0]!.evidence.at(-1)).toEqual({ at: first, kind: 'release', ref: 'fake release' });
  for (let i = 0; i < 40; i++) {
    expect(await noteShippedRelease({ ...release, release: 'fake release' }, { root, now: later })).toEqual({ updated: 3, matches });
  }
  expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(snapshot);
  const ledger = await readLedger(root);
  ledger.items.push(item('new'));
  await writeLedger(ledger, root);
  expect((await noteShippedRelease(release, { root, now: later })).updated).toBe(4);
  const after = await readLedger(root);
  expect(after.items.slice(0, 3)).toEqual(initial.items);
  expect(after.items[3]!.evidence.at(-1)).toEqual({ at: later, kind: 'release', ref: 'fake release' });
  await noteShippedRelease({ release: 'another', rq: ['RQ-SHARED-1'] }, { root, now: later });
  const different = await readLedger(root);
  expect(different.items[0]!.evidence).toEqual([...initial.items[0]!.evidence, { at: later, kind: 'release', ref: 'another' }]);
  const bytes = await readFile(intentLedgerPath(root), 'utf8');
  expect(await noteShippedRelease({ release: 'none', rq: ['RQ-OTHER-1'] }, { root, now: later })).toEqual({ updated: 0, matches: [] });
  await expect(noteShippedRelease({ release: '  ', rq: ['RQ-SHARED-1'] }, { root, now: later })).rejects.toThrow();
  await expect(noteShippedRelease(release, { root, now: 'invalid' })).rejects.toThrow();
  expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
});
