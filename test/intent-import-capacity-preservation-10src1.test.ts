import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importIntentFiles } from '../src/core/intent/import.js';
import {
  DEFAULT_STALE_AFTER_MS,
  INTENT_LEDGER_SCHEMA,
  IntentError,
  MAX_EVIDENCE,
  MAX_PROVENANCE,
  MAX_PRS,
  type IntentEvidence,
  type IntentItem,
  type IntentLedger,
  type IntentProvenance,
  type IntentPull,
} from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-10-01T00:00:00.000Z';
const now = '2026-10-02T00:00:00.000Z';
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'intent-capacity-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function item(id: string, rq: string[], overrides: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Capacity directive ${id}`, source: `source-${id}`, owner: 'owner', rq,
    prs: [], status: 'queued', evidence: [], provenance: [], partial: false,
    closureProposal: null, lastTouchedAt: at, staleAfterMs: DEFAULT_STALE_AFTER_MS,
    createdAt: at, updatedAt: at, ...overrides,
  };
}

function pulls(count: number): IntentPull[] {
  return Array.from({ length: count }, (_, i) => ({ repo: 'example/project', number: i + 1, state: 'open' as const }));
}

function evidenceRows(count: number): IntentEvidence[] {
  return Array.from({ length: count }, (_, i) => ({ at, kind: 'note' as const, ref: `e-${i}` }));
}

function provenanceRows(count: number): IntentProvenance[] {
  return Array.from({ length: count }, (_, i) => ({ source: `p-${i}`, date: at, verbatim: false, partial: false }));
}

function ledgerOf(...items: IntentItem[]): IntentLedger {
  return { schema: INTENT_LEDGER_SCHEMA, items };
}

async function writeNative(name: string, ledger: IntentLedger): Promise<string> {
  const file = join(root, name);
  await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return file;
}

async function seed(...items: IntentItem[]): Promise<string> {
  await writeLedger(ledgerOf(...items), root);
  return readFile(intentLedgerPath(root), 'utf8');
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('The import should have been refused.');
}

describe('intent import capacity preservation', () => {
  it('refuses one distinct PR beyond MAX_PRS and leaves the persisted ledger untouched', async () => {
    const existing = item('full', ['RQ-CAP-1'], { prs: pulls(MAX_PRS) });
    const original = await seed(existing);
    const incoming = item('incoming', ['RQ-CAP-1'], {
      prs: [
        { repo: 'example/project', number: 1, state: 'merged' },
        { repo: 'example/project', number: MAX_PRS + 1, state: 'open' },
      ],
    });
    const file = await writeNative('overflow-prs.json', ledgerOf(incoming));
    const failure = await failureOf(importIntentFiles([file], { root, now }));
    expect(failure).toBeInstanceOf(IntentError);
    expect(failure.message).toContain(`${MAX_PRS} linked PRs`);
    expect(failure.message).not.toContain('example/project');
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(original);
    expect((await readLedger(root)).items).toEqual([existing]);
  });

  it('refuses one distinct evidence entry beyond MAX_EVIDENCE without losing rows', async () => {
    const rows = evidenceRows(MAX_EVIDENCE);
    const existing = item('full', ['RQ-CAP-2'], { evidence: rows });
    const original = await seed(existing);
    const incoming = item('incoming', ['RQ-CAP-2'], {
      evidence: [{ ...rows[0]! }, { at: now, kind: 'verification', ref: 'e-new' }],
    });
    const file = await writeNative('overflow-evidence.json', ledgerOf(incoming));
    const failure = await failureOf(importIntentFiles([file], { root, now }));
    expect(failure).toBeInstanceOf(IntentError);
    expect(failure.message).toContain(`${MAX_EVIDENCE} evidence entries`);
    expect(failure.message).not.toContain('e-new');
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(original);
    expect((await readLedger(root)).items).toEqual([existing]);
  });

  it('refuses one distinct provenance entry beyond MAX_PROVENANCE without losing rows', async () => {
    const rows = provenanceRows(MAX_PROVENANCE);
    const existing = item('full', ['RQ-CAP-3'], { provenance: rows });
    const original = await seed(existing);
    const incoming = item('incoming', ['RQ-CAP-3'], {
      provenance: [{ ...rows[0]! }, { source: 'p-new', date: now, verbatim: false, partial: false }],
    });
    const file = await writeNative('overflow-provenance.json', ledgerOf(incoming));
    const failure = await failureOf(importIntentFiles([file], { root, now }));
    expect(failure).toBeInstanceOf(IntentError);
    expect(failure.message).toContain(`${MAX_PROVENANCE} provenance entries`);
    expect(failure.message).not.toContain('p-new');
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(original);
    expect((await readLedger(root)).items).toEqual([existing]);
  });

  it('merges exact duplicate rows at capacity, keeps every row and stays idempotent', async () => {
    const existing = item('full', ['RQ-CAP-4'], {
      prs: pulls(MAX_PRS), evidence: evidenceRows(MAX_EVIDENCE), provenance: provenanceRows(MAX_PROVENANCE),
    });
    await seed(existing);
    const incoming = item('incoming', ['RQ-CAP-4'], {
      prs: [{ repo: 'example/project', number: 1, state: 'merged', url: 'https://example.test/pr/1' }],
      evidence: [{ ...existing.evidence[0]! }],
      provenance: [{ ...existing.provenance[0]! }],
    });
    const file = await writeNative('duplicates.json', ledgerOf(incoming));
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 0, deduped: 1, items: 1 });
    const merged = (await readLedger(root)).items[0]!;
    expect(merged.prs).toEqual([
      { repo: 'example/project', number: 1, state: 'merged', url: 'https://example.test/pr/1' },
      ...existing.prs.slice(1),
    ]);
    expect(merged.evidence).toEqual(existing.evidence);
    expect(merged.provenance).toEqual(existing.provenance);
    const persisted = await readFile(intentLedgerPath(root), 'utf8');
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 0, deduped: 1, items: 1 });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(persisted);
  });

  it('leaves every original byte when a valid earlier file precedes an overflowing one', async () => {
    const existing = item('full', ['RQ-CAP-5'], { prs: pulls(MAX_PRS) });
    const original = await seed(existing);
    const valid = await writeNative('valid.json', ledgerOf(item('fresh', ['RQ-FRESH-1'])));
    const overflow = await writeNative('overflow.json', ledgerOf(item('late', ['RQ-CAP-5'], {
      prs: [{ repo: 'example/project', number: MAX_PRS + 1, state: 'merged' }],
    })));
    const failure = await failureOf(importIntentFiles([valid, overflow], { root, now }));
    expect(failure).toBeInstanceOf(IntentError);
    expect(failure.message).toContain(`${MAX_PRS} linked PRs`);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(original);
    expect((await readLedger(root)).items).toEqual([existing]);
  });

  it('keeps both matching directives when joining them would overflow capacity', async () => {
    const first = item('first', ['RQ-JOIN-1'], { prs: pulls(MAX_PRS) });
    const second = item('second', ['RQ-JOIN-2'], {
      prs: [{ repo: 'example/project', number: 77, state: 'merged' }],
    });
    const original = await seed(first, second);
    const bridge = item('bridge', ['RQ-JOIN-1', 'RQ-JOIN-2']);
    const file = await writeNative('bridge.json', ledgerOf(bridge));
    const failure = await failureOf(importIntentFiles([file], { root, now }));
    expect(failure).toBeInstanceOf(IntentError);
    expect(failure.message).toContain(`${MAX_PRS} linked PRs`);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(original);
    expect((await readLedger(root)).items).toEqual([first, second]);
  });
});
