# Agent identity plan

## RQ-FLAT-MESH-1
- [x] Audit bus publishers and flat read paths; record contract in AGENT-BUS.md.
- [x] Add metadata publishers, read view and authenticated peer projections.
- [x] Add regression tests, run static/docs checks, write BRIDGE_NOTES.md.

Install failed EPERM; installed phm used. MCP doctor has unavailable servers;
wire status cannot access protected client config. No host config changes.
Mesh publication uses the existing live console lifecycle: daemon loop is a
Tier-1 root, and this job may not change its protected import snapshot.
Final mesh 12/12, broader suites 159/159, authority checks 10/10; typechecks,
docs and changed-file lint pass. Full lint fails nine existing errors in three
unchanged .github files, which this job explicitly may not edit.

- [x] Inspect roster, memory, orchestration and contracts.
- [x] Extend persistent metadata and add evidence-derived identity view.
- [x] Test lifecycle, attribution, missing evidence and compatibility.
- [x] Run required checks and write BRIDGE_NOTES.md.

Muse spec access blocked by OS; accessible copy requested, not received. Implemented the explicit task's bounded identity slice; conformance to unseen spec remains unverified.
Global npm install EPERM; existing phm used. Wire status EPERM for protected client configuration. No client configuration changes.
Initial ESLint module missing and initial tsgo lookup failed; repaired with npm run install:worktree. Subsequent lint and typechecks pass.
verify-changed failed existing resource-live Tier-1 closure drift; reproduced from untouched HEAD archive. Protected snapshot untouched.
Baseline archive's npx wrapper initially failed due relative pnpm path; direct absolute vitest entry point succeeded. An initial /tmp lookup did not follow the macOS symlink and reran the worktree closure test; corrected to /private/tmp for baseline confirmation.
