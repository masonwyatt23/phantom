/** phm fleet issue-input: read-only offline check of one recorded labelled-issue array. */
import { isAbsolute } from 'node:path';
import {
  buildIssueInputError,
  buildIssueInputReport,
  RECORDED_ISSUES_MAX_BYTES,
  RECORDED_ISSUES_MAX_COUNT,
  readRecordedIssues,
} from '../core/fleet/recorded-issue-input.js';

const USAGE = `Usage: phm fleet issue-input --file <absolute-json-path> [--json]
Check one explicitly supplied JSON array of recorded issues and report, per issue, its number and
recorded route hint. Read-only and offline: it never claims, dispatches, executes or verifies a model,
and it never prints titles, bodies or labels other than the route labels.
Route: exactly one of route:codex, route:claude, route:grok, route:any is "routed"; no route label is
"none"; two or more route labels (including a duplicate) are "ambiguous". Route labels are hints only.
Ceilings: regular files only (symlinks are refused), at most ${RECORDED_ISSUES_MAX_BYTES} bytes and ${RECORDED_ISSUES_MAX_COUNT} issues.
Exit 0 with status "ok", or "empty" for a valid empty array. Exit 2 on bad usage, or with a fixed
diagnostic when the file is unavailable, refused, oversized, too many or malformed.
Help exits 0 without reading any file.`;

export async function cmdFleetIssueInput(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--file' && file === undefined && args[i + 1] !== undefined) file = args[++i];
    else if (a.startsWith('--file=') && file === undefined) file = a.slice('--file='.length);
    else {
      console.error(USAGE);
      return 2;
    }
  }
  if (!file || !isAbsolute(file)) {
    console.error(USAGE);
    return 2;
  }

  const read = readRecordedIssues(file);
  if (!read.ok) {
    const error = buildIssueInputError(file, read.failure);
    if (json) console.log(JSON.stringify(error));
    else console.error(error.message);
    return 2;
  }

  const report = buildIssueInputReport(file, read);
  if (json) {
    console.log(JSON.stringify(report));
    return 0;
  }
  const { counts } = report;
  console.log(`Issue input ${file}: ${report.status}. ${counts.issues} issues.`);
  console.log(
    `${counts.routed} routed (${counts.byRoute['route:codex']} codex, ${counts.byRoute['route:claude']} claude, `
      + `${counts.byRoute['route:grok']} grok, ${counts.byRoute['route:any']} any), `
      + `${counts.unrouted} none, ${counts.ambiguous} ambiguous. Read-only: nothing is claimed or dispatched.`,
  );
  for (const issue of report.issues) console.log(`#${issue.number} ${issue.route}`);
  return 0;
}
