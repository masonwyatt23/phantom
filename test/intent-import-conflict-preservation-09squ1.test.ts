import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importIntentFiles } from '../src/core/intent/import.js';
import {
  INTENT_LEDGER_SCHEMA, MAX_EVIDENCE, MAX_PRS, MAX_PROVENANCE,
  type IntentItem,
} from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-10-01T00:00:00.000Z';
const later = '2026-10-15T00:00:00.000Z';
const now = '2026-11-10T00:00:00.000Z';
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'intent-conflict-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function item(id: string, rq: string[], overrides: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Directive ${id}`, source: `source-${id}`, owner: 'owner', rq, prs: [],
    status: 'queued', evidence: [],
    provenance: [{ source: `source-${id}`, date: at, verbatim: false, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: at,
    staleAfterMs: 604800000, createdAt: at, updatedAt: at,
    ...overrides,
  };
}

async function seed(...items: IntentItem[]): Promise<void> {
  await writeLedger({ schema: INTENT_LEDGER_SCHEMA, items }, root);
}

async function writeNative(name: string, items: IntentItem[]): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items })}\n`);
  return path;
}

const ledgerBytes = () => readFile(intentLedgerPath(root), 'utf8');

describe('import conflict preservation (PR #4235 qualification)', () => {
  it('merges an overlapping native item losslessly across different ids', async () => {
    const retained = item('retained', ['RQ-CARRY-1'], {
      prs: [{ repo: 'Example/One', number: 3, state: 'open' }],
      status: 'merged',
      evidence: [{ at, kind: 'verification', ref: 'kept-check' }],
      provenance: [{ source: 'retained-lane', date: at, verbatim: true, partial: false }],
    });
    const incoming = item('incoming', ['RQ-CARRY-1', 'RQ-CARRY-2'], {
      prs: [
        { repo: 'example/one', number: 3, state: 'merged', url: 'https://example.test/pulls/3' },
        { repo: 'example/two', number: 9, state: 'open' },
      ],
      status: 'queued',
      evidence: [
        { at: later, kind: 'pr', ref: 'example/two#9' },
        { at: later, kind: 'note', ref: 'second-ledger-copy' },
      ],
      provenance: [{ source: 'incoming-ledger', date: later, verbatim: true, partial: true }],
      partial: true,
      lastTouchedAt: later,
    });
    await seed(retained, item('unrelated', ['RQ-OTHER-1']));
    const file = await writeNative('overlap.json', [incoming]);
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 0, deduped: 1, items: 2 });
    const items = (await readLedger(root)).items;
    const merged = items.find((row) => row.id === 'retained')!;
    expect(merged).toMatchObject({
      id: 'retained', rq: ['RQ-CARRY-1', 'RQ-CARRY-2'], status: 'merged',
      prs: [
        { repo: 'Example/One', number: 3, state: 'merged', url: 'https://example.test/pulls/3' },
        { repo: 'example/two', number: 9, state: 'open' },
      ],
      evidence: [
        { at, kind: 'verification', ref: 'kept-check' },
        { at: later, kind: 'pr', ref: 'example/two#9' },
        { at: later, kind: 'note', ref: 'second-ledger-copy' },
      ],
      provenance: [
        { source: 'retained-lane', date: at, verbatim: true, partial: false },
        { source: 'incoming-ledger', date: later, verbatim: true, partial: true },
      ],
      partial: true, lastTouchedAt: later, createdAt: at, updatedAt: now,
    });
    expect(items.find((row) => row.id === 'unrelated')).toBeDefined();
    expect(items.some((row) => row.id === 'incoming')).toBe(false);
  });

  it('replays an overlapping native import byte-identically', async () => {
    await seed(item('retained', ['RQ-RE-1'], {
      status: 'in-progress',
      evidence: [{ at, kind: 'note', ref: 'first-copy' }],
    }));
    const file = await writeNative('again.json', [item('second-copy', ['RQ-RE-1'], {
      status: 'queued',
      evidence: [{ at: later, kind: 'verification', ref: 'fresh-check' }],
      provenance: [{ source: 'second-ledger', date: later, verbatim: true, partial: false }],
    })]);
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 0, deduped: 1, items: 1 });
    const persisted = await ledgerBytes();
    expect(await importIntentFiles([file], { root, now: '2026-11-11T00:00:00.000Z' })).toEqual({ imported: 0, deduped: 1, items: 1 });
    expect(await ledgerBytes()).toBe(persisted);
    const merged = (await readLedger(root)).items[0]!;
    expect(merged.evidence).toHaveLength(2);
    expect(merged.provenance.map((row) => row.source)).toEqual(['source-retained', 'second-ledger']);
  });

  it('rejects an import that would drop retained evidence rows past the cap', async () => {
    const kept = Array.from({ length: MAX_EVIDENCE - 1 }, (_, i) => ({ at, kind: 'note' as const, ref: `kept-${i}` }));
    await seed(item('full', ['RQ-FULL-1'], { evidence: kept }));
    const before = await ledgerBytes();
    const file = await writeNative('overflow.json', [item('other-copy', ['RQ-FULL-1'], {
      evidence: [
        { at, kind: 'note', ref: 'kept-0' },
        { at: later, kind: 'note', ref: 'extra-a' },
        { at: later, kind: 'note', ref: 'extra-b' },
      ],
    })]);
    await expect(importIntentFiles([file], { root, now })).rejects.toThrow(/evidence/);
    expect(await ledgerBytes()).toBe(before);
    expect((await readLedger(root)).items[0]!.evidence).toEqual(kept);
  });

  it('merges known pulls at the cap, then rejects a new pull link instead of dropping it', async () => {
    const full = Array.from({ length: MAX_PRS }, (_, i) => ({ repo: 'example/ledger', number: i + 1, state: 'open' as const }));
    await seed(item('linked', ['RQ-LINK-1'], { prs: full }));
    const upgrades = await writeNative('upgrades.json', [item('same-pulls', ['RQ-LINK-1'], {
      prs: [{ repo: 'EXAMPLE/ledger', number: 1, state: 'merged', url: 'https://example.test/pulls/1' }],
    })]);
    expect(await importIntentFiles([upgrades], { root, now })).toEqual({ imported: 0, deduped: 1, items: 1 });
    expect((await readLedger(root)).items[0]!.prs[0]).toMatchObject({
      repo: 'example/ledger', number: 1, state: 'merged', url: 'https://example.test/pulls/1',
    });
    const before = await ledgerBytes();
    const blocked = await writeNative('blocked.json', [item('new-pull', ['RQ-LINK-1'], {
      prs: [{ repo: 'example/ledger', number: 99, state: 'open' }],
    })]);
    await expect(importIntentFiles([blocked], { root, now })).rejects.toThrow(/pull/);
    expect(await ledgerBytes()).toBe(before);
  });

  it('rejects an import that would push provenance past the cap', async () => {
    const provenance = Array.from({ length: MAX_PROVENANCE }, (_, i) => ({
      source: `lane-${i}`, date: at, verbatim: false, partial: false,
    }));
    await seed(item('storied', ['RQ-STORY-1'], { provenance }));
    const before = await ledgerBytes();
    const file = await writeNative('one-more.json', [item('one-more', ['RQ-STORY-1'], {
      provenance: [{ source: 'lane-new', date: later, verbatim: true, partial: false }],
    })]);
    await expect(importIntentFiles([file], { root, now })).rejects.toThrow(/provenance/);
    expect(await ledgerBytes()).toBe(before);
  });

  it('leaves the ledger byte-identical when a later file in the batch conflicts at capacity', async () => {
    const kept = Array.from({ length: MAX_EVIDENCE }, (_, i) => ({ at, kind: 'note' as const, ref: `row-${i}` }));
    await seed(item('full', ['RQ-FULL-1'], { evidence: kept }));
    const before = await ledgerBytes();
    const ok = await writeNative('ok.json', [item('clean', ['RQ-CLEAN-1'])]);
    const conflict = await writeNative('conflict.json', [item('conflict', ['RQ-FULL-1'], {
      evidence: [{ at: later, kind: 'verification', ref: 'one-too-many' }],
    })]);
    await expect(importIntentFiles([ok, conflict], { root, now })).rejects.toThrow(/evidence/);
    expect(await ledgerBytes()).toBe(before);
    expect(await importIntentFiles([ok], { root, now })).toEqual({ imported: 1, deduped: 0, items: 2 });
  });

  it('rejects an RQ union past the key cap and leaves bytes identical', async () => {
    const many = Array.from({ length: 15 }, (_, i) => `RQ-HELD-${i}`);
    await seed(item('wide', many));
    const before = await ledgerBytes();
    const file = await writeNative('wider.json', [item('wider', ['RQ-HELD-0', 'RQ-NEW-1', 'RQ-NEW-2'])]);
    await expect(importIntentFiles([file], { root, now })).rejects.toThrow(/RQ keys/);
    expect(await ledgerBytes()).toBe(before);
  });

  it('keeps terminal-status precedence inside a conflict', async () => {
    await seed(
      item('live', ['RQ-LIVE-1'], { status: 'in-progress' }),
      item('retired', ['RQ-RET-1'], { status: 'superseded' }),
    );
    const file = await writeNative('terminals.json', [
      item('live-copy', ['RQ-LIVE-1'], { status: 'closed' }),
      item('retired-copy', ['RQ-RET-1'], { status: 'verified' }),
    ]);
    expect(await importIntentFiles([file], { root, now })).toEqual({ imported: 0, deduped: 2, items: 2 });
    const items = (await readLedger(root)).items;
    expect(items.find((row) => row.id === 'live')!.status).toBe('closed');
    expect(items.find((row) => row.id === 'retired')!.status).toBe('verified');
  });

  it('maps vague done text to closed, never verified, inside a conflict', async () => {
    await seed(item('live', ['RQ-LIVE-1'], { status: 'in-progress' }));
    const file = join(root, 'done.jsonl');
    await writeFile(file, `${JSON.stringify({ title: 'restated', rq: 'RQ-LIVE-1', status: 'done', source: 'report' })}\n`);
    await importIntentFiles([file], { root, now });
    expect((await readLedger(root)).items[0]!.status).toBe('closed');
  });
});
