/** Issue-to-job projection recovery (PR #5952 scheduler/drain.ts slice). Hermetic: temp files only. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CODING_ISSUES_MAX_EVIDENCE_BYTES, cmdFleetCodingIssues } from '../src/cli/fleet-coding-issues.js';
import {
  IssueProjectionError,
  type IssueJobKind,
  ISSUE_JOB_KINDS,
  kindFromRecord,
  parseRecordedIssues,
  tierFromAssessment,
} from '../src/core/providers/coding-cli/issue-job-projection.js';

const SENTINELS = ['SENTINEL-TITLE-ALPHA', 'SENTINEL-BODY-BRAVO', 'SENTINEL-LABEL-CHARLIE'];
const dir = mkdtempSync(join(tmpdir(), 'coding-issues-658s-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Raw evidence record. Overrides may be deliberately malformed, so the type is loose. */
function record(overrides: Record<string, unknown>): Record<string, unknown> {
  return { number: 1, title: 'Fake plain title', body: 'Fake plain body.', labels: [], complexity: 'medium', risk: 'medium', ...overrides };
}

function evidenceFile(name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await cmdFleetCodingIssues(args, line => out.push(line), line => errors.push(line));
  return { code, out: out.join('\n'), err: errors.join('\n') };
}

describe('kind precedence: label, then text rules in source order, then coding', () => {
  it.each<IssueJobKind>(ISSUE_JOB_KINDS)('kind:%s label wins over conflicting text', kind => {
    expect(kindFromRecord({ title: 'merge review research', body: 'failing tests', labels: [`kind:${kind}`] }))
      .toEqual({ jobType: kind, kindSource: 'label' });
  });

  it.each<[string, IssueJobKind]>([
    ['Merge the release branch', 'merge-decision'],
    ['Review the parser', 'review'],
    ['Investigation of the stall', 'investigation'],
    ['Fix failing tests', 'test-fixing'],
    ['Repair the CI job', 'test-fixing'],
    ['Research queue shapes', 'research'],
    ['Orchestrate three lanes', 'orchestration'],
  ])('text rule for %j', (title, expected) => {
    expect(kindFromRecord({ title, body: '', labels: [] })).toEqual({ jobType: expected, kindSource: 'text' });
  });

  it('applies rule order, ignores unrecognised labels, and keeps word boundaries', () => {
    expect(kindFromRecord({ title: 'review then merge', body: '', labels: [] }).jobType).toBe('merge-decision');
    expect(kindFromRecord({ title: 'x', body: 'research', labels: ['kind:bogus'] })).toEqual({ jobType: 'research', kindSource: 'text' });
    expect(kindFromRecord({ title: 'x', body: '', labels: ['kind:review', 'kind:research'] }).jobType).toBe('review');
    expect(kindFromRecord({ title: 'x', body: '', labels: ['Kind:review', 'kind:'] })).toEqual({ jobType: 'coding', kindSource: 'default' });
    expect(kindFromRecord({ title: 'merged mergers', body: '', labels: [] })).toEqual({ jobType: 'coding', kindSource: 'default' });
  });

  it('maps tiers from the recorded bands', () => {
    expect(tierFromAssessment('merge-decision', 'low', 'low')).toBe('frontier');
    expect(tierFromAssessment('coding', 'high', 'low')).toBe('frontier');
    expect(tierFromAssessment('research', 'low', 'high')).toBe('frontier');
    expect(tierFromAssessment('review', 'low', 'low')).toBe('cheap');
    expect(tierFromAssessment('coding', 'low', 'medium')).toBe('workhorse');
    expect(tierFromAssessment('coding', 'medium', 'medium')).toBe('workhorse');
  });
});

describe('parseRecordedIssues strict validation', () => {
  it.each<[string, unknown]>([
    ['a non-array root', { number: 1 }],
    ['a null record', [null]],
    ['an array record', [[]]],
    ['a missing field', [{ number: 1, title: 't', body: 'b', labels: [], complexity: 'low' }]],
    ['an unknown field', [record({ extra: true })]],
    ['a string number', [record({ number: '1' })]],
    ['a fractional number', [record({ number: 1.5 })]],
    ['a zero number', [record({ number: 0 })]],
    ['a duplicate number', [record({ number: 4 }), record({ number: 4 })]],
    ['an empty title', [record({ title: '' })]],
    ['an oversized title', [record({ title: 'x'.repeat(513) })]],
    ['a non-string body', [record({ body: 7 })]],
    ['a non-array labels', [record({ labels: 'kind:review' })]],
    ['a non-string label', [record({ labels: [3] })]],
    ['an unknown band', [record({ complexity: 'critical' })]],
    ['an uppercase band', [record({ risk: 'High' })]],
  ])('rejects %s', (_name, value) => {
    expect(() => parseRecordedIssues(value)).toThrow(IssueProjectionError);
  });

  it('accepts an empty array and never echoes record content', () => {
    expect(parseRecordedIssues([])).toEqual([]);
    const content = record({ title: SENTINELS[0], body: SENTINELS[1], labels: [SENTINELS[2]], risk: 'Extreme' });
    expect(() => parseRecordedIssues([content])).toThrow(/^record 1 field "risk" must be low, medium or high$/);
  });
});

describe('phm fleet coding-issues CLI handler', () => {
  it('prints help and exits 0 without reading a file', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: phm fleet coding-issues --evidence <file>');
    expect((await run(['-h'])).code).toBe(0);
  });

  it('refuses a missing flag, a valueless flag, a repeated flag, unknown flags and stray arguments with exit 2', async () => {
    const path = evidenceFile('flags.json', []);
    expect((await run([])).err).toContain('--evidence <file> is required');
    for (const args of [['--evidence'], ['--evidence', '--other'], ['--evidence', path, '--evidence', path], ['--evidence', path, '--json'], ['--evidence', path, 'stray']]) {
      expect((await run(args)).code).toBe(2);
    }
  });

  it('refuses a directory, a missing file and oversized evidence with exit 1; accepts exactly the cap', async () => {
    mkdirSync(join(dir, 'a-directory'), { recursive: true });
    expect((await run(['--evidence', join(dir, 'a-directory')])).code).toBe(1);
    expect((await run(['--evidence', join(dir, 'missing.json')])).code).toBe(1);
    const big = evidenceFile('big.json', ' '.repeat(CODING_ISSUES_MAX_EVIDENCE_BYTES + 1));
    expect((await run(['--evidence', big])).err).toContain('exceeds');
    const atCap = evidenceFile('at-cap.json', '[]'.padEnd(CODING_ISSUES_MAX_EVIDENCE_BYTES));
    expect(statSync(atCap).size).toBe(CODING_ISSUES_MAX_EVIDENCE_BYTES);
    expect((await run(['--evidence', atCap])).code).toBe(0);
  });

  it('reports invalid JSON without echoing file content, and prints an empty jobs array for []', async () => {
    const broken = await run(['--evidence', evidenceFile('broken.json', `[{"title": "${SENTINELS[0]}"`)]);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain('not valid JSON');
    expect(broken.err).not.toContain(SENTINELS[0]);
    const empty = await run(['--evidence', evidenceFile('empty.json', [])]);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.out).jobs).toEqual([]);
  });

  it('projects label override and fallback text rules through a real evidence file, in input order', async () => {
    const path = evidenceFile('issues.json', [
      record({ number: 101, labels: ['kind:merge-decision'], complexity: 'low', risk: 'low' }),
      record({ number: 102, title: 'Look at the parser', labels: ['kind:review'], complexity: 'low', risk: 'low' }),
      record({ number: 103, title: 'Investigation of stalled lane' }),
      record({ number: 104, title: 'Fix failing tests', complexity: 'low', risk: 'low' }),
      record({ number: 105, title: 'Research queue shapes', labels: ['kind:bogus'], complexity: 'high', risk: 'low' }),
      record({ number: 106, title: 'Orchestrate three lanes', complexity: 'low', risk: 'medium' }),
      record({ number: 107, title: 'Rename a helper', complexity: 'low', risk: 'low' }),
      record({ number: 108, title: 'Plain change', labels: ['kind:coding'], risk: 'high' }),
    ]);
    const result = await run(['--evidence', path]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const jobs = JSON.parse(result.out).jobs as Array<Record<string, string>>;
    expect(jobs.map(job => [job.id, job.jobType, job.kindSource, job.role, job.minTier, job.assessmentSource])).toEqual([
      ['issue-101', 'merge-decision', 'label', 'merge', 'frontier', 'recorded'],
      ['issue-102', 'review', 'label', 'review', 'cheap', 'recorded'],
      ['issue-103', 'investigation', 'text', 'produce', 'workhorse', 'recorded'],
      ['issue-104', 'test-fixing', 'text', 'produce', 'cheap', 'recorded'],
      ['issue-105', 'research', 'text', 'produce', 'frontier', 'recorded'],
      ['issue-106', 'orchestration', 'text', 'orchestration', 'workhorse', 'recorded'],
      ['issue-107', 'coding', 'default', 'produce', 'cheap', 'recorded'],
      ['issue-108', 'coding', 'label', 'produce', 'frontier', 'recorded'],
    ]);
  });

  it('leaks no issue text into stdout or stderr, for success or refusal', async () => {
    const fields = { title: SENTINELS[0], body: SENTINELS[1], labels: [SENTINELS[2]] };
    const ok = await run(['--evidence', evidenceFile('leak.json', [record(fields)])]);
    const refused = await run(['--evidence', evidenceFile('leak-bad.json', [record({ ...fields, complexity: 'nope' })])]);
    expect([ok.code, refused.code]).toEqual([0, 1]);
    for (const text of [ok.out, ok.err, refused.out, refused.err]) {
      for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    }
  });

  it('leaves the evidence bytes, mtime and directory listing unchanged', async () => {
    const path = evidenceFile('evidence.json', [record({ labels: ['kind:orchestration'] })]);
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs, listing: readdirSync(dir).sort() };
    expect((await run(['--evidence', path])).code).toBe(0);
    expect(readFileSync(path).equals(before.bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
    expect(readdirSync(dir).sort()).toEqual(before.listing);
  });
});
