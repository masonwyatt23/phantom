# Intent ledger type preservation evidence for #4235 (09sqs1)

Original source: `80f1d451949b26685cafa3ffa973d3933901634d`, `src/core/intent/ledger.ts` (cited as `orig:LINE`).
Inspected current source: `origin/master` `a8c04fe4a5fbcf4edbd0ac8e8f1e0a4dab946088`; `src/core/intent/` is identical to the planner's `321c6258ba` tree.
Current public path: `src/core/intent/ledger.ts` (reexports from `edit.ts`, `read.ts`, `import.ts`, `summary.ts`, `evidence.ts`, `release.ts`, `sweep.ts`).

All assertions live in `test/intent-original-type-contract-09sqs1.test.ts`, compiled against the real current imports (`expectTypeOf`, `satisfies`, `@ts-expect-error`). Test names are quoted below. This report covers exported TypeScript contracts only. It does not declare #4235 preserved and does not authorize closing it.

## Preserved (source-compatible for callers)

| Original symbol | Current signature | Test (assertion) |
| --- | --- | --- |
| `IntentAddInput` orig:51 | `edit.ts:15`, same 11 optional/required fields, `date?: string \| null` | “IntentAddInput accepts every original field”: `satisfies IntentAddInput` on full and minimal literals; `keyof` equality; `date` equality; `addIntent` params/returns |
| `IntentUpdateInput` orig:65 | `edit.ts:34`, same 8 fields | “IntentUpdateInput accepts every original field”: `satisfies`, `keyof`, `updateIntent` params/returns |
| `listIntents` orig:264, `getIntent` orig:270 | `read.ts:7`, `read.ts:30`, same signatures; returns `{items: IntentItem[]; summary: IntentSummary}` and `IntentItem \| null` | “list/get/import/isStale/summarize signatures…” |
| `importIntentFiles` orig:416 | `import.ts:224`, result is the named `IntentImportResult` with the same three number fields | same test, `toEqualTypeOf<{imported;deduped;items}>` |
| `isStale` orig:123, `summarize` orig:130, `intentSummary` orig:595 | `summary.ts:22,29,47`, same parameters | same test |
| `MergedPullNote` orig:76 | `evidence.ts:41`, same fields | “MergedPullNote and linkMergedPull accept original callers” |
| `ShippedReleaseNote` orig:85 | `evidence.ts:50`, same fields | “ShippedReleaseNote, markShipped and noteShippedRelease…” |
| `linkMergedPull` orig:459, `markShipped` orig:481 | `evidence.ts:136,164`, now generic `<T extends EvidenceItem>(ledger: EvidenceLedger<T>, …): T[]`; an `IntentLedger` caller still gets `IntentItem[]` | `linkMergedPull<IntentItem>` / `markShipped<IntentItem>` parameters and returns; `IntentLedger` extends `{items: IntentItem[]}` |
| `noteShippedRelease` orig:518 | `release.ts:23`, options `{root?, now?}`; result `{updated; matches}` is a superset of orig `{updated}` | `.returns.resolves.toExtend<{updated: number}>()` |
| `IntentSummary` readers orig:38 | all nine original properties keep their types | “every original IntentSummary property keeps its type” |

A runtime smoke case (temp dir, fake data) adds, gets and lists an item and reads typed properties.

## Changed or missing (caller consequences)

1. **`IntentSummary` gained required `sourceQuality` and `countQuality`** (`summary.ts:5`). Readers are unaffected. Any original caller that constructs an `IntentSummary` literal (fixtures, mocks, UI model defaults) fails to compile until both fields are supplied. Test “CHANGED: IntentSummary gained required…” records this with a documented `@ts-expect-error` on the original literal.
2. **`SweepRow.action` lost `'close-superseded'`** (`sweep.ts:4`; orig:92 had four values). Code that writes that value fails; the test's `@ts-expect-error` on `const closing: SweepRow['action'] = 'close-superseded'` shows it. Current rows widen safely into the original union (`toExtend` assertion). Migration: use `'propose-superseded'`; closure is proposal-only on master.
3. **`sweepStale` result gained `updated: number`** (`sweep.ts:21`). Reader-compatible: `Awaited<ReturnType<typeof sweepStale>>` extends `{stale: SweepRow[]; applied: boolean}`. Writers or mocks of the original result shape lack `updated`.
4. **`noteMergedPulls` (orig:499) is not exported from `ledger.ts`** and not found anywhere under `src/`. Callers importing it fail to compile; the test's `@ts-expect-error` on `ledgerModule.noteMergedPulls` proves the absence. This matches the missing merge-snapshot caller noted in `docs/intent-preservation-4235.md`. It is unresolved here and not implemented.

## Runtime difference observed (outside the type contract)

`linkMergedPull` and `markShipped` originally defaulted a missing timestamp to the current time (orig:`nowIso`). Current `evidence.ts` throws `EvidenceError` unless `at` or the note's `at` is given. The signature is unchanged, so the compiler does not see this; callers must pass a timestamp. Observed when an early draft of the test called `markShipped` without one.

## Limits

- Internal helpers and schema exports of the original file are out of scope except as used by the six interfaces.
- `IntentError` versus `EvidenceError` error classes were not compared.
- The repo `tsconfig.json` includes only `src`, so this test file is type-checked by the dedicated run recorded in `BRIDGE_NOTES.md`, not by the gate; Vitest itself does not typecheck.
