import {
  MAX_BATCH_INPUT_BYTES,
  parseReleaseAdvanceBatchInput,
  runReleaseAdvanceBatch,
  type ReleaseAdvanceBatchReport,
} from '../core/fleet/release-advance-batch.js';
import type { ReleaseAdvanceOnceOptions, ReleaseAdvanceOnceReport } from '../core/fleet/release-advance-once.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet release-advance-batch --stdin [--apply] [--json|--ndjson]';
const HELP = `${USAGE}

Submit a bounded list of release candidates through the existing serialized
advance action, in input order, instead of one session per candidate. --stdin
reads one UTF-8 JSON document (max 64 KiB) through EOF:
{"version":1,"candidates":[{"repo":"owner/name","tag":"vX.Y.Z"}]} holding 1..16
distinct candidates; malformed input, unknown fields, duplicates and extra
flags are all rejected before any candidate runs.

Dry run by default: every candidate delegates read-only and nothing is
written. --apply passes each candidate through the same local per-repo/tag
lock and receipt as release-advance-once — same-host coordination only,
never a global exactly-once. At most one evidence or dispatch call is in
flight; a blocked, refused, unavailable or busy entry does not stop the
batch, so an unrelated repo can still advance. An accepted dispatch is a
submission only: no release is published, installed or notified.

--ndjson (not with --json) prints each candidate as it finishes, before the
next one starts: {"version":1,"type":"entry","index":N,"total":M,"repo","tag",
"result"} with a 1-based index, then one {"version":1,"type":"summary",
"report"} line last. Invalid input prints one {"version":1,"outcome":"invalid"}
line. A stdout failure stops the batch before the next candidate.

exit: 0 every candidate planned|submitted|no-op|already-submitted,
      1 any candidate blocked|refused|unavailable|busy, or output failed,
      2 invalid arguments or input`;

interface BatchDeps {
  input?: AsyncIterable<string | Uint8Array>;
  gh?: GitRunner;
  stateDir?: string;
  advance?: ReleaseAdvanceOnceOptions['advance'];
  once?: (repo: string, tag: string, opts: ReleaseAdvanceOnceOptions) => Promise<ReleaseAdvanceOnceReport>;
  now?: () => number;
}

async function readStdin(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BATCH_INPUT_BYTES) throw new Error('input too large');
    chunks.push(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

const human = (report: ReleaseAdvanceBatchReport): string => {
  const lines = [
    `Release advance batch${report.apply ? ' --apply' : ' (dry run)'}: ${report.total} candidate(s), `
    + `${report.succeeded} successful, ${report.unsuccessful} unsuccessful`,
    ...report.entries.map(entry => `  ${entry.repo}@${entry.tag}: ${entry.outcome} (${entry.reason})`),
  ];
  if (report.remaining.length) lines.push(`  Not reached: ${report.remaining.join(', ')}`);
  if (report.entries.some(entry => entry.outcome === 'submitted')) {
    lines.push('  Accepted dispatches are submissions only; nothing is published, installed or notified.');
  }
  if (!report.apply && report.entries.some(entry => entry.outcome === 'planned')) {
    lines.push('  Dry run; pass --apply to submit the proposed dispatches.');
  }
  return lines.join('\n');
};

const entryLine = (index: number, total: number, result: ReleaseAdvanceOnceReport): string =>
  JSON.stringify({ version: 1, type: 'entry', index, total, repo: result.repo, tag: result.tag, result });

/**
 * Bounded batch driver over the serialized release advance. One JSON
 * document on stdin nominates 1..16 candidates; every rejection happens
 * before the first evidence call, and the aggregated report keeps each
 * candidate's own outcome and reason.
 */
export async function cmdFleetReleaseAdvanceBatch(args: string[], deps: BatchDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const wantsJson = args.includes('--json') || args.includes('--ndjson');
  const invalid = (detail: string): number => {
    if (wantsJson) console.log(JSON.stringify({ version: 1, outcome: 'invalid', reason: detail }));
    else process.stderr.write(`Invalid input: ${detail}. ${USAGE}\n`);
    return 2;
  };
  let stdin = false;
  let apply = false;
  let json = false;
  let ndjson = false;
  for (const arg of args) {
    if (arg === '--stdin' && !stdin) { stdin = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--ndjson' && !ndjson) { ndjson = true; continue; }
    return invalid('unexpected_argument');
  }
  if (!stdin) return invalid('missing_stdin_flag');
  if (json && ndjson) return invalid('json_and_ndjson');
  const input = deps.input ?? process.stdin;
  if (deps.input === undefined && (input as { isTTY?: boolean }).isTTY === true) return invalid('stdin_must_be_a_pipe');
  let text: string;
  try { text = await readStdin(input); }
  catch (error) { return invalid(error instanceof Error && error.message === 'input too large' ? 'input_too_large' : 'input_unreadable'); }
  const parsed = parseReleaseAdvanceBatchInput(text);
  if (!parsed.ok) return invalid(parsed.reason);
  // Output errors are tracked apart from the core's candidate-list validation
  // so a failed write is never reported as invalid input.
  let outputFailed = false;
  const write = (line: string): void => {
    try { console.log(line); }
    catch (error) { outputFailed = true; throw error; }
  };
  let report: ReleaseAdvanceBatchReport;
  try {
    report = await runReleaseAdvanceBatch(parsed.candidates, {
      apply, runner: deps.gh, stateDir: deps.stateDir, advance: deps.advance, once: deps.once, now: deps.now,
      onEntry: ndjson ? ({ index, total, report: result }) => write(entryLine(index, total, result)) : undefined,
    });
    if (ndjson) write(JSON.stringify({ version: 1, type: 'summary', report }));
    else write(json ? JSON.stringify(report) : human(report));
  } catch {
    if (outputFailed) {
      process.stderr.write('Output failed: batch stopped before the next candidate.\n');
      return 1;
    }
    return invalid('candidate_list');
  }
  return report.unsuccessful === 0 ? 0 : 1;
}
