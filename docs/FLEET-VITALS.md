# Canonical fleet vitals

`phm fleet vitals` reads one shared, scrubbed evidence projection. It does not
probe processes, call providers, launch work, or change admission. Use JSON for
agents and section selection for compact reads:

```sh
phm fleet vitals --json
phm fleet vitals --json --section lanes
phm fleet vitals --json --section admission
```

Sections are `sources`, `lanes`, `budget`, `admission`, `host`, `recent`, and
`findings`. Unknown or duplicate options exit 2; a successful read exits 0 even
when sources are missing. Inspect evidence states instead of treating exit 0 as
fleet health. `ASHLR_RUNS_DIR` selects a captured runs directory; the default is
`~/.ashlr-runs`.

## Contract: fleet.vitals.v1

The internal TypeScript export
`buildFleetVitals(runsDir: string, now: number): FleetVitals` in
`src/core/fleet/vitals.ts` is the assembly path. `now` is epoch milliseconds.
It returns the same JSON for fixed files, file times, and `now`; invalid time
throws. This is an internal module contract, not a new package entry point.
`schema`, `assembledAt`, and `truncated` accompany the selected CLI section.

Every source has `kind`, `state`, `observedAt`, `recordedAt`, `summary`, and `truncated`.
States are `fresh`, `stale`, `missing`, or `unavailable`; `observedAt` is the
file modification time, never assembly time. `recordedAt` retains an embedded
tick/record time when available; an old recorded time also makes live evidence
stale, even if the file was just copied. Live records older than 30 minutes
or more than one minute in the future are stale. Durable `leader/VISION.md`
does not expire: `kind: durable` means document context, never live status.
The human formatter labels it “present; durable context, not live status”.
Invalid, unsafe, unreadable, or oversized snapshots are unavailable, not empty.

Sources are queue `status.json`, `admission.json`, `budget-overrides.json`,
`resources.json`, and `route-state.json`; metrics `jobs.jsonl`,
`work-market.jsonl`, and `heartbeat-fast.jsonl`; `dispatch-events.log`,
`dispatchd.log`, the vision, and supervisor `status-*.md` files. The main guardian
is always attributed, including when missing. Up to 16 additional supervisor
files are selected by filename from a bounded directory scan. An incomplete scan
omits extra supervisors and marks truncation rather than selecting an unstable subset.

Derived rows carry source/state/time attribution. Missing numbers are `null`.
Lanes use dispatcher status; each lane also has separate budget attribution.
Budget readings prefer that lane's override, then resources, then the status
copy. Explicit reading timestamps and stale flags prevent a recently copied
reading from concealing its age. A status budget copy without a measurement time
has unavailable freshness. An unreadable overrides file cannot be hidden by a
status copy. Admission prefers the dedicated record;
only a missing record falls back to status. Host process/worktree/load figures
inherit admission attribution; memory/disk fields use `host.status` attribution.
Recent events retain their own event time separately from source observation.
Tail evidence is a sample, not an exhaustive total or proof of inactivity.

Heartbeat findings accept JSONL snapshots with a `findings` array, or individual
`id`/`code` records marked `state/status: open`, `open: true`, or `event: finding`.
A snapshot replaces the prior set. Resolved records remove the matching id.
Only id, code, lane, and severity are exported, never finding messages.
RQ-HEARTBEAT-DUAL-1 is not implemented in this checkout. Its fast worker and
future MCP, desktop, leader, and comms consumers must call `buildFleetVitals`
and preserve attribution; they must not introduce another file-reading digest.
The teammate responder already delegates to this module and keeps its framing
and 20,000-character response bound. Existing specialized fleet commands retain
their own command contracts; this change does not replace those APIs.

## Bounds and privacy

JSON and document snapshots are limited to 128 KiB per source. Append-only
ledgers/logs read only the final 96 KiB, discarding incomplete boundary records.
Reads reject symlinks, hardlinks, unsafe ownership/permissions, and files that
change during a read. The directory scan examines at most 256 entries.

Projection limits are 32 lanes, 24 recent events, 24 findings, and 32 KiB of
serialized UTF-8 JSON. Trimming preserves valid JSON and source attribution and
sets `truncated`; it never silently presents omitted rows as an exhaustive set.
Free prose is secret/privacy scrubbed before truncation. Structured data uses
allowlisted fields; arbitrary message bodies, handles, prompts, and raw log
suffixes are excluded. Log events expose only operational columns. Credentials
are never resolved. The module makes no claim that an unobserved value is zero.

Regression coverage: `test/fleet-vitals.test.ts` and the teammate freshness,
preservation, salvage, and worker suites, all using temporary directories.
