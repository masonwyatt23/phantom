# Release autonomy gaps

Audit date: 2026-11-14. Scope: the path from a green master commit to a
published npm package, a signed desktop feed and a finalized GitHub release.
The goal is a release every few hours with no human touch that recovers by
itself from every observed stall. This page lists what still prevents that,
ranked by how often each item stalls a release and how cheap it is to fix.
The policy summary is in [RELEASING.md](../RELEASING.md). The
[release autonomy audit](../RELEASE-AUTONOMY.md) covers per-repository GitHub
settings.

Each gap is one of three kinds:

- **manual**: a person, or a specific Mac, must act.
- **stall**: the pipeline stops and waits for no reason a later tick removes.
- **race**: two actors can collide and leave state that blocks later steps.

Owner-reserved gates are listed as gates, not gaps. Removing them is not the
goal: environment approvals, signing identity unlock and the security pins
for the Mac release scripts. The goal is to stop making them wait on
avoidable stalls.

## Fixed in this change

| # | Kind | Where | Stall | Fix |
|---|---|---|---|---|
| F1 | stall | `src/core/release/train.ts` `auditRun` | The train only accepted a successful `dependency-audit.yml` master **push** run on the exact tag SHA. Master pushes share one concurrency group, and each newer push cancels the pending run, so on busy days the tag commit had no successful audit. The train never asked for one, so npm publish was never dispatched and the state gave no reason. | The train now dispatches `dependency-audit.yml` on the release **tag ref**, so the run's `head_sha` is the candidate. It does this in parallel with the build, whenever no admitted audit run is queued or has passed. `verifyUpdateAudit` in the publisher already accepts `workflow_dispatch` audits on the exact SHA. The train admits only same-repo `push` or `workflow_dispatch` runs on `master` or the exact tag. Cancelled runs count as missing, not red. Real failures are retried up to `MAX_AUDIT_ATTEMPTS` (3) and then reported as `steps.audit.reason = audit-failed`. A real advisory stays a closed gate. |
| F2 | race / stall | `train.ts` publish dispatch | The npm publish dispatch had no pending-run guard, unlike the CI and attest dispatches. `publish-canonical-npm.yml` allows one pending run per version, and a newer dispatch cancels it. Every train tick, triggered hourly and by each CI completion, re-dispatched and cancelled the run waiting on `phantom-npm`. | The publish workflow now sets `run-name: Publish @ashlr/phantom <version>`. While a run with that title is queued, running or waiting, the train holds the dispatch and reports `steps.npm.reason = publish-running`. If the runs list cannot be read, the train also treats publish as pending. |
| F3 | visibility | `train.ts` state | The step list had no audit step, so an audit stall looked like an npm stall with no reason. | `steps.audit` is now in the state, the step order and `next`. Reasons: `audit-missing`, `audit-running`, `audit-failed`. |

The workflow dispatch allowlist was also deduplicated: `assertReleaseWrite`
and the token routing now share one `WORKFLOW_DISPATCH` pattern. An audit
dispatch must target a stable `vX.Y.Z` tag with no inputs. It uses the
existing `GITHUB_TOKEN` `actions: write` grant. No permissions, secrets or
triggers were added.

## Remaining gaps, ranked

### Tier 1: stalls the train can heal itself (next fixes)

1. **Attest retry storm, no cap** (stall). `train.ts` re-dispatches
   `attest-ci-build.yml` on every tick while `!attest && !attestPending`. An
   attest that fails deterministically is retried forever, and each tick costs
   one Actions run. Fix: count failed attest runs for this CI run and attempt,
   cap them the same way as the audit (F1), and report `attest-failed`.
2. **Attestation falls out of the 20-run window** (stall). `attestRun` reads
   only the latest 20 `attest-ci-build` runs, from schedule runs at `:15`/`:45`
   plus dispatches. After about 10 hours, a valid attestation is no longer
   seen and the train re-attests the same build. That is safe but wasteful,
   and once the 7-day artifact expires it starts a chain of re-runs. Fix:
   paginate until the run date is older than the build, or look up by artifact
   name (`ashlr-attested-<run>-<attempt>-*`) through the artifacts API.
3. **Successor tag strands the older version** (stall, by design).
   `successorTagConflict` returns `stopped('duplicate_tag')` once
   `v(next)` exists. The older tag's npm publish is never retried, which is
   the intended outcome. But the train also does nothing for the new tag
   until master's `package.json` catches up. Fix: once the successor commit
   is an ancestor of master, plan for the successor instead of stopping.
4. **Release PR enqueue overlaps** (race). The train's enqueue and the manual
   `scripts/release-enqueue.mjs` can both act. The script does one
   observation after `gh pr merge` and then tells the operator to inspect
   GitHub. Fix: retire the script and keep the train as the only enqueuer;
   it already checks `MERGEABLE`, green and unqueued.
5. **App token refresh precondition** (stall). `release-please.yml:79-92`
   refreshes the PR with the App token only when the branch head author is
   `github-actions[bot]`. With any other author, or a rotated
   `ASHLR_RELEASE_APP_KEY`, the PR sits with no required checks. Fix: have the
   train detect an open release PR with zero Actions check runs for more than
   two cadences, and dispatch `release-please.yml`, which is already on the
   allowlist.

### Tier 2: draft races (need one owner for draft creation)

6. **Duplicate drafts from parallel creators** (race).
   `.github/scripts/tag-github-release.mjs:67-80` creates a draft after an
   empty lookup. It adopts an existing draft only if the POST fails, but
   GitHub accepts several releases per tag, so two legs can both succeed.
   `release-desktop.yml` macOS and Windows legs (`tauri-action`,
   `releaseDraft: true`) and `scripts/publish-desktop-release.mjs:158-171`
   follow the same pattern. Finalize requires exactly one row per tag, so a
   duplicate blocks finalization for good. Fix: after create, list releases
   for the tag. If there is more than one, keep the lowest id that carries
   assets, or else the highest id, and delete only the losers that are still
   empty drafts. Run this in the creator, not in a separate sweeper, so no
   uploader is racing it.
7. **Upload by tag, verify by id** (race). `publish-desktop-release.mjs:176-186`
   uploads with `gh release upload <tag>`, which picks its own release, and
   then verifies by `releaseId`. With duplicates, the bytes land on another
   draft. Fix: upload to the release id through the upload URL.
8. **Stale drafts are never removed** (stall, cosmetic until it is not). The
   train marks older drafts as superseded but never deletes them.
   `scripts/dedupe-draft-releases.mjs` is manual ("Never invoked by CI") and
   deletes only groups whose rows are all empty drafts. Deleting a draft
   while an uploader is still writing to it loses the upload; the window
   between the emptiness recheck and the DELETE is small but real. A safe
   sweeper would delete only superseded drafts that are older than the
   newest **published** release, have no assets, and were last updated more
   than 24 hours ago. It would run inside the train, which already holds the
   `phantom-release-train` concurrency lock. That needs a `DELETE` added to
   `assertReleaseWrite` and a security pass on the App token scope, so it is
   not in this change.

### Tier 3: finalize and desktop (manual today)

9. **Finalize is dispatch-only with hand-typed inputs** (manual).
   `finalize-github-release.yml` takes six inputs and nothing dispatches it.
   The train allowlist excludes it. Every input is derivable from train
   observations: version, publish run and attempt, SHA, integrity. Fix: once
   npm `latest` equals the version and the draft carries the 7-asset set, the
   train dispatches finalize. The `github-stable-release-finalization`
   environment approval stays.
10. **Finalize receipt expires before approval** (stall). The preflight
    receipt lasts 3600 s, but the environment approval has no deadline. If
    approval takes longer than an hour, the run fails. Fix: under item 9 the
    train re-dispatches. Alternatively, move the receipt check after approval.
11. **Finalize requires master HEAD = workflow SHA** (stall). Any merge to
    master during the approval wait fails the run, and release PRs merge
    every cadence. Fix: compare against the candidate's ancestry, not the
    HEAD identity. This needs a security review because it relaxes a pin.
12. **Admission artifact lives 7 days; npm `latest` must equal the version**
    (permanent stall). A draft that is not finalized within 7 days, or after
    a newer promotion, can never be finalized. Fix: under item 9 this rarely
    happens. Add a train state `finalize-expired` so the release is
    skipped visibly instead of silently.
13. **Signing and notarization run only on the Mac** (manual gate).
    `release-autorun.sh` polls every 10 minutes. If the signing identity is
    locked, it writes `NEEDS-MASON-<tag>` and waits. That script changes only
    through a Security pin; the repo copy under `contrib/mac` is not
    installed over the live one. Fix: none in the repo. Have the train report
    `sign.reason = needs-keychain-unlock` when that marker is published in
    the host heartbeat.
14. **`release-desktop.yml` build has no timeout** (stall). The default is
    6 hours. Fix: set `timeout-minutes`. The workflow is
    `disabled_manually` pending a quarantine review, so it is not edited
    here.
15. **`phantom-npm` environment is used twice** (manual gate). Both the
    `publish` and `promote` jobs bind it. If reviewers are configured, each
    release needs two approvals. Whether reviewers are configured cannot be
    seen from the repo. The [autonomy audit](../RELEASE-AUTONOMY.md)
    reports reviewer rules as a human step.
16. **Silent skip when `PHANTOM_RELEASE_TRAIN` is off** (stall).
    `publish-canonical-npm.yml` skips `publish` but succeeds overall.
    Finalize then refuses that run, because it requires all four jobs. Fix:
    have the train refuse to dispatch publish when the variable is off. The
    train guard already enforces this, so only manual dispatches are exposed.

### Not a gap

- `release.yml` fires only for `v3.3.2` and is a frozen historical lane.
- Required checks, attestation, Dependency Audit, signing and the
  `confirmedByMason`/no-spend/secret controls are kept as gates
  (see `AUTONOMY_REPOS` gate policy in `src/core/release/autonomy-audit.ts`).

## Observing a stall

The train writes `release-state.json` as the `phantom-release-state` artifact
on every run, and `phm release status --file <path>` reads it. `next` names
the first pending step, and each pending step carries a `reason`. A release
that sits on the same `next` and `reason` for more than two cadences is one of
the items above.
