import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { addIntent, updateIntent } from '../src/core/intent/ledger.js';
import { noteMergeSnapshot } from '../src/core/intent/merge-snapshot.js';
import { intentLedgerPath, readLedger, transactIntentLedger } from '../src/core/intent/store.js';

const at = '2026-11-10T00:00:00.000Z';

it('serializes snapshot observations with queued additions and edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-serial-'));
  let release!: () => void;
  try {
    const first = await addIntent({ title: 'First directive', source: 'fixture', rq: ['RQ-FAKE-1'], status: 'queued', now: at }, root);
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = transactIntentLedger(root, async ledger => {
      entered();
      await gate;
      ledger.items[0]!.owner = 'held-owner';
    });
    await ready;
    const added = addIntent({ title: 'Second directive', source: 'fixture', rq: ['RQ-FAKE-2'], status: 'in-progress', now: at }, root);
    const edited = updateIntent(first.id, { evidence: { ref: 'owner-note' }, now: at }, root);
    const snapshot = noteMergeSnapshot([
      { repo: 'fake/repo', number: 1, title: 'RQ-FAKE-1' },
      { repo: 'fake/repo', number: 2, title: 'RQ-FAKE-2' },
    ], root, at);
    const early = await Promise.race([snapshot.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    release();
    await Promise.all([held, added, edited, snapshot]);
    expect(early).toBe(false);
    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(2);
    expect(ledger.items[0]).toMatchObject({ owner: 'held-owner', status: 'merged' });
    expect(ledger.items[0]!.evidence.map(row => row.ref)).toEqual(['owner-note', 'fake/repo#1']);
    expect(ledger.items[1]).toMatchObject({ status: 'merged', evidence: [{ ref: 'fake/repo#2' }] });
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains bounded lists, deduplicates receipts, preserves statuses and rolls back rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-bounded-'));
  try {
    const item = await addIntent({ title: 'Bounded directive', source: 'fixture', rq: ['RQ-BOUND-1'], status: 'proposed', now: at }, root);
    await transactIntentLedger(root, ledger => {
      ledger.items[0]!.prs = Array.from({ length: 32 }, (_, i) => ({ repo: 'fake/repo', number: i + 1, state: 'merged' as const }));
    });
    const pulls = [
      { repo: 'Fake/Repo', number: 33, title: 'RQ-BOUND-1' },
      { repo: 'bad', number: 34, title: 'RQ-BOUND-1' },
      { repo: 'fake/repo', number: 0, title: 'RQ-BOUND-1' },
    ];
    await noteMergeSnapshot(pulls, root, at);
    await noteMergeSnapshot([{ ...pulls[0]!, repo: 'fake/repo' }], root, at);
    const saved = await readLedger(root);
    expect(saved.items[0]).toMatchObject({ status: 'proposed' });
    expect(saved.items[0]!.prs).toHaveLength(32);
    expect(saved.items[0]!.evidence.map(row => row.ref)).toEqual(['Fake/Repo#33']);
    const before = await readFile(intentLedgerPath(root));
    await expect(noteMergeSnapshot([{ repo: 'fake/repo', number: 34, title: 'RQ-BOUND-1' }], root, 'invalid')).rejects.toThrow();
    expect(await readFile(intentLedgerPath(root))).toEqual(before);
    await updateIntent(item.id, { owner: 'after-rejection', now: at }, root);
    expect((await readLedger(root)).items[0]!.owner).toBe('after-rejection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
