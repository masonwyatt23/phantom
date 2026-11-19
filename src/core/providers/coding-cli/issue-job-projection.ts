/**
 * Recovered from PR #5952 scheduler/drain.ts (kindFromText, tierFromShape, roleFromKind, jobsFromIssues)
 * at 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886. Complexity and risk are recorded, not classified.
 * Types are local. The source's kind filter is dropped: it admitted every kind. Pure, no I/O.
 */

export const ISSUE_JOB_KINDS = ['coding', 'investigation', 'test-fixing', 'research', 'orchestration', 'review', 'merge-decision'] as const;
export type IssueJobKind = (typeof ISSUE_JOB_KINDS)[number];
/** Planning role. The source's `credential` role is never produced here. */
export type IssueJobRole = 'produce' | 'review' | 'merge' | 'orchestration';
export type IssueTier = 'cheap' | 'workhorse' | 'frontier';
export type AssessmentBand = 'low' | 'medium' | 'high';
export type KindSource = 'label' | 'text' | 'default';

export interface RecordedIssue {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
  complexity: AssessmentBand;
  risk: AssessmentBand;
}

export interface IssueJobProjection {
  id: string;
  jobType: IssueJobKind;
  kindSource: KindSource;
  role: IssueJobRole;
  minTier: IssueTier;
  assessmentSource: 'recorded';
}

export class IssueProjectionError extends Error {}

const BANDS: readonly string[] = ['low', 'medium', 'high'];
const FIELDS: readonly string[] = ['number', 'title', 'body', 'labels', 'complexity', 'risk'];
const MAX_TITLE = 512;
const MAX_BODY = 32 * 1024;
const MAX_LABELS = 64;
const MAX_LABEL = 128;

/** Precedence as in the source: a recognised `kind:<kind>` label, then text rules in source order, then coding. */
export function kindFromRecord(issue: Pick<RecordedIssue, 'title' | 'body' | 'labels'>): { jobType: IssueJobKind; kindSource: KindSource } {
  for (const label of issue.labels) {
    const value = /^kind:(.+)$/.exec(label)?.[1];
    if (value !== undefined && (ISSUE_JOB_KINDS as readonly string[]).includes(value)) {
      return { jobType: value as IssueJobKind, kindSource: 'label' };
    }
  }
  const text = `${issue.title}\n${issue.body}`;
  const rules: Array<[RegExp, IssueJobKind]> = [
    [/\bmerge\b/i, 'merge-decision'],
    [/\breview\b/i, 'review'],
    [/\b(investigate|investigation)\b/i, 'investigation'],
    [/\b(test|failing tests|ci)\b/i, 'test-fixing'],
    [/\bresearch\b/i, 'research'],
    [/\borchestrat/i, 'orchestration'],
  ];
  const hit = rules.find(([pattern]) => pattern.test(text));
  return hit ? { jobType: hit[1], kindSource: 'text' } : { jobType: 'coding', kindSource: 'default' };
}

/** Merge decisions and high complexity or risk are frontier. Low/low is cheap. Everything else is workhorse. */
export function tierFromAssessment(jobType: IssueJobKind, complexity: AssessmentBand, risk: AssessmentBand): IssueTier {
  if (jobType === 'merge-decision' || complexity === 'high' || risk === 'high') return 'frontier';
  return complexity === 'low' && risk === 'low' ? 'cheap' : 'workhorse';
}

export function roleFromKind(jobType: IssueJobKind): IssueJobRole {
  if (jobType === 'orchestration' || jobType === 'review') return jobType;
  if (jobType === 'merge-decision') return 'merge';
  return 'produce';
}

/** Pure projection. Keeps input order. Output never includes title, body or label text. */
export function projectIssueJobs(issues: readonly RecordedIssue[]): IssueJobProjection[] {
  return issues.map(issue => {
    const { jobType, kindSource } = kindFromRecord(issue);
    return {
      id: `issue-${issue.number}`,
      jobType,
      kindSource,
      role: roleFromKind(jobType),
      minTier: tierFromAssessment(jobType, issue.complexity, issue.risk),
      assessmentSource: 'recorded',
    };
  });
}

/**
 * Strict validation of an explicit evidence value (a JSON array of records). Errors carry the
 * record position and a fixed rule name only, never record content.
 */
export function parseRecordedIssues(raw: unknown): RecordedIssue[] {
  if (!Array.isArray(raw)) throw new IssueProjectionError('evidence must be a JSON array of issue records');
  const seen = new Set<number>();
  return raw.map((entry: unknown, index): RecordedIssue => {
    const fail: (rule: string) => never = rule => {
      throw new IssueProjectionError(`record ${index + 1} ${rule}`);
    };
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail('must be an object');
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some(key => !FIELDS.includes(key))) fail('has an unknown field');
    const missing = FIELDS.find(field => !(field in record));
    if (missing !== undefined) fail(`is missing field "${missing}"`);
    const { number, title, body, labels, complexity, risk } = record;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) fail('field "number" must be a positive safe integer');
    if (seen.has(number as number)) fail('repeats an earlier issue number');
    seen.add(number as number);
    if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE) fail(`field "title" must be a non-empty string of at most ${MAX_TITLE} characters`);
    if (typeof body !== 'string' || body.length > MAX_BODY) fail(`field "body" must be a string of at most ${MAX_BODY} characters`);
    if (!Array.isArray(labels) || labels.length > MAX_LABELS) fail(`field "labels" must be an array of at most ${MAX_LABELS} entries`);
    if (labels.some((label: unknown) => typeof label !== 'string' || label.length > MAX_LABEL)) {
      fail(`field "labels" must contain only strings of at most ${MAX_LABEL} characters`);
    }
    if (typeof complexity !== 'string' || !BANDS.includes(complexity)) fail('field "complexity" must be low, medium or high');
    if (typeof risk !== 'string' || !BANDS.includes(risk)) fail('field "risk" must be low, medium or high');
    return { number: number as number, title, body, labels: labels as string[], complexity: complexity as AssessmentBand, risk: risk as AssessmentBand };
  });
}
