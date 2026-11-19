/**
 * Recorded labelled-issue input, preserved from PR #5952.
 *
 * Source: src/core/providers/coding-cli/worker-plan.ts at 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886.
 * Only IssueJob, ROUTE_LABELS, parseIssues and the route-label classification (routeOf) are
 * carried over. Planning, executeStep, account selection, role rules, credentials, spawning and
 * routing policy are deliberately absent.
 *
 * Route labels here are recorded hints. Nothing in this module admits, claims, dispatches or
 * verifies a model, and it reads no environment, account, home directory or network.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

export const ROUTE_LABELS = ['route:codex', 'route:claude', 'route:grok', 'route:any'] as const;
export type RouteLabel = (typeof ROUTE_LABELS)[number];

export interface IssueJob {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
}

/** Ceilings for one recorded issue file. */
export const RECORDED_ISSUES_MAX_BYTES = 256 * 1024;
export const RECORDED_ISSUES_MAX_COUNT = 1000;

/** A single route label, 'ambiguous' when two or more route labels are recorded, or null when none. */
export type IssueRoute = RouteLabel | 'ambiguous' | null;

/** Source semantics: exact label matches only; duplicates of one route label still count as ambiguous. */
export function routeOf(labels: readonly string[]): IssueRoute {
  const found = labels.filter((label): label is RouteLabel => (ROUTE_LABELS as readonly string[]).includes(label));
  if (found.length > 1) return 'ambiguous';
  return found[0] ?? null;
}

/** Source contract: throws on the first invalid row, so a bad array never yields a partial result. */
export function parseIssues(text: string): IssueJob[] {
  return issuesFromJson(JSON.parse(text) as unknown);
}

function issuesFromJson(json: unknown): IssueJob[] {
  if (!Array.isArray(json)) throw new Error('issues file must be an array');
  if (json.length > RECORDED_ISSUES_MAX_COUNT) throw new Error(`issues file must list at most ${RECORDED_ISSUES_MAX_COUNT} issues`);
  return json.map((row: unknown, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error(`issues[${index}] must be an object`);
    const issue = row as Record<string, unknown>;
    const number = issue['number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
      throw new Error(`issues[${index}].number must be a safe positive integer`);
    }
    const title = issue['title'];
    if (typeof title !== 'string' || title.trim() === '') throw new Error(`issues[${index}].title is required`);
    const body = issue['body'];
    if (typeof body !== 'string') throw new Error(`issues[${index}].body must be a string`);
    const labels = issue['labels'];
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
      throw new Error(`issues[${index}].labels must be strings`);
    }
    return { number, title: title.trim(), body, labels: labels as string[] };
  });
}

export type RecordedIssuesFailure = 'unavailable' | 'refused' | 'oversized' | 'too-many' | 'malformed';

export type RecordedIssuesRead =
  | { ok: true; bytes: number; issues: IssueJob[] }
  | { ok: false; failure: RecordedIssuesFailure };

const fail = (failure: RecordedIssuesFailure): { ok: false; failure: RecordedIssuesFailure } => ({ ok: false, failure });

/**
 * Bounded read of one explicit issue file. Order: lstat (refuse symlinks and non-regular files,
 * then size) before any read; open with O_NOFOLLOW; fstat again; read at most cap+1 bytes so a
 * file that grows after the stat is still refused. Raw filesystem and parser messages are dropped
 * because they can echo file content.
 */
export function readRecordedIssues(file: string): RecordedIssuesRead {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(file);
  } catch {
    return fail('unavailable');
  }
  if (before.isSymbolicLink() || !before.isFile()) return fail('refused');
  if (before.size > RECORDED_ISSUES_MAX_BYTES) return fail('oversized');

  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail('unavailable');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return fail('refused');
    if (st.size > RECORDED_ISSUES_MAX_BYTES) return fail('oversized');
    const buf = Buffer.alloc(RECORDED_ISSUES_MAX_BYTES + 1);
    let filled = 0;
    for (;;) {
      const n = readSync(fd, buf, filled, buf.length - filled, filled);
      if (n === 0) break;
      filled += n;
      if (filled > RECORDED_ISSUES_MAX_BYTES) return fail('oversized');
    }
    return parseRecorded(buf.subarray(0, filled).toString('utf8'), filled);
  } catch {
    return fail('unavailable');
  } finally {
    closeSync(fd);
  }
}

function parseRecorded(text: string, bytes: number): RecordedIssuesRead {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return fail('malformed');
  }
  if (Array.isArray(json) && json.length > RECORDED_ISSUES_MAX_COUNT) return fail('too-many');
  try {
    return { ok: true, bytes, issues: issuesFromJson(json) };
  } catch {
    return fail('malformed');
  }
}

export const RECORDED_ISSUES_FAILURE_MESSAGES: Readonly<Record<RecordedIssuesFailure, string>> = {
  unavailable: 'Issue input is unavailable: the file is missing or unreadable.',
  refused: 'Issue input is refused: only regular files that are not symlinks are read.',
  oversized: `Issue input is refused: the file is larger than ${RECORDED_ISSUES_MAX_BYTES} bytes.`,
  'too-many': `Issue input is refused: it lists more than ${RECORDED_ISSUES_MAX_COUNT} issues.`,
  malformed: 'Issue input is malformed: expected a JSON array of recorded issue objects.',
};

export const FLEET_ISSUE_INPUT_SCHEMA = 'fleet.issue-input.v1';

/** Public per-issue entry: number and route only. Titles, bodies and labels never leave this module. */
export type PublicIssueRoute = RouteLabel | 'ambiguous' | 'none';

export interface IssueInputReport {
  schema: typeof FLEET_ISSUE_INPUT_SCHEMA;
  readOnly: true;
  execution: false;
  claims: false;
  dispatch: false;
  status: 'ok' | 'empty';
  source: { path: string; bytes: number };
  limits: { maxBytes: number; maxIssues: number };
  counts: {
    issues: number;
    routed: number;
    unrouted: number;
    ambiguous: number;
    byRoute: Record<RouteLabel, number>;
  };
  issues: Array<{ number: number; route: PublicIssueRoute }>;
}

export interface IssueInputError {
  schema: typeof FLEET_ISSUE_INPUT_SCHEMA;
  readOnly: true;
  execution: false;
  claims: false;
  dispatch: false;
  status: 'error';
  source: { path: string };
  reason: RecordedIssuesFailure;
  message: string;
}

export function buildIssueInputReport(path: string, read: Extract<RecordedIssuesRead, { ok: true }>): IssueInputReport {
  const byRoute = Object.fromEntries(ROUTE_LABELS.map((label) => [label, 0])) as Record<RouteLabel, number>;
  let routed = 0;
  let unrouted = 0;
  let ambiguous = 0;
  const issues = read.issues.map((issue) => {
    const route = routeOf(issue.labels);
    if (route === null) {
      unrouted += 1;
      return { number: issue.number, route: 'none' as const };
    }
    if (route === 'ambiguous') {
      ambiguous += 1;
      return { number: issue.number, route };
    }
    routed += 1;
    byRoute[route] += 1;
    return { number: issue.number, route };
  });
  return {
    schema: FLEET_ISSUE_INPUT_SCHEMA,
    readOnly: true,
    execution: false,
    claims: false,
    dispatch: false,
    status: issues.length === 0 ? 'empty' : 'ok',
    source: { path, bytes: read.bytes },
    limits: { maxBytes: RECORDED_ISSUES_MAX_BYTES, maxIssues: RECORDED_ISSUES_MAX_COUNT },
    counts: { issues: issues.length, routed, unrouted, ambiguous, byRoute },
    issues,
  };
}

export function buildIssueInputError(path: string, failure: RecordedIssuesFailure): IssueInputError {
  return {
    schema: FLEET_ISSUE_INPUT_SCHEMA,
    readOnly: true,
    execution: false,
    claims: false,
    dispatch: false,
    status: 'error',
    source: { path },
    reason: failure,
    message: RECORDED_ISSUES_FAILURE_MESSAGES[failure],
  };
}
