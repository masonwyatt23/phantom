import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { noteMergeSnapshot } from '../src/core/intent/merge-snapshot.js';
import { emptyLedger, MAX_PRS, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const old = '2026-01-01T00:00:00.000Z';
const now = '2026-01-02T00:00:00.000Z';
const receipt = { at: old, kind: 'pr' as const, ref: 'FAKE/Repo#42', note: 'retained' };
const pull = { repo: 'fake/repo', number: 42, title: 'RQ-TEST-1 synthetic', url: 'https://example.test/pull/42' };

function item(id: string, overrides: Partial<IntentItem> = {}): IntentItem {
  return { id, title: 'Synthetic directive', source: 'fixture', owner: 'fixture', rq: ['RQ-TEST-1'], prs: [], status: 'queued', evidence: [receipt], provenance: [{ source: 'fixture', date: old, verbatim: true, partial: false }], partial: false, closureProposal: null, lastTouchedAt: old, staleAfterMs: 1000, createdAt: old, updatedAt: old, ...overrides };
}

it('repairs retained receipts without losing metadata, evicting evidence, or rewriting a replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-receipt-'));
  try {
    const full = Array.from({ length: MAX_PRS }, (_, i) => ({ repo: 'fake/other', number: i + 1, state: 'open' as const }));
    const ledger = emptyLedger();
    ledger.items = [
      item('open', { prs: [{ repo: 'FAKE/REPO', number: 42, state: 'open' }] }),
      item('missing', { status: 'unknown' }),
      item('terminal', { status: 'verified', prs: [{ repo: 'fake/repo', number: 42, state: 'unknown', url: 'https://example.test/original' }] }),
      item('cap', { prs: full, status: 'proposed' }),
      item('unrelated', { rq: ['RQ-OTHER-1'] }),
      item('fresh', { evidence: [], status: 'in-progress' }),
    ];
    await writeLedger(ledger, root);
    await noteMergeSnapshot([pull], root, now);
    const result = (await readLedger(root)).items;
    expect(result[0]!.prs).toEqual([{ repo: 'FAKE/REPO', number: 42, state: 'merged', url: pull.url }]);
    expect(result[0]!.status).toBe('merged');
    expect(result[0]!.evidence).toEqual([receipt]);
    expect(result[0]!.provenance).toEqual(ledger.items[0]!.provenance);
    expect(result[1]!.prs).toEqual([{ repo: pull.repo, number: 42, state: 'merged', url: pull.url }]);
    expect(result[1]!.status).toBe('unknown');
    expect(result[2]!.status).toBe('verified');
    expect(result[2]!.prs[0]).toEqual({ repo: 'fake/repo', number: 42, state: 'merged', url: 'https://example.test/original' });
    expect(result[3]).toEqual(ledger.items[3]);
    expect(result[4]).toEqual(ledger.items[4]);
    expect(result[5]!.status).toBe('merged');
    expect(result[5]!.evidence).toEqual([{ at: now, kind: 'pr', ref: 'fake/repo#42' }]);
    expect(result[5]!.prs).toEqual([{ repo: pull.repo, number: 42, state: 'merged', url: pull.url }]);
    expect(result[0]!.updatedAt).toBe(now);
    expect(result[0]!.lastTouchedAt).toBe(now);
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    await noteMergeSnapshot([pull], root, '2026-01-03T00:00:00.000Z');
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
    expect((await readLedger(root)).items).toEqual(result);
  } finally { await rm(root, { recursive: true, force: true }); }
});
