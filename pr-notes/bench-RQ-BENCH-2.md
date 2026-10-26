# RQ-BENCH-2: full-suite timing profile

## Capture provenance

- Base revision: `a6f3c32339411eb2d57cb35d4c78c33127bbb8e7`.
- Assigned worktree: `RQ-BENCH-2`, branch `codex-bridge/RQ-BENCH-2`.
- RQ-BENCH-1's sibling worktree has the same base revision. Its completion handoff was unavailable when inspected; predecessor completion and the requested run order are **unverified**. The router assigned separate worktrees despite the queue text saying “same worktree.”
- Scope: the exact requested default Vitest configuration (backend `unit` and `real-io` projects). The separately configured web suite is outside this command.
- Source changes for this job add only the profiling utility and its pure regression tests; existing tests and runner configuration are unchanged.
- Dependencies were initially incomplete (truncated TypeScript and missing ESLint files). Restored with `npm ci --ignore-scripts --no-audit --no-fund`, without manifest or lockfile changes.
- Shared host load was approximately 90–107 during preparation on 18 logical CPUs. This is an observational profile, not an idle-host benchmark or evidence of a performance regression.
- Mid-capture observation at 16:31 EDT on 2026-10-26: load averages **146.51 / 171.18 / 163.42** (1 / 5 / 15 minutes) on 18 logical CPUs; `memory_pressure -Q` reported 46% system-wide memory free. File spans from this heavily loaded host require a fresh, quieter confirmation before drawing optimization conclusions.
- The optional prebuild was interrupted after over ten minutes at TypeScript compilation without diagnostics or compiled CLI output. The requested invocation proceeds against this source checkout; compiled-artifact-dependent failures are retained. No build or other validation from this task runs concurrently with the capture.

## Reproduction

For a built-artifact-qualified repeat, complete `npm run build` first. This capture's prebuild did not complete, as noted above. Run the capture with a fresh temporary HOME, preserving the repository's configured worker counts:

```sh
npm run build
task_profile_home=$(mktemp -d)
HOME="$task_profile_home" CI=1 npx vitest run --reporter=json --outputFile=/tmp/vitest-profile.json
node scripts/vitest-profile.mjs /tmp/vitest-profile.json WALL_SECONDS
```

`WALL_SECONDS` must be independently measured around the complete Vitest process, including startup and reporter output. This capture uses Python `time.perf_counter()` around `subprocess.run`; Vitest's top-level start timestamp is not treated as an end timestamp, and file durations are not summed to estimate wall time. Each subsequent test invocation also uses a fresh temporary HOME.

The utility emits the top 25 by reporter span, every strict >30-second RQ-PERF-2 candidate, test counts and status. It refuses invalid timings, invalid counts, duplicate normalized paths and files outside the repository. Only filenames, timings, statuses and aggregate counts are rendered; assertion messages and captured output are not copied into this report.

## Capture result

The measured full-suite invocation is running. Final timings and exit status will replace this note after completion.
