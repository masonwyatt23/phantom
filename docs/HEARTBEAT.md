# Two-tier fleet heartbeat

The fast heartbeat observes fleet inefficiencies using the local `fast` model.
The deep Leader consumes its findings and chooses corrections through existing
authority and admission gates. The fast observer never launches, kills,
requeues, merges, sends messages or changes routing, budgets or fleet state.
`lane_adapt.py`, `zombie-reaper` and `restock-author` keep their existing jobs.

## Run and inspect

```sh
npm run dev -- heartbeat tick --json
npm run dev -- heartbeat status --json
npm run dev -- heartbeat digest --json
bash contrib/mac/fast-heartbeat.sh
```

Installed equivalents are `phm heartbeat tick|status|digest|watch --json`.
`tick` runs only when due; `watch` runs in the foreground and exits on SIGINT
or SIGTERM. No service is installed. `ASHLR_RUNS_DIR` selects an isolated runs
directory; the default is `~/.ashlr-runs`. Status and digest are read-only.

The base interval is 300 seconds. Three launches in the current dispatcher
tick, three admission flips over thirty minutes, idle capacity with queued work,
or a high-severity merge/admission/starvation finding selects 60 seconds.
Known idle lanes with no queue, launches or findings select 900 seconds.
Unknown inputs retain the base interval. The foreground runner wakes every
minute; persisted timing prevents extra model calls after a restart or from
concurrent invocations. Changes are detected at the next due tick.

## Evidence and transport

Inputs reuse the teammate context's fleet sources: `queue/status.json`,
`queue/admission.json`, `dispatch-events.log`, `metrics/jobs.jsonl`, plus
`queue/budget-overrides.json` and `metrics/work-market.jsonl` reason codes.
Each read is capped at 64 KiB, each displayed source at 3,000 bytes and the
serialized digest at 24 KiB. Every source carries its own file observation
time and fresh/stale/unavailable label. Status/admission embedded timestamps
can make freshness older, never newer. Live sources stale after five minutes;
budget overrides after thirty. Old log tails are historical observations,
not evidence of current idleness. Missing evidence is unknown.

The shared strict text transport calls only `http://127.0.0.1:8123/v1` with
model `fast`, no credentials and no tools, `redirect: error`, a 20-second
deadline, 64 KiB request/response caps and 2,048 output tokens. The prompt
labels all input untrusted. There is no paid fallback or cloud route.
Malformed, secret-bearing, oversized, timed-out or unavailable completions
produce a `degraded` tick with no new findings. Storage failure returns a fixed
degraded reason without printing private errors; the next watch iteration retries.

## Records, decay and outcomes

`heartbeat/state.json` stores last tick, interval and reason, model health,
consecutive failures, bounded admission history and at most 128 open findings.
A process lock serializes updates. State is replaced atomically; private
`metrics/heartbeat-fast.jsonl` is append-only. Both use mode 0600. Unsafe links
or files are refused. Invalid existing state is reported as degraded.

Every completed tick validates against `tickSchema` in
`src/core/heartbeat/schema.ts`: schema `heartbeat.fast.v1`, event
`heartbeat.tick`, `ts`, `interval_s`, `interval_reason`, `model`, `status`,
`findings`, `observed_ids` and `suggested_actions`. Finding kinds are
`stale_job`, `idle_lane_with_queue`, `merge_stall`, `admission_flap`,
`quota_waste`, `empty_signal_spike` and `worktree_leak`; severity is low,
medium or high. Evidence is bounded text, with optional job and lane IDs.

Stable finding IDs identify kind/job/lane. Unchanged findings are emitted
at most once per 15 minutes; changed evidence or severity emits immediately.
`observed_ids` records confirmations without repeating finding text or advice.
Unconfirmed findings lose one severity level per ten minutes and expire after
thirty. Suggested actions accompany emitted findings only and are advisory.

The deep digest reads at most 1 MiB/120 trailing rows from the last hour,
validates them, excludes future/invalid rows, applies decay and reports up to
16 findings and repeated high-severity IDs. `heartbeat.tick` timestamps,
finding IDs and job/lane metadata allow offline joins against `metrics/jobs.jsonl`
for eval-report/job-latency analysis. These are correlation hooks; neither
report scores these records automatically and no router tuning is applied.

## Deep Leader handoff

The native `leaderTick` evidence builder includes the digest in a labelled
UNTRUSTED DATA block. Its task instruction prioritizes repeated high-severity
findings, fresh verification, sanctioned requeues, lane retiering and restock
waves. Heartbeat escalations are for credentials, payments or 2FA. Existing
cadence, action vocabulary and policy checks are unchanged.

The host's 1,800-second `leader-tick.sh` is not tracked in this checkout.
For that wrapper, include `phm heartbeat digest --json` output in the existing
untrusted input section and the instruction exported as
`DEEP_HEARTBEAT_INSTRUCTION` in its standing prompt. The wrapper/prompt is a
Security-pinned surface: review and re-pin that integration before deployment.
This source change does not install or modify the live wrapper or launchd job.

## Verification

```sh
env HOME="$(mktemp -d)" npm run test:ci -- test/heartbeat-fast.test.ts test/heartbeat-deep.test.ts
node scripts/verify-changed.mjs
npm run check:docs
```

Tests use temporary runs directories and mocked loopback responses. A real
local-model run needs an already-running local `fast` endpoint; no test starts
one or contacts a paid provider.
