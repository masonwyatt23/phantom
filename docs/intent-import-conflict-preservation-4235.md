# PR #4235 import-conflict preservation evidence

Bounded audit of directive-import conflict behavior only. The original head
`80f1d451949b26685cafa3ffa973d3933901634d` was fetched via `git fetch origin
pull/4235/head`; its `src/core/intent/ledger.ts`, `src/core/intent/schema.ts`
and `test/intent-ledger.test.ts` were read with `git show`. Current source was
inspected at worktree base `252a3c56d3311ef2735ef0b69a737e0558b235a4` and at
`origin/master` `5b52c782f3c4345be570e54d1180564bb4357d99`; `src/core/intent/`
is byte-identical between those two commits (`git diff` empty for that path).
The wider #4235 export/caller audit lives in
[intent-preservation-4235.md](intent-preservation-4235.md) and is not repeated
here.

"Original" cites `80f1d451` `src/core/intent/ledger.ts` (import path:
`importIntentFiles` → `recordsFromFile` → `itemFromRecord` → `place` →
`absorb`/`mergePulls`/`pushEvidence`/`addProvenance`). "Current" cites
`src/core/intent/import.ts` at the inspected commits plus the change in this
patch. Fixture names in tests are invented; no real directive content appears
here or in the test file.

| Behavior | Original (`80f1d451`) | Current importer | Test evidence (name: test file) | Assessment |
| --- | --- | --- | --- | --- |
| Conflict match key | `sameDirective`: shared RQ key or equal normalized title | Identical (`schema.ts`) | "merges an overlapping native item losslessly across different ids": `test/intent-import-conflict-preservation-09squ1.test.ts` | Preserved |
| Merge target & dedup collapse | First match absorbs incoming; incoming id discarded; extra matches absorbed into the target then removed by id | Identical `place` structure | Same as above; extras collapse exercised by `test/intent-import-join-evidence-09sqj1.test.ts` | Preserved |
| RQ union bound | `absorb` throws past `MAX_RQ` (16); write never reached | Identical | "rejects an RQ union past the key cap and leaves bytes identical" (new file) | Preserved |
| Pull merge | Dedup by `pullKey` (lowercased repo + number); `merged` state and missing `url` upgrade known pulls | Identical semantics | "merges known pulls at the cap, then rejects a new pull link instead of dropping it" (new file) | Preserved |
| Pull bound overflow | `mergePulls` silently `break`s past `MAX_PRS` (32); incoming pulls dropped | Incoming-item overflow now rejects the whole import before write; extras-collapse keeps the rolling bound | Rejection: new file. Rolling bound: "deduplicates evidence and bounds rolling evidence and unique PRs without blocking upgrades" (`test/intent-import-join-evidence-09sqj1.test.ts`) | Changed at the import boundary: refusal replaces silent loss for the imported item; collapse bound kept |
| Evidence merge | Every incoming row appended, then `slice(-MAX_EVIDENCE)` — no dedup | Dedups on `(at, kind, ref, note)` before append | "replays an overlapping native import byte-identically" (new file); `test/intent-import-join-evidence-09sqj1.test.ts` | Deliberately changed: replay no longer duplicates rows |
| Evidence bound overflow | `slice(-32)` drops oldest retained rows silently | Incoming-item overflow rejects the whole import byte-identically; extras-collapse keeps the rolling bound | "rejects an import that would drop retained evidence rows past the cap" and "leaves the ledger byte-identical when a later file in the batch conflicts at capacity" (new file); rolling bound pinned by `09sqj1` test above | Changed at the import boundary; collapse bound kept |
| Provenance merge/bound | Dedup on `(source, date, verbatim)`; `slice(-16)` drops oldest | Same dedup; incoming-item overflow rejects the whole import | "rejects an import that would push provenance past the cap" (new file) | Changed at the import boundary; collapse bound kept |
| Status precedence | `preferStatus`: `verified` > `superseded` > `closed` terminals, else higher rank | Identical rule | "keeps terminal-status precedence inside a conflict" (new file); `test/intent-native-ledger-import-09sqm1.test.ts` | Preserved |
| Status text mapping | `open`→`in-progress`; `done`/`complete`→**verified**; else `unknown` | `open`→`in-progress`; `done`/`complete`→**closed**; else `unknown` | "maps vague done text to closed, never verified, inside a conflict" (new file); `test/intent-import-reconcile-09sph1.test.ts`, `test/intent-native-ledger-import-09sqm1.test.ts` | Deliberately changed: vague "done" text is never promoted to `verified` |
| `updatedAt` on merge | Always set to the import clock | Set only when merged content changed, so replay is byte-identical | Replay tests in new file and `test/intent-native-ledger-import-09sqm1.test.ts`, `test/intent-import-join-evidence-09sqj1.test.ts` | Deliberately changed: idempotent replay |
| `lastTouchedAt` | Max of the two | Identical | "merges an overlapping native item losslessly across different ids" (new file) | Preserved |
| `closureProposal` | Incoming `superseded` propagated to target | Incoming value ignored (sweep proposals are local state) | `test/intent-native-ledger-import-09sqm1.test.ts` asserts the merged item keeps `null` | Deliberately changed |
| Schema-tagged ledger files | No native path: a tagged file fell through to the row parser, so each item was imported as a bare row and its `prs`/`evidence`/`provenance`/timestamps were silently discarded | `nativeLedgerItems` parses items as full `IntentItem`s through `isIntentLedger`; a tagged-but-invalid file rejects the whole import | `test/intent-native-ledger-import-09sqm1.test.ts` ("roundtrips", "fails atomically") | Changed: payload preserved losslessly or import refused, instead of silent degradation |
| Write atomicity | Ledger read once, merged in memory, written once at the end | Identical | `test/intent-native-ledger-import-09sqm1.test.ts`, `test/intent-import-reconcile-09sph1.test.ts`, new rejection tests | Preserved; this is what makes rejection byte-identical |
| Non-matching id collision | Incoming id reminted via `newId()`; original id not recorded | Identical | Code inspection both sides; not separately pinned | Preserved (gap noted below) |
| `staleAfterMs` on rows | `draftItem` threw on out-of-range values | Out-of-range values clamp to `DEFAULT_STALE_AFTER_MS` | Code inspection both sides | Deliberately changed: invalid input defaults rather than rejects |

## Remaining #4235 gaps in import conflict behavior

- **Extras-collapse still rolls at the bounds.** When more than one retained
  item matches an imported row/item, the extra matches are absorbed into the
  target under `slice`/skip semantics and oldest retained rows can drop.
  `test/intent-import-join-evidence-09sqj1.test.ts` pins that bound by name;
  changing it is outside this patch's four-file budget. A fully lossless
  collapse is unproven.
- **Reminted ids are unrecorded.** A non-matching incoming item whose id is
  taken gets a fresh `int-` id; the supplied id appears nowhere, including
  provenance (identical in the original).
- **Untested conflict shapes.** Title-only matches at capacity, overflow
  inside a multi-item file beyond the tested single/later-file shapes, and
  the `MAX_INTENT_ITEMS` boundary are not pinned by this patch.
- This document makes no claim of complete #4235 equivalence and grants no
  closure authority; see `intent-preservation-4235.md` for the open gaps.
