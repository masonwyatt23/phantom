/**
 * Source-level type contract for the public API of the original PR #4235
 * ledger (80f1d451949b26685cafa3ffa973d3933901634d, src/core/intent/ledger.ts).
 * Every case compiles an original caller shape against the real current
 * imports. `@ts-expect-error` marks only calls the original API accepted and
 * the current one rejects; it documents the migration, not compatibility.
 * Report: docs/intent-type-preservation-4235-09sqs1.md
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as ledgerModule from '../src/core/intent/ledger.js';
import {
  addIntent, getIntent, importIntentFiles, intentSummary, isStale, linkMergedPull, listIntents, markShipped,
  noteShippedRelease, summarize, sweepStale, updateIntent,
  type IntentAddInput, type IntentSummary, type IntentUpdateInput, type MergedPullNote, type ShippedReleaseNote,
  type SweepRow,
} from '../src/core/intent/ledger.js';
import type { IntentItem, IntentLedger, IntentStatus } from '../src/core/intent/schema.js';

describe('original #4235 ledger type contract (09sqs1)', () => {
  it('preserved: IntentAddInput accepts every original field, optional and nullable', () => {
    const full = {
      id: 'int-fake-0001', title: 'Fake directive', source: 'fake-source', owner: 'fake-owner', rq: ['RQ-FAKE-1'],
      status: 'queued', staleAfterMs: 1000, verbatim: true, date: null, partial: false, now: '2026-01-01T00:00:00Z',
    } satisfies IntentAddInput;
    const minimal = { title: 'Fake', source: 'fake' } satisfies IntentAddInput;
    expectTypeOf(full).toExtend<IntentAddInput>();
    expectTypeOf(minimal).toExtend<IntentAddInput>();
    expectTypeOf<keyof IntentAddInput>().toEqualTypeOf<
      'id' | 'title' | 'source' | 'owner' | 'rq' | 'status' | 'staleAfterMs' | 'verbatim' | 'date' | 'partial' | 'now'>();
    expectTypeOf<IntentAddInput['date']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf(addIntent).parameters.toEqualTypeOf<[IntentAddInput, (string | undefined)?]>();
    expectTypeOf(addIntent).returns.resolves.toEqualTypeOf<IntentItem>();
  });

  it('preserved: IntentUpdateInput accepts every original field', () => {
    const full = {
      title: 'Fake', source: 'fake', owner: 'fake-owner', status: 'merged', rq: ['RQ-FAKE-1'],
      evidence: { ref: 'fake-ref', note: 'fake note' }, partial: true, now: '2026-01-01T00:00:00Z',
    } satisfies IntentUpdateInput;
    const evidenceOnly = { evidence: { ref: 'fake-ref' } } satisfies IntentUpdateInput;
    expectTypeOf(full).toExtend<IntentUpdateInput>();
    expectTypeOf(evidenceOnly).toExtend<IntentUpdateInput>();
    expectTypeOf<keyof IntentUpdateInput>().toEqualTypeOf<
      'title' | 'source' | 'owner' | 'status' | 'rq' | 'evidence' | 'partial' | 'now'>();
    expectTypeOf(updateIntent).parameters.toEqualTypeOf<[string, IntentUpdateInput, (string | undefined)?]>();
    expectTypeOf(updateIntent).returns.resolves.toEqualTypeOf<IntentItem>();
  });

  it('preserved: list/get/import/isStale/summarize signatures and consumable result properties', () => {
    type Listed = Awaited<ReturnType<typeof listIntents>>;
    expectTypeOf<Listed['items']>().toEqualTypeOf<IntentItem[]>();
    expectTypeOf<Listed['summary']>().toEqualTypeOf<IntentSummary>();
    expectTypeOf(listIntents).parameter(0).toEqualTypeOf<{ root?: string; status?: IntentStatus; nowMs?: number } | undefined>();
    expectTypeOf(getIntent).parameters.toEqualTypeOf<[string, (string | undefined)?]>();
    expectTypeOf(getIntent).returns.resolves.toEqualTypeOf<IntentItem | null>();
    expectTypeOf(importIntentFiles).parameter(0).toEqualTypeOf<string[]>();
    expectTypeOf(importIntentFiles).parameter(1).toEqualTypeOf<{ root?: string; now?: string } | undefined>();
    expectTypeOf(importIntentFiles).returns.resolves.toEqualTypeOf<{ imported: number; deduped: number; items: number }>();
    expectTypeOf(isStale).parameters.toEqualTypeOf<[IntentItem, number]>();
    expectTypeOf(isStale).returns.toEqualTypeOf<boolean>();
    expectTypeOf(summarize).parameters.toEqualTypeOf<[IntentLedger, number, boolean?]>();
    expectTypeOf(summarize).returns.toEqualTypeOf<IntentSummary>();
    expectTypeOf(intentSummary).parameter(0).toEqualTypeOf<{ root?: string; nowMs?: number } | undefined>();
    expectTypeOf(intentSummary).returns.resolves.toEqualTypeOf<IntentSummary>();
  });

  it('preserved: every original IntentSummary property keeps its type (reader side)', () => {
    expectTypeOf<IntentSummary['schema']>().toEqualTypeOf<'ashlr.intent-ledger/v1'>();
    expectTypeOf<IntentSummary['present']>().toEqualTypeOf<boolean>();
    for (const key of ['items', 'tracked', 'merged', 'shipped', 'verified', 'stale', 'partial'] as const) {
      expectTypeOf<IntentSummary[typeof key]>().toEqualTypeOf<number>();
    }
    expectTypeOf<IntentSummary['staleItems']>().toEqualTypeOf<Array<{ id: string; title: string; status: IntentStatus }>>();
  });

  it('CHANGED: IntentSummary gained required sourceQuality and countQuality (writer side)', () => {
    expectTypeOf<IntentSummary['sourceQuality']>().toEqualTypeOf<'readable' | 'missing' | 'unavailable'>();
    expectTypeOf<IntentSummary['countQuality']>().toEqualTypeOf<'observed' | 'unknown'>();
    // Original callers that build a summary literal omit both fields and no longer compile.
    // @ts-expect-error original literal lacks sourceQuality and countQuality
    const original: IntentSummary = {
      schema: 'ashlr.intent-ledger/v1', present: false, items: 0, tracked: 0, merged: 0, shipped: 0,
      verified: 0, stale: 0, partial: 0, staleItems: [],
    };
    expect(original.items).toBe(0);
  });

  it('preserved: MergedPullNote and linkMergedPull accept original callers', () => {
    const full = { repo: 'fake/repo', number: 1, title: 'RQ-FAKE-1 fake', branch: 'fake', url: 'https://example.invalid/1', at: '2026-01-01T00:00:00Z' } satisfies MergedPullNote;
    const minimal = { repo: 'fake/repo', number: 1, title: 'fake' } satisfies MergedPullNote;
    expectTypeOf(full).toExtend<MergedPullNote>();
    expectTypeOf(minimal).toExtend<MergedPullNote>();
    expectTypeOf<keyof MergedPullNote>().toEqualTypeOf<'repo' | 'number' | 'title' | 'branch' | 'url' | 'at'>();
    expectTypeOf(linkMergedPull<IntentItem>).parameters.toEqualTypeOf<[{ items: IntentItem[] }, MergedPullNote, (string | undefined)?]>();
    expectTypeOf(linkMergedPull<IntentItem>).returns.toEqualTypeOf<IntentItem[]>();
    // CHANGED (compatible for callers): now generic; an IntentLedger infers T = IntentItem.
    expectTypeOf(linkMergedPull<IntentLedger['items'][number]>).returns.toEqualTypeOf<IntentItem[]>();
    expectTypeOf<IntentLedger>().toExtend<{ items: IntentItem[] }>();
  });

  it('preserved: ShippedReleaseNote, markShipped and noteShippedRelease accept original callers', () => {
    const full = { release: 'v0.0.0-fake', notes: 'RQ-FAKE-1', rq: ['RQ-FAKE-1'], at: '2026-01-01T00:00:00Z' } satisfies ShippedReleaseNote;
    const minimal = { release: 'v0.0.0-fake' } satisfies ShippedReleaseNote;
    expectTypeOf(full).toExtend<ShippedReleaseNote>();
    expectTypeOf(minimal).toExtend<ShippedReleaseNote>();
    expectTypeOf<keyof ShippedReleaseNote>().toEqualTypeOf<'release' | 'notes' | 'rq' | 'at'>();
    expectTypeOf(markShipped<IntentItem>).parameters.toEqualTypeOf<[{ items: IntentItem[] }, ShippedReleaseNote, (string | undefined)?]>();
    expectTypeOf(markShipped<IntentItem>).returns.toEqualTypeOf<IntentItem[]>();
    expectTypeOf(noteShippedRelease).parameter(0).toEqualTypeOf<ShippedReleaseNote>();
    expectTypeOf(noteShippedRelease).parameter(1).toEqualTypeOf<{ root?: string; now?: string } | undefined>();
    // Original result was { updated: number }; the current one is a structural superset (reader-compatible).
    expectTypeOf(noteShippedRelease).returns.resolves.toExtend<{ updated: number }>();
    expectTypeOf<Awaited<ReturnType<typeof noteShippedRelease>>['matches']>().toEqualTypeOf<{ id: string; status: IntentStatus }[]>();
  });

  it('CHANGED: SweepRow no longer allows close-superseded; sweepStale result gained updated', () => {
    expectTypeOf<keyof SweepRow>().toEqualTypeOf<'id' | 'title' | 'action' | 'status'>();
    expectTypeOf<SweepRow['status']>().toEqualTypeOf<IntentStatus>();
    expectTypeOf<SweepRow['action']>().toEqualTypeOf<'requeue' | 'propose-superseded' | 'await-verification'>();
    // The original union also had 'close-superseded'; writers of that value no longer compile.
    // @ts-expect-error 'close-superseded' is not in the current SweepRow action union
    const closing: SweepRow['action'] = 'close-superseded';
    expect(closing).toBe('close-superseded');
    // Reader side: every current action is one of the original actions, so rows widen safely.
    expectTypeOf<SweepRow['action']>().toExtend<'requeue' | 'propose-superseded' | 'close-superseded' | 'await-verification'>();
    expectTypeOf(sweepStale).parameter(0).toEqualTypeOf<{ root?: string; apply?: boolean; now?: string } | undefined>();
    type Swept = Awaited<ReturnType<typeof sweepStale>>;
    expectTypeOf<Swept>().toExtend<{ stale: SweepRow[]; applied: boolean }>();
    expectTypeOf<Swept['updated']>().toEqualTypeOf<number>();
  });

  it('MISSING: noteMergedPulls (original line 499) is not exported by the compatibility module', () => {
    expectTypeOf<keyof typeof ledgerModule>().not.toMatchTypeOf<'noteMergedPulls'>();
    // @ts-expect-error noteMergedPulls is not exported from ledger.ts
    expect(ledgerModule.noteMergedPulls).toBeUndefined();
  });

  it('runtime smoke: original add/get/list caller consumes returned properties (temp root, fake data)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'intent-type-09sqs1-'));
    try {
      const item = await addIntent({ title: 'Fake directive', source: 'fake', rq: ['RQ-FAKE-1'], now: '2026-01-01T00:00:00Z' }, root);
      const id: string = item.id;
      const found: IntentItem | null = await getIntent(id, root);
      const listed = await listIntents({ root, nowMs: Date.parse('2026-01-02T00:00:00Z') });
      const total: number = listed.summary.items;
      expect(found?.title).toBe('Fake directive');
      expect(total).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
