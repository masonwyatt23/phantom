# Fleet waste map — RQ-CMP-FLEET-AUDIT-1

Audit date: 2026-11-14. Source revision: `c5fed9a5a70dc51721b660d69179581f120296c7`.
This is a source audit with conditional estimates, not a measured fleet leaderboard.
The local jobs ledger and queue snapshots refused reads; the supplied roster has
39 live sessions against 67 targets, including 14 nominal personal-lane vacancies.
Neither remaining quota nor the personal reset instant was available.
Evidence and roster transcription: `BRIDGE_NOTES.md:5–20`.

The highest-leverage sequence is to repair yield accounting, shorten the serialized
publication path, then admit more distinct work on the personal subscription when
fresh reset evidence warrants it. The five priorities below rank expected reach and
recoverable work, not observed dollars or hours lost. Their source evidence is cited
per finding; all proposed targets and savings examples are recommendations or scenarios.

## Scope and evidence limits

| Requested surface | Evidence available at this revision |
| --- | --- |
| dispatchd and adaptation | `contrib/mac/dispatchd.py:1515–1570` implements adaptation inline; `contrib/mac/work_market.py:66–123` consumes optional adaptive observations. No tracked `lane_adapt.py` was found (`BRIDGE_NOTES.md:18`). Its host behavior is unknown. |
| launch.sh | The inventoried source is a **candidate**, `contrib/mac/host-integration/launch.candidate.sh`, explicitly pinned and adoption-dependent (`fleet/manifest.json:36`). This report does not equate it with the installed launcher. |
| restock-author | No source mirror for `codex-restock-author.sh`; only inventory evidence (`docs/strategy/MODULE-MAP.md:280`). Author-model token burn and cadence cannot be estimated. Deterministic replenishment is inspectable in `contrib/mac/restock.py:3–21`. |
| fleet projections and producers | Finish usage and empty fields: `contrib/mac/dispatchd.py:1162–1172`; legacy rollup: `contrib/mac/dispatchd.py:2251–2295`; PR-state reconciler: `contrib/mac/metrics-outcomes:71–115`. The installed outcomes wrapper is ops-owned (`fleet/manifest.json:41`), so its invocation of that helper is unverified. |
| drive nodes | Worker heartbeat/renewal and witness transport are inspectable (`src/core/drive/nodes/worker.ts:37–114`, `src/core/drive/nodes/pool-host.ts:57–87`). Deployment and traffic are unknown (`BRIDGE_NOTES.md:20`). |

No exact duplicate appears in the supplied excerpt, but a fresh PR search was
permission-blocked; do not treat that as proof that no overlapping PR exists.
No operational changes or publication accompany this audit (`BRIDGE_NOTES.md:16–17`,
`BRIDGE_NOTES.md:26–28`).

## Per-lane yield: what can and cannot be ranked

All twelve roster lanes have **unknown** merged-PR yield, consumed tokens, elapsed
worker-hours, failure rate and observed EMPTY rate in this audit. A live/target
count measures occupancy, not productivity. No lane can honestly be named the
best producer or worst quota burner from this snapshot (`BRIDGE_NOTES.md:7–15`).

Use these definitions for the requested token/hour comparison. They are the
recommended measurement contract, not fields already present in every producer:

- For a fixed launch cohort, let `M` be distinct verified merged PR URLs, `T` all
  recorded tokens across its attempts (including failed/empty retries), and `H`
  summed attempt worker-hours. Report `M / (T / 1e6)` merged PRs/Mtoken and `M / H`
  merged PRs/worker-hour, plus `T / wall-window-hours` for quota burn. Keep these
  separate: multiplying token totals by elapsed time is cohort-size-dependent.
- Report token, duration and outcome coverage beside every ratio. Incomplete
  usage makes full-cost yield unknown; a measured-subset ratio must say so. Keep
  unresolved PRs and right-censored running attempts visible; compare lanes with
  the same observation horizon. Distinguish merged from post-merge stable.
- Bind records to attempts, then PR URLs; allocate each batch's session usage
  once, not once per member. Deduplicate PR URLs across retries and lane moves.
  Existing attempt-aware completion logic is a starting point, not a token-cost
  calculator (`contrib/mac/dispatchd.py:2083–2146`).

The missing-data convention already has precedent: `metrics-ingest.rollup`
includes all completed-job token costs and withholds cost/merge when coverage is
incomplete (`src/core/fleet/metrics-ingest.ts:135–158`). Its input is a separate
versioned feed, so raw jobs.jsonl cannot simply be substituted
(`src/core/fleet/metrics-ingest.ts:163–179`).

| Signal | Actual meaning and bias to account for |
| --- | --- |
| `finish.empty` | Tracked diff plus untracked files relative to launch base, excluding BRIDGE_NOTES; unreadable diff returns unknown. It is not proof that the model failed or that nothing useful happened (`contrib/mac/dispatchd.py:143–167`). |
| `rollup_24h.empty_rate` | Empty finishes / finishes joined to launches in the last 24h. Unknown `empty` contributes no numerator but still contributes a finish. Finish and publish maps are keyed only by job, so reused IDs can bind multiple launches to one latest result (`contrib/mac/dispatchd.py:2271–2294`). |
| Market `empty_rate` | Fresh adaptive value if valid (300-second age limit), otherwise measured booleans among the last 20 finishes; fallback has no time-window filter. `yield_rate` is only supplied by adaptive observations, otherwise null (`contrib/mac/work_market.py:73–118`). |
| `EMPTY_SIGNAL` | No literal producer found in the requested source roots; rate unknown. Do not alias it to another event without the host producer/schema (`BRIDGE_NOTES.md:18`). |
| Lane streak verdict | Default 90-minute launch cohort; first terminal is publication or an empty kind. Burning requires at least 3 launches and 3 endings, zero publications and at least 80% empty. Failures without a recognized terminal can remain counted as running; publication is not merge (`src/core/fleet/lane-empty-streak.ts:44–55`, `src/core/fleet/lane-empty-streak.ts:82–125`, `src/core/fleet/lane-empty-streak.ts:130–170`). |
| Usage and time | Claude totals include cache-read/write input; Devin includes recorded response usage and ACUs; other lanes rely on the last `tokens used` line. Missing stays null in the producer. `wall_s` is log mtime minus base mtime, a session proxy, not measured model time (`contrib/mac/dispatchd.py:210–233`, `contrib/mac/dispatchd.py:300–334`, `contrib/mac/dispatchd.py:1162–1171`). |

**Code-derived distortion example:** three finished runs cost 100,000 tokens each;
one merges, two finish empty. Legacy `roll()` reports 100,000 tokens/merged PR,
while full cohort cost is 300,000: efficiency looks **3× too good**. Its
`tokens_per_hour_6h` also turns missing token counts into zero. This is an
executable synthetic example of the expressions, not a fleet measurement
(`contrib/mac/dispatchd.py:2259–2260`, `contrib/mac/dispatchd.py:2278–2292`).

There is also a schema mismatch to resolve: the reconciler copies the publication
row and changes `outcome`/`status`, retaining an original `event: publish`.
The legacy rollup only indexes `event: outcome` and tests `state: MERGED`, so
that producer shape can leave a real merge uncounted. The newer verified path
explicitly handles reconciler resolution rows (`contrib/mac/metrics-outcomes:99–105`,
`contrib/mac/dispatchd.py:2273–2286`, `contrib/mac/dispatchd.py:2107–2112`).

## Queue economics and age

Current age bins (`<15m`, `15–60m`, `1–6h`, `6–24h`, `>=24h`), p50/p95 and the
untimed fraction are **unknown**: ready.tsv and jobs.jsonl could not be read
(`BRIDGE_NOTES.md:7–10`). Recommended next capture: record distinct current
READY IDs, first enqueue/eligibility times, current blocked reason, and the five
bins above. Report parked age separately from runnable waiting age.

Restock writes six fields without a timestamp into ready.tsv, while claimed.tsv
gets an epoch. Dispatcher records first observation as an `enqueue` event and
an exclusive `.enqueued` receipt; it skips parked rows. That is first observed
queue age, not necessarily authoring age, and the shown loop does not reset a
receipt on each retry. `queueShape()` only ages rows carrying usable `at` and
otherwise increments `untimedReady`. Join evidence explicitly; never infer age
from a rewritten queue file's mtime (`contrib/mac/restock.py:603–618`,
`contrib/mac/dispatchd.py:1468–1481`, `src/core/fleet/queue-shape.ts:96–106`).

| Driver | Economics and classification |
| --- | --- |
| Replenishment floor | `want = 3 * max(target-running, 4)` means **12 rows even with zero free slots**, before subtracting existing valid ready work. Personal's supplied 14 free slots imply a 42-row desired buffer before subtraction. This is inventory, not 42 launches. Fixable excess if service is slower than supply (`contrib/mac/restock.py:79–87`, `contrib/mac/restock.py:133–152`, `BRIDGE_NOTES.md:12`). |
| Global queue bound | Capacity goal is `max(8, ceil(2.5*cap))`; restock truncates output to the available allowance and rechecks under lock. Do not claim an unbounded ready queue from the 12-row floor alone. Parked rows are excluded from this depth (`contrib/mac/queue_gate.py:13–30`, `contrib/mac/restock.py:473`, `contrib/mac/restock.py:526–528`). |
| Priority without age promotion | Sort keys favor work priority, reset-risk preference, job bucket, repo rank, size and path, not waiting age. Continual higher-ranked arrivals can starve lower-ranked rows. Fixable within priority classes; do not displace urgent work or weaken eligibility (`contrib/mac/dispatchd.py:1063`, `contrib/mac/dispatchd.py:1650–1655`). |
| Admission and dependencies | Holds, quota, capabilities, explicit local routing and saturation are structural constraints. Parked dependency rows wait for completion evidence; blocked lines stay in the queue while scanning continues. Resolve the cause rather than counting this as model failure (`contrib/mac/work_market.py:136–153`, `contrib/mac/restock.py:405–425`, `contrib/mac/dispatchd.py:1756–1774`). |
| Route residency | An assigned route has a 60-minute residence, at most 2 moves in 6h, and no move once launched; hard-down can bypass residence, not the move cap. This trades some waiting for stability; a slow lane alone is not hard-down (`contrib/mac/dispatchd.py:1331–1342`). |
| Precheck retries | Code 13 parks with 1, 2, 4, 8, 16, 32, then 60-minute retry delays; changed queue/prompt identity resets history. Current dispatcher allows at most 8 optional prechecks per tick, with 20-second subprocess limits inside a 30-second launch phase. Two slow checks can exhaust that phase; the nominal 8-check budget is not a 160-second allowance (`contrib/mac/launch_precheck.py:89–108`, `contrib/mac/launch_precheck.py:111–134`, `contrib/mac/dispatchd.py:115–118`, `contrib/mac/dispatchd.py:1314`, `contrib/mac/dispatchd.py:1615`, `contrib/mac/dispatchd.py:1829–1845`). |

Separate these empty/skip populations before calculating waste:

| Event/path | Cause and disposition | Structural vs fixable |
| --- | --- | --- |
| Candidate `SKIPPED-EMPTY` | `empty_shape()` drops repeated-empty IDs, targetless FIXUP/LAND/SALVAGE and CONSOLIDATE with fewer than two PRs; an open `after` dependency defers. In dry mode it logs but still launches (`contrib/mac/host-integration/dispatchd.candidate.py:662–696`, `contrib/mac/host-integration/dispatchd.candidate.py:960–971`). | Avoided model calls when applied; targetless authoring is fixable, dependency wait structural. Candidate semantics are not proof of current installation. |
| Current `SKIPPED_EMPTY` / `skipped_empty` | `empty_reason()` requires exit 0 + empty, same-base/prompt or repeated task evidence in 24h; two matching distinct latest task records can suppress recuts across IDs/lanes/bases (`contrib/mac/launch_precheck.py:191–220`, `contrib/mac/dispatchd.py:1675–1688`). | Avoided launches, not consumed-token failures. Existing protection; improve task identity only with acceptance evidence. |
| Current `DONE-NOOP` / precheck | Dispatcher code 13 parks; other returned codes emit `skipped_empty` and retire the row. Restock parks 11/12/13. Same-ID streak threshold is 2 but runs only when the expected task line exists (`contrib/mac/dispatchd.py:1829–1845`, `contrib/mac/restock.py:455–461`, `contrib/mac/launch_precheck.py:80–86`). | Keep stage and code: a suppressed job is not a completed model attempt. Align differing producer dispositions where evidence supports it. |
| `BRANCH_IN_WORKTREE` | Candidate `prep_branch()` checks the repo's worktree inventory; refusal exits 5. Dispatcher logs it as neither failure nor solo requeue; batch leases are released (`contrib/mac/host-integration/launch.candidate.sh:22–40`, `contrib/mac/dispatchd.py:951–976`). | Protecting live/unpublished work is structural. Stranding an abandoned solo assignment without a durable reconciliation action is fixable; never delete its worktree merely to launch again. |

## Five largest leverage opportunities, ranked

These are ranked **source-derived risks**, with confidence in the mechanism and
unknown fleet incidence. The bounds below are not additive savings forecasts.

| Rank | Exact owner and mechanism | Quantification, fix sketch and acceptance measure |
| --- | --- | --- |
| **1 — Correct the yield feedback before scaling quota** | `dispatchd.roll()` and its budget projection (`contrib/mac/dispatchd.py:2254–2294`); `work_market.choose()` orders lane preference and occupancy ahead of empty/yield evidence (`contrib/mac/work_market.py:154–162`). | Synthetic 3× cost understatement above; a preferred eligible lane wins even at 90% empty against a nonpreferred lane at 10%, all else equal. Use attempt/PR-bound full-cost counters, coverage and UTC timestamps; then test a routing score that uses comparable successful output per cost ahead of soft preference. Keep requirements/holds/cost ceilings. Accept only if replay preserves attribution and reduces failed/empty tokens per merged result without hiding unresolved attempts. Confidence: high in expressions, unknown operational impact. |
| **2 — Shorten the single publisher's critical path** | `dispatchd.reap_worktrees()` gates all candidates on `publish_busy`, then sets it for the first spawn (`contrib/mac/dispatchd.py:1107–1176`). | If a publisher occupies the slot for `p` seconds, service is at most `3600/p` jobs/hour before scheduling gaps; hypothetical `p=120` gives **30/hour** and 39 simultaneously finished jobs need at least **78 minutes**. Preserve ordered queue entry and the pinned secret gate; prepare independent read-only checks before the serialized handoff, cache valid evidence by exact tree, and apply producer backpressure from measured drain rate. Record agent-finished, publish-start and queue-enter separately. Success: lower p95 finished-to-queue time at unchanged verification coverage. Confidence: high source bound; `p` and backlog unknown. |
| **3 — Stop buying queue inventory that cannot drain** | Restock need loop (`contrib/mac/restock.py:79–87`), dispatcher restock trigger and priority order (`contrib/mac/dispatchd.py:1368–1396`, `contrib/mac/dispatchd.py:1650–1655`), shared precheck (`contrib/mac/launch_precheck.py:80–108`). | The 12-row minimum, 42-row personal scenario and 30s/20s precheck mismatch above are concrete bounds. Produce a buffer from observed service time and eligible headroom, with age promotion within a priority class. Share identity-bound precheck receipts and give each check only the remaining phase budget; unknown evidence defers rather than falsely completing work. Retain global queue limits and current empty-repeat suppression. Success: lower runnable p95 age and precheck seconds/job with no fall in launches of eligible distinct work. Author-token savings remain unknown because restock-author is not mirrored. |
| **4 — Recover stranded branch ownership before checkout** | Candidate `prep_branch()` (`contrib/mac/host-integration/launch.candidate.sh:22–45`); dispatch launch-outcome loop (`contrib/mac/dispatchd.py:951–976`); same-path guard (`contrib/mac/dispatchd.py:1784–1786`). | Each alternate-path branch collision can consume one dispatch claim and then remove the solo row from active retries; the normal same-path guard already defers safely. Candidate fetch precedes branch refusal (`contrib/mac/host-integration/launch.candidate.sh:35–40`), so repeated recuts also pay avoidable setup. Reconcile branch→worktree→live claim before checkout; attach to an existing durable handoff, or park with a reason and bounded reinspection. Preserve dirty work and unpublished commits. Success: zero unresolved skip receipts and fewer checkout attempts per accepted job. Frequency and seconds lost unknown. |
| **5 — Consolidate node lease traffic without weakening fencing** | `runNodeWorker()` creates a timer per active attempt (`src/core/drive/nodes/worker.ts:82–90`, `src/core/drive/nodes/worker.ts:107–114`); `callPool()` and `callNodeSsh()` are synchronous (`src/core/drive/nodes/pool-host.ts:76–87`, `src/core/drive/nodes/ssh.ts:15–24`). | Nominally **40 RPCs/minute/slot**, or 240/minute at 6 active slots (2 calls every 3s); normal worker→primary→witness adds another SSH hop (`src/core/drive/nodes/pool-host.ts:61–68`). An outer SSH call can block 12s, and fallback can add another call. This can delay sibling renewals against default 30s claim/node TTLs (`src/core/drive/nodes/index.ts:94–97`). Use one asynchronous session heartbeat, bounded batched claim renewal and per-claim deadlines; retain witness authority and kill-on-loss. Success: lower RPCs/slot-minute and no false lease loss under injected slow transport; no stale completion accepted. Confidence: high mechanism, deployment unknown. |

Two accounting follow-ups belong with rank 1. `reconcile()` rereads the full
ledger for **every published key**, including already terminal ones, and performs
serial lookups for unresolved URLs: `P` publications and `N` ledger rows imply
O(P×N) parsing per pass. A hypothetical 300 unresolved URLs each timing out at
60s would take about **5 hours**, excluding parsing. This is a helper bound,
not an observed production duration or proof of installed wrapper behavior
(`contrib/mac/metrics-outcomes:42–49`, `contrib/mac/metrics-outcomes:76–114`,
`fleet/manifest.json:41`). Use an incremental index with append-safe reconciliation.

Also, normal finish telemetry is written after publish holds and busy-publisher
checks, so a finished-but-unpublished run can be absent from the finish-based
denominator. Emit its finish once when exit and diff evidence are available,
independently of publication admission (`contrib/mac/dispatchd.py:1138–1172`).
Existing `verified_completion()` handles attempt boundaries and reconciled
outcomes more carefully; build on it rather than adding a third incompatible
completion definition (`contrib/mac/dispatchd.py:2083–2146`).

## Recommended targets for the next 24 hours

Window: the 24 hours after this audit. Reset proximity is **unverified**; the
request suggests it matters but supplies no timestamp. Treat column B as a
conditional burst ceiling, not a command or promise of usable slots. Column A
keeps observed active paid work steady, admits one explicitly local task, and
avoids ramping additional metered work while yield is unknown. The supplied
roster and all its targets are external observations (`BRIDGE_NOTES.md:10–15`).

| Lane | Supplied live/target | A: initial ceiling | B: verified pre-reset ceiling | Reason for this recommendation |
| --- | --- | --- | --- | --- |
| codex-cmp | 5/5 | 5 | 5 | Preserve current occupancy; no balance or yield evidence for expansion. |
| codex-personal | 18/32 | 18 | 24, then 32 | Allocate the next 6, then 8 eligible distinct jobs here only if fresh included-quota evidence predicts unused capacity at reset. |
| claude | 6/9 | 6 | 6 | Preserve observed work; source default cap is 8, so the roster's 9 requires a host override before any future recommendation above 8 (`contrib/mac/dispatchd.py:39`). |
| devin | 6/6 | 6 | 6 | No additional metered concurrency; source spike step-down cannot lower 6 further (`contrib/mac/dispatchd.py:1559–1566`). |
| devin-flash | 0/1 | 0 | 0 | No measured yield or inspected readiness; defer expansion. |
| claude-api | 0/0 | 0 | 0 | Keep disabled; source pacing owns any authorized API-credit target (`contrib/mac/dispatchd.py:1523–1533`). |
| codex-local | 0/1 | 1 | 1 | One bounded explicitly local task if loopback health and admission pass; no spillover from cloud work (`contrib/mac/work_market.py:141–142`, `contrib/mac/dispatchd.py:1775–1783`). |
| gemini | 0/0 held | 0 | 0 | Preserve supplied hold. |
| zai | 3/3 | 3 | 3 | Preserve occupancy while collecting cost/outcome coverage. |
| agy | 0/0 | 0 | 0 | No readiness or productive-yield evidence for activation. |
| grok | 0/4 | 0 | 0 | Resolve idle-cause evidence before adding work. |
| cursor | 1/6 | 1 | 1 | Preserve the active trial; no yield evidence for five more. |
| **Total** | **39/67** | **40** | **46, then 54** | Nominal sum only; actual admission may be lower. |

These are desired planning ceilings, not slot-file edits. Installed floors,
holds, resource pressure and `min(sum targets, adaptive cap, operator hard_cap)`
still bind; they must be read before adopting the plan. Do not kill current jobs
to match a table. Repo defaults differ from the supplied roster, and dynamic
lanes require explicit executor capability evidence
(`contrib/mac/dispatchd.py:36–42`, `contrib/mac/dispatchd.py:1291–1292`,
`contrib/mac/dispatchd.py:363–368`, `contrib/mac/restock.py:76–78`).

Proposed burst decision: require a fresh personal reading, positive remaining
included quota, a reset within 6h, and projected unused quota at that reset;
the 6h threshold is an audit recommendation. Review after 30 minutes or 10
completed attempts, whichever comes first. Advance 24→32 only with sufficient
eligible supply, no rising empty/failure trend and publication drain capacity.
When those observations are missing, remain at A. For intuition, the 14 vacant
personal slots represent **28 worker-hours** over a hypothetical 2h reset
window, or 84 over 6h; neither is a token estimate or promised recovery
(`BRIDGE_NOTES.md:12–15`).

At reset, refresh the reading and re-evaluate against the new horizon; an expired
subscription reading cannot authorize continued bursting. Current waste-risk
projection already requires known, nonstale evidence and a 120s projection age,
and only boosts included personal/Claude lanes. It also raises mid→work and
work→frontier automatically; do not assume that higher tier improves merge
yield merely because quota expires (`contrib/mac/dispatchd.py:1344–1366`,
`contrib/mac/dispatchd.py:1853–1857`). Prefer more distinct useful work first.

## Close the measurement gap

On an authorized host, capture one bounded, scrubbed metadata snapshot of the
jobs ledger, queue/status/adaptive readings, launch skip receipts and quota reset
readings. Record the installed machinery digests alongside the repo revision.
Do not export prompts, credentials, provider transcripts or private contents.
Recompute the two yield ratios with coverage, queue age bins split by blocked
reason, and the five acceptance measures above. These are proposed follow-up
measurements; this change does not collect host-private files or alter machinery.
The inventory distinguishes managed, manual and pinned installation paths
(`fleet/manifest.json:3–9`, `fleet/manifest.json:32–43`); source changes alone
cannot establish deployed behavior. Validation and limitations are recorded in
[BRIDGE_NOTES.md](../../BRIDGE_NOTES.md).
