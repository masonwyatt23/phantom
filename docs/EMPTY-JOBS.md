# Empty jobs

Run `phm jobs empty --json` to see empty outcomes from the last 24 hours. Use
`--since 48h` to choose another window. The report groups jobs by likely cause
and gives each job's lane and a short reason. It reads the local jobs ledger,
worktree `BRIDGE_NOTES.md` files and log tails. Reasons are fixed descriptions;
the report does not copy notes or logs. Missing evidence stays in `other`.
The Fleet page shows the five most common causes, counts, and an example job for each. The JSON report exposes the same ranked causes in `topCauses`. This is a heuristic, not proof
of why a job ended empty.

For failed empty guardian repairs, preview `phm jobs retry-empty --dry-run --json`,
then use `--apply` to queue one retry per failure and tier. The established
`FIXUP-MAIN-<repo>-<sha>` and `RQ-FIX-MAIN-<repo>-<sha>` IDs, including `-rN`
attempts, share a receipt; other IDs remain separate. Two distinct failed empty
attempts for that failure exhaust recovery, even across job IDs or tiers.
Duplicate finishes count once per launch. Existing repairs
defer retries. Original logs and finish records stay intact; exhausted retries
appear in `escalations` with the failed job, root, tier, exit code and reason.
A merged sibling suppresses stale retries; a closed, unmerged PR does not prove
resolution. CI remains the authority for branch health. Revert and merge-queue
behavior are unchanged; this command does not modify the host-only guardian.
Legacy numbered receipts need their original job ID in the queue or ledger;
new receipts survive removal of every original row.
