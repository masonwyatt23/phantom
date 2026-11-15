# Task plan: Grok Bot routine offload

- [x] Inspect existing fleet surfaces and protected paths.
- [x] Implement file-backed drive stub, metrics and Mac job definitions.
- [x] Run fixture tests, typecheck, lint and docs checks; record qualification limits.
- [x] Write BRIDGE_NOTES.md with results and net LOC.

Status: implementation complete, full repository qualification unverified. No commit, push or publication is authorized.

Errors encountered: first fixture assertion counted transitions instead of unique jobs (corrected 5 to 4). Initial typecheck and lint could not start due to incomplete node_modules; reinstalling lockfile dependencies.

Fleet-watch: 13 timeouts repeated in isolation; a focused test against the untouched HEAD fleet implementation reproduced the same timeout. Temporary diagnostic files removed.

Parallel full typecheck/lint produced no further output for about ten minutes; interrupted both (exit 130) and restarted sequentially to reduce resource contention.

Sequential full lint also interrupted after more than five minutes without further output. Changed-file ESLint, strict core typecheck, both lint guards, docs and 54 focused tests passed.

---

# Task Plan: RQ-ROUTER-JEV-1

## Goal
Ship an advisory, schema-validated router with local-first decisions, bounded escalation, deterministic fallback and dispatcher audit records. Leave changes uncommitted and under 20 files.

## Phases
- [x] Read repository and Phantom gateway instructions; install isolated CLI.
- [x] Inspect configuration and client contracts.
- [x] Implement typed routing and read-only dispatcher observation.
- [x] Add regression coverage and documentation.
- [ ] Run required checks and write BRIDGE_NOTES.md.

## Decisions Made
- Reuse existing Jev transport and its budget / kill controls.
- No launch behavior or live fleet installs change.

## Errors Encountered
- Global npm installation EPERM; installed successfully with /tmp/rq-router-jev-tools prefix.

## Status
Verifying implementation and dispatcher fixtures.

- Initial typecheck could not start (missing tsgo); npm run install:worktree restored dependencies.
- MCP doctor reported unavailable companion servers; wire/authority inspection was read-only. No gateway configuration or auth was changed.
# Ecosystem onboarding

- [x] Inspect Phantom gateway instructions and existing onboarding/companion contracts.
- [ ] Implement bounded, names-only detection and a bundle grant with per-capability wiring receipts.
- [ ] Expose the wizard through CLI and desktop settings; document commands.
- [ ] Run named hermetic tests, static checks and docs validation; write BRIDGE_NOTES.md.

Constraints: fewer than 20 files; no commits/pushes/publication; no TCC changes;
no credential values in reports or receipts; no implicit enrollment or spending.

Errors: initial exploratory searches included missing paths and overly broad output;
subsequent reads use exact paths. No source changes made during discovery.


# RQ-HEARTBEAT-DUAL-1

## Goal
Implement an advisory local fast heartbeat, persisted adaptive timing, bounded evidence and findings, and deep leader consumption in fewer than 20 changed files. Leave all work uncommitted.

## Phases
- [x] Inspect repository guidance, transport, evidence and leader entry points.
- [x] Implement bounded inputs/schema, adaptive tick and durable deduplication.
- [x] Wire CLI, foreground Mac runner and native deep leader; document shell handoff.
- [x] Verify hermetic heartbeat/leader/authority regressions, static checks and docs; write BRIDGE_NOTES.md.
- [x] Record the full repository lint result and final net LOC.

## Decisions
- Local fast model only; optional paid fallback omitted to guarantee zero API spend.
- Reuse existing transport and locking/storage primitives; do not install live scripts.
- Native leaderTick consumes findings; live leader-tick.sh is not tracked/readable here.

## Errors encountered
- Global npm install: EPERM in configured prefix; temporary-prefix retry succeeded (3.30.31).
- GitHub PR query: host gh configuration denied; provided fleet context has no duplicate heartbeat work.
- Wire status: client config access denied; gateway tooling unavailable in this session.
- Two inspection globs had no matches; followed with explicit paths.

## Status
27 heartbeat tests, 25 leader tests and 10 authority tests pass. Full typecheck and verify-changed pass. Four unrelated baseline assertions remain in broader suites; the broader leader timeout passed unchanged on isolated rerun. CODEOWNERS and the closure snapshot were regenerated with the documented command (no new roots; three read-only heartbeat modules). Full repository lint completed with three pre-existing no-control-regex errors in unchanged leader-reply tests and 273 warnings. Final diff has 19 files and stays uncommitted; BRIDGE_NOTES.md contains exact commands, pass/fail counts, limits and net LOC.
