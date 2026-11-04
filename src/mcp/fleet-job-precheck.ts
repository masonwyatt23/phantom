/**
 * fleet_job_precheck — is a proposed job draft already on origin/master?
 * A planner can check its markdown before writing a drop file, avoiding
 * redundant work and temporary files. The draft arrives as an argument, so
 * this tool never reads a caller path, writes a file, enqueues, deletes,
 * launches or merges anything.
 *
 * Reuses `precheckJob` — the same extraction and verdict logic as
 * `phm fleet job-precheck` — over the same `gitJobProbe` reader, with the
 * ref fixed at origin/master: no caller ref, filesystem root or cwd, no
 * fetch and no shell. The symbolic ref moves under continuous merges, so
 * it is resolved once to an immutable commit before any path probe and
 * reported as resolvedRef: every fact in one answer describes the same
 * landed tree. The answer is advisory recorded evidence: whether each
 * named path is present on the ref and the identity of its last commit
 * there. Path presence or last-commit identity cannot prove semantic
 * completion — only that the evidence the bounded probe saw matched. A
 * fresh verdict does not prove no overlapping work exists.
 */
import { precheckJob, type JobPrecheckGit, type PrecheckFact } from '../core/fleet/job-precheck.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { gitJobProbe, resolveJobPrecheckRef } from '../cli/fleet-job-precheck.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Fixed probe ref: the planner asks about landed work, so only origin/master counts. */
export const FLEET_JOB_PRECHECK_REF = 'origin/master';
/** Draft markdown is bounded so one call stays a bounded probe. */
export const MAX_FLEET_JOB_PRECHECK_BYTES = 8000;

export interface FleetJobPrecheckArgs {
  /** Proposed job draft markdown; analyzed, never echoed back. */
  markdown: string;
  /** Optional exact fleet job id; likely-done then needs it in each non-test src path's last commit. */
  jobId?: string;
}

export interface FleetJobPrecheckDeps {
  /**
   * Fully injected probe for hermetic tests: it never touches the real
   * repository, so resolution is skipped and the envelope reports an
   * explicit null resolvedRef rather than a fabricated snapshot id.
   */
  git?: JobPrecheckGit;
  /** Resolve the fixed symbolic ref once; defaults to the CLI's rev-parse resolver. */
  resolveRef?: (ref: string) => Promise<string>;
  /** Build the probe over the resolved commit; defaults to the shared gitJobProbe. */
  gitJobProbe?: (resolvedRef: string) => JobPrecheckGit;
}

export interface FleetJobPrecheckV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
  ref: string;
  /** Immutable commit every fact was probed on; null only when the git reader was injected without a resolver. */
  resolvedRef: string | null;
  jobId?: string;
  facts: PrecheckFact[];
  newTestFiles: string[];
  verdict: 'fresh' | 'partly-on-master' | 'likely-done';
}

const NOTE = `Advisory recorded evidence only: each fact records whether the path the draft named is present on ${FLEET_JOB_PRECHECK_REF} and, when present, the identity of its last commit there; resolvedRef names the single immutable commit every fact was probed on, so merges landing mid-answer cannot mix trees inside one response. Path presence or last-commit identity cannot prove semantic completion — a likely-done verdict means only that every named non-test src path exists on the ref with the required last-commit evidence, and a fresh verdict does not prove no overlapping work exists. Never a queue, dispatch, merge or correctness verdict; this call wrote nothing and enqueued nothing.`;

const PRECHECK_KEYS = new Set(['markdown', 'jobId']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller-supplied ref, path, root or cwd), a missing,
 * non-string, blank or over-8000-byte markdown, and a present but invalid
 * jobId are all rejected before the git probe runs.
 */
export function parseFleetJobPrecheckArgs(args: Record<string, unknown>): FleetJobPrecheckArgs | null {
  const markdown = args['markdown'], jobId = args['jobId'];
  if (Object.keys(args).some(key => !PRECHECK_KEYS.has(key)) ||
    typeof markdown !== 'string' || markdown.trim() === '' ||
    Buffer.byteLength(markdown, 'utf8') > MAX_FLEET_JOB_PRECHECK_BYTES ||
    (jobId !== undefined && (typeof jobId !== 'string' || !validJobId(jobId)))) return null;
  return jobId === undefined ? { markdown } : { markdown, jobId };
}

/**
 * One bounded probe for the draft on the fixed ref. Probe failures (missing
 * git, missing ref, unreadable object store) propagate — the server reports
 * them as a sanitized tool error, never as a fabricated fresh verdict. The
 * submitted markdown stays inside the precheck; only per-path facts cross
 * this boundary, all passed through the shared public-JSON scrub.
 */
export async function readFleetJobPrecheck(input: FleetJobPrecheckArgs, deps: FleetJobPrecheckDeps = {}): Promise<FleetJobPrecheckV1> {
  // Resolve the symbolic ref to one immutable commit before any path probe:
  // a fetch landing mid-answer must not mix trees. Resolution failures
  // propagate as tool errors, never as a fresh verdict. An injected git
  // reader with no resolver skips this — nothing may touch the repository
  // — and reports an explicit null instead of a fabricated snapshot id.
  let resolvedRef: string | null = null;
  if (deps.resolveRef || !deps.git) {
    resolvedRef = await (deps.resolveRef ?? resolveJobPrecheckRef)(FLEET_JOB_PRECHECK_REF);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedRef)) throw new Error('invalid resolved commit');
  }
  const report = await precheckJob(input.markdown, deps.git ?? (deps.gitJobProbe ?? gitJobProbe)(resolvedRef!), { jobId: input.jobId });
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    ref: FLEET_JOB_PRECHECK_REF, resolvedRef,
    ...(report.jobId !== undefined ? { jobId: report.jobId } : {}),
    facts: report.facts, newTestFiles: report.newTestFiles, verdict: report.verdict,
  }) as FleetJobPrecheckV1;
}
