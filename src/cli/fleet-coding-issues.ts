/**
 * `phm fleet coding-issues --evidence <file>`: offline, read-only projection of recorded issues into
 * job kinds, roles and minimum tiers. The only input is the named file. Planning metadata only: no
 * dispatch, merge or eligibility, and nothing about model suitability.
 */
import { readFileSync, statSync } from 'node:fs';

import { IssueProjectionError, parseRecordedIssues, projectIssueJobs } from '../core/providers/coding-cli/issue-job-projection.js';

/** Evidence is a list of recorded issues. Anything larger is refused before it is read. */
export const CODING_ISSUES_MAX_EVIDENCE_BYTES = 64 * 1024;

const USAGE = `Usage: phm fleet coding-issues --evidence <file>
Print JSON job kind, role and minimum tier for each recorded issue in one explicit JSON evidence file
(a kind:<kind> label wins over the text rules). Nothing is dispatched, merged or routed; no model is called.`;

/** Offline. Output goes through the injected writers; defaults are console.log / console.error. */
export async function cmdFleetCodingIssues(
  args: string[],
  out: (line: string) => void = (line) => console.log(line),
  err: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    out(USAGE);
    return 0;
  }
  let evidencePath: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    const value = args[i + 1];
    if (arg !== '--evidence' || (value === undefined || value.startsWith('-')) || evidencePath !== null) {
      err(`error: ${arg.startsWith('-') ? `unknown or malformed flag ${JSON.stringify(arg)}` : 'unexpected argument'}\n${USAGE}`);
      return 2;
    }
    evidencePath = value;
    i += 1;
  }
  if (evidencePath === null) {
    err(`error: --evidence <file> is required\n${USAGE}`);
    return 2;
  }

  let raw: unknown;
  try {
    const stat = statSync(evidencePath);
    if (!stat.isFile()) {
      err('error: evidence path is not a regular file');
      return 1;
    }
    if (stat.size > CODING_ISSUES_MAX_EVIDENCE_BYTES) {
      err(`error: evidence file exceeds ${CODING_ISSUES_MAX_EVIDENCE_BYTES} bytes`);
      return 1;
    }
    raw = JSON.parse(readFileSync(evidencePath, 'utf8')) as unknown;
  } catch (cause) {
    // Report the failure class only. Parser messages can echo file content.
    const code = (cause as NodeJS.ErrnoException).code;
    err(code ? `error: could not read evidence file (${code})` : 'error: evidence file is not valid JSON');
    return 1;
  }

  try {
    const jobs = projectIssueJobs(parseRecordedIssues(raw));
    out(JSON.stringify({ kind: 'recorded-issue-job-projection', jobs }, null, 2));
    return 0;
  } catch (cause) {
    if (cause instanceof IssueProjectionError) {
      err(`error: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}
