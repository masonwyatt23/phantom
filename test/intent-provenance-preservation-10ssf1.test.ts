import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { importIntentFiles } from '../src/core/intent/import.js';
import { INTENT_LEDGER_SCHEMA, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger } from '../src/core/intent/store.js';

it('preserves complete provenance and original ledger metadata across both import orders and replays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-preservation-'));
  const roots = [join(root, 'a'), join(root, 'b')];
  const at = '2026-10-01T00:00:00.000Z';
  const original: IntentItem = {
    id: 'directive', title: 'Directive', source: 'source', owner: 'owner', rq: ['RQ-PRESERVE-1'],
    prs: [{ repo: 'example/project', number: 7, state: 'merged' }], status: 'verified',
    evidence: [{ at, kind: 'verification', ref: 'check' }],
    provenance: [{ source: 'source', date: at, verbatim: true, partial: true }],
    partial: true, closureProposal: 'superseded', lastTouchedAt: at, staleAfterMs: 604800000,
    createdAt: at, updatedAt: at,
  };
  try {
    const files = [join(root, 'partial.json'), join(root, 'complete.json')];
    await writeFile(files[0]!, JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items: [original] }));
    await writeFile(files[1]!, JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items: [{ ...original, partial: false, provenance: [{ ...original.provenance[0], partial: false }] }] }));
    for (const [index, ledgerRoot] of roots.entries()) {
      const order = index === 0 ? files : [...files].reverse();
      for (const file of order) await importIntentFiles([file], { root: ledgerRoot, now: at });
      const item = (await readLedger(ledgerRoot)).items[0]!;
      expect(item.provenance).toEqual([{ source: 'source', date: at, verbatim: true, partial: false }]);
      expect(item.partial).toBe(true);
      expect(item.prs).toEqual(original.prs);
      expect(item.evidence).toEqual(original.evidence);
      expect(item.status).toBe(original.status);
      expect(item.owner).toBe(original.owner);
      expect(item.closureProposal).toBe(original.closureProposal);
      const persisted = await readFile(intentLedgerPath(ledgerRoot), 'utf8');
      await importIntentFiles(order, { root: ledgerRoot, now: '2026-10-02T00:00:00.000Z' });
      expect(await readFile(intentLedgerPath(ledgerRoot), 'utf8')).toBe(persisted);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
