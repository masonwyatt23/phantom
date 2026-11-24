# RQ-DRAIN-PHX-AUTH-03 outcomes

All five PRs were open at their exact supplied heads. No PR was closed, merged,
rebased, committed, pushed, tagged or published. The final instruction to leave
changes uncommitted takes precedence over the earlier publication steps.
GitHub rejected the authorized comment and label attempts with HTTP 403
(`Resource not accessible by integration`). The CLI fallback could not read its
configuration. The requested external handoff directory rejected creation with
`Operation not permitted`; this worktree-local file is the fallback.

Tested master: `8d4f039e5a6f276503bb62b0e35b6ce854d440ee`.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [#7391](https://github.com/ashlrai/phantom/pull/7391) | blocked | `fbf65b97800d486bb75fc020c74f8605ff4f8ca6` (unchanged) | Replacement replay: 15 tests passed; master authority guards: 10 passed. Closure comment denied. | None; remains open. Candidate: [#7519](https://github.com/ashlrai/phantom/pull/7519). |
| [#7304](https://github.com/ashlrai/phantom/pull/7304) | blocked | `bf1f22ad249eb24631b3dd9a84ef62b9141b28d9` (unchanged) | Documentation intent preserved; documentation checks: 17 passed, 2 existing failures. Two generated references have unrelated drift. GitHub write access unavailable. | None; remains open. Preservation: [#8263](https://github.com/ashlrai/phantom/pull/8263), [#7934](https://github.com/ashlrai/phantom/pull/7934), [#7303](https://github.com/ashlrai/phantom/pull/7303). |
| [#7263](https://github.com/ashlrai/phantom/pull/7263) | blocked | `83f910213483a02c6fa9e63f0846ce32f9bdfbea` (unchanged) | Unique Leader alert grows authority closure. No candidate modifications or candidate test pass claimed. Security label denied. | None. |
| [#7243](https://github.com/ashlrai/phantom/pull/7243) | blocked | `f4df412dc119989d7f7160b09ed6fb8885e63d5d` (unchanged) | Current SessionThread suites: 22 tests passed. Complete original implementation carried by replacement. GitHub write access unavailable. | None; remains open. Candidate: [#7653](https://github.com/ashlrai/phantom/pull/7653). |
| [#7241](https://github.com/ashlrai/phantom/pull/7241) | blocked | `226406a6ef07133d543a0e29eb4b76d4fe5f574b` (unchanged) | Current Models suites: 34 tests passed. Complete original implementation carried by replacement. GitHub write access unavailable. | None; remains open. Candidate: [#7660](https://github.com/ashlrai/phantom/pull/7660). |

## Supersession evidence

- #7391: merged #7519, commit `4a22fd8dd9a08bbf153c2280f7b94569adeb19e5`,
  carries both original paths. Both files are byte-identical to tested master.
  It corrects the imagined scorer input contract and inverted test expectation,
  and honors the original test's insufficient-data requirement below minRows.
  This is preservation of intent with bug fixes, not byte identity to #7391.
  Merged #8622 adds independent original-intent coverage. No promotion is added.
- #7304: all eight paths were inspected. AGENTS, CLAUDE, CONTRIBUTING and the
  contributor guide retain the required-check/fast-suite distinction and local
  lint responsibility. #8263 preserves the diagnosis correction; #7934 replaces
  the constraint audit's inaccurate full-check wording. #7303 already carries
  the adapter-contract, cooldown-evidence and ledger-score rows and the pools
  description. Current generated descriptions take precedence over the old
  ci-reruns description deletion. The generator's only differences on tested
  master add the unrelated `phm install` row introduced by #8635 to both
  references. No generated file was hand-merged or changed.
- #7243: merged #7653, commit `b0c45f0a66e2a3ed5546fa5f83b49e08203a0c62`,
  has byte-identical helper, component integration, CSS and original follow
  tests. Its only difference across the original five paths is additional
  unrelated session-list documentation. Later changes extend the implementation.
- #7241: merged #7660, commit `d4a28927b7ce4e4a1d8a1640b2f637e3a530cd48`,
  has byte-identical source, tests, queries, CSS, registration and router guide,
  including the original ModelsCard deletions. Across all eleven original
  paths, differences are additional unrelated CONSOLE-LAYOUT paragraphs.

`git merge-tree --write-tree` reports conflicts for the four supersession
candidates. These are not clean tree-identity results. The replacement commit
and complete changed-path comparisons above establish their preservation.
No branch merge or duplicate implementation was prepared for them.

## Security handoff for #7263

`src/core/vision/leader.ts` is a protected Tier-1 root. The PR adds
`announceDisk: () => import('../fleet/disk-runway.js').then(m => m.runDefaultDiskAlert())`
to its production dependency loader and calls it from the Leader tick.
`src/core/fleet/disk-runway.ts` is absent from master's closure and source tree.
It reaches CLI disk readers, removal-plan, host-top, preferences, local-store-lock,
leader-thread and leader-memo. Removing the alert dependency would discard an
explicit feature of the PR. Review the new dependency and outbound alert path;
do not remove its behavior merely to pass the guard.

The older Host disk-runway endpoint uses a different forecast contract and
100/30 GB thresholds. It does not replace this PR's 60 GB launch-freeze runway,
grouped worktree report and Leader warning. No replacement was established.
No authority files, snapshots, allowlists, CODEOWNERS or tests were edited.
The `needs-security-review` label attempt failed; that label was not applied.

## Unsent one-line comments

- #7391: Superseded by https://github.com/ashlrai/phantom/pull/7519, which carries the offline replay comparison and original test intent with the scorer-contract and insufficient-data fixes.
- #7304: Superseded by https://github.com/ashlrai/phantom/pull/8263 and https://github.com/ashlrai/phantom/pull/7934 for the CI guidance, with the generated command additions already carried by https://github.com/ashlrai/phantom/pull/7303.
- #7263: Security review required: src/core/vision/leader.ts imports ../fleet/disk-runway.js for the new production Leader alert, growing the Tier-1 closure; preserving that feature requires reviewing the new dependency.
- #7243: Superseded by https://github.com/ashlrai/phantom/pull/7653, which carries the original follow helper, component integration, styles, tests and documentation.
- #7241: Superseded by https://github.com/ashlrai/phantom/pull/7660, which carries the complete original Models board, queries, registration, styles, tests and documentation.

These are drafts, not delivery receipts. Recheck each original head and state
before any later action. Existing auto-merge settings were not changed.

See [BRIDGE_NOTES.md](BRIDGE_NOTES.md) for commands, counts and limitations.
