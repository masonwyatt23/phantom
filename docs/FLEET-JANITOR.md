# Fleet janitor

`phm fleet janitor --json` runs four deterministic phases without changing fleet state.
The janitor makes no model, provider, publishing, credential or network call. Unix Python 3
is required. Each phase has a ten-second deadline within a thirty-second pass budget;
subprocesses have a five-second timeout. Partial or unavailable evidence exits 1.

After reviewing the report, a recurring supervisor can run:

```sh
phm fleet janitor --apply --allow jobs --allow sessions --allow worktrees --allow loops --json
```

`--apply` alone grants no destructive class. KILL blocks every action. Apply takes
`queue/dispatchd.tick.lock` non-blockingly; a busy dispatcher keeps its ownership.
The manifest installs `fleet_janitor.py` after `process_snapshot.py` and `wt-prune.py`
through `fleet/sync.py`. Preview with `python3 fleet/sync.py --bin <scratch> --json`.
Do not install over live pinned machinery. This change does not activate a schedule
or modify the host-only `dispatchd-stale-selfheal.py` (unreadable during development).

| Class | Evidence and action |
| --- | --- |
| jobs | Exact fleet launch wrapper, private process group, stable PID start/command identity and elapsed configured runtime: SIGTERM, then SIGKILL after thirty seconds. Uses the same `.rc=124` / `.maxruntime` receipts and runtime settings as dispatchd's already-wired watchdog. |
| jobs | At least thirty minutes without artifact progress, complete process inventory, no matching owner and no worktree cwd: exclusively create `.rc=124` for the normal finish path. Zero CPU alone never authorizes a reap. |
| sessions | A completed `dispatchd.batch.v1` manifest reaped at least thirty minutes ago: release its stale `.batched` member lease. Running and unknown sessions remain held. |
| worktrees | Latest attempt finished at least twenty-four hours ago and MERGED (or an empty run under runs/wt), unpinned, no live cwd/claim, no dirty, ignored or protected content: `git worktree remove`, never force, under the existing bridge lease. |
| loops | An `ai.ashlr.dispatchd` or `com.ashlr.dispatchd` service with the exact fleet dispatcher program reports no PID and a nonzero last exit/signal: `launchctl kickstart` without killing a running service or editing a plist. |

Protect rules cover Codex homes, credentials, model files, Docker, Documents, Library
and client trees. Only direct children of the two conventional fleet worktree roots
are considered. Unknown/unmerged worktrees stay, even past TTL. Malformed pins or
an unreadable jobs-ledger tail prevent worktree removal. Unsupported worker
claim release remains with RQ-WORKER-CLAIM-RELEASE-1; breaker/admission policy is
never cleared on an age guess. Expired sessions here are dispatcher batch leases,
not provider authentication sessions.

Every applied action first fsyncs an `intent`, then appends its result to
`metrics/jobs.jsonl` with schema `fleet.janitor-action.v1`, event `janitor`, job,
class, action, status, correlated action_id and bounded evidence. `done` means the recorded
operation completed; for signals it means signal delivery, not confirmed exit.
Score only `status=done` as completed actions. An unmatched intent or `uncertain`
result needs reconciliation, not a fabricated success. Audit failure stops the pass before any further mutation. Dry-run writes neither metrics nor lock metadata. Reports never
include argv, logs, account handles or credential contents.

Hermetic regression coverage:

```sh
JANITOR_TEST_HOME=$(mktemp -d)
HOME="$JANITOR_TEST_HOME" python3 -m unittest discover -s test/mac -p test_fleet_janitor.py -v
```
