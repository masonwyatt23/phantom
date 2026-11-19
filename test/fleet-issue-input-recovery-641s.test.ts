import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetIssueInput } from '../src/cli/fleet-issue-input.js';
import {
  parseIssues,
  readRecordedIssues,
  RECORDED_ISSUES_MAX_BYTES,
  RECORDED_ISSUES_MAX_COUNT,
  routeOf,
} from '../src/core/fleet/recorded-issue-input.js';

// Preserved from PR #5952 src/core/providers/coding-cli/worker-plan.ts at 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886.
// Source cannot be imported here (its limits.js and probe.js imports are absent on master), so the cases
// below restate the source's pure semantics and were checked against it by hand.

const loaders = { 'issue-input': () => import('../src/cli/fleet-issue-input.js') };
const SECRET_TITLE = 'Fake SECRET-TITLE-641';
const SECRET_BODY = 'Fake SECRET-BODY-641 body text';
const SECRET_LABEL = 'private-label-641';

afterEach(() => {
  vi.restoreAllMocks();
});

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'issue-input-641s-'));
}

function writeInput(content: string): { dir: string; file: string } {
  const dir = fixtureDir();
  const file = join(dir, 'issues.json');
  writeFileSync(file, content);
  return { dir, file };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: 1, title: 'Fake issue title', body: 'Fake issue body', labels: ['bug'], ...overrides };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { out.push(String(s)); });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => { err.push(String(s)); });
  const code = await cmdFleet(['issue-input', ...args], loaders);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('fleet issue-input (recovered from #5952 worker-plan.ts)', () => {
  it('reports source-shaped input through the real dispatcher and file path, withholding content', async () => {
    const { file } = writeInput(JSON.stringify([
      issue({ number: 10, title: SECRET_TITLE, body: SECRET_BODY, labels: ['route:codex', SECRET_LABEL] }),
      issue({ number: 11, title: '  Fake padded title  ', body: '', labels: [] }),
      issue({ number: 12, title: 'Fake grok', labels: ['route:grok'] }),
    ]));
    const { code, out, err } = await run(['--file', file, '--json']);
    expect(code).toBe(0);
    expect(err).toBe('');
    const report = JSON.parse(out);
    expect(report).toMatchObject({
      schema: 'fleet.issue-input.v1', readOnly: true, execution: false, claims: false, dispatch: false, status: 'ok',
    });
    expect(report.counts).toEqual({
      issues: 3, routed: 2, unrouted: 1, ambiguous: 0,
      byRoute: { 'route:codex': 1, 'route:claude': 0, 'route:grok': 1, 'route:any': 0 },
    });
    expect(report.issues).toEqual([
      { number: 10, route: 'route:codex' },
      { number: 11, route: 'none' },
      { number: 12, route: 'route:grok' },
    ]);
    expect(out).not.toContain('SECRET-TITLE');
    expect(out).not.toContain('SECRET-BODY');
    expect(out).not.toContain(SECRET_LABEL);
    expect(out).not.toContain('Fake padded title');
  });

  it('classifies route:any and the absent, duplicate and ambiguous cases', async () => {
    const { file } = writeInput(JSON.stringify([
      issue({ number: 1, labels: ['route:any'] }),
      issue({ number: 2, labels: ['bug'] }),
      issue({ number: 3, labels: ['route:claude', 'route:grok'] }),
      issue({ number: 4, labels: ['route:codex', 'route:codex'] }),
    ]));
    const { code, out } = await run(['--file', file, '--json']);
    const report = JSON.parse(out);
    expect(code).toBe(0);
    expect(report.issues).toEqual([
      { number: 1, route: 'route:any' },
      { number: 2, route: 'none' },
      { number: 3, route: 'ambiguous' },
      { number: 4, route: 'ambiguous' },
    ]);
    expect(report.counts).toMatchObject({ issues: 4, routed: 1, unrouted: 1, ambiguous: 2 });
    expect(report.counts.byRoute['route:any']).toBe(1);
  });

  it('treats an empty valid array as exit 0 with explicit empty status and zero counts', async () => {
    const { file } = writeInput('[]');
    const { code, out } = await run(['--file', file, '--json']);
    const report = JSON.parse(out);
    expect(code).toBe(0);
    expect(report.status).toBe('empty');
    expect(report.issues).toEqual([]);
    expect(report.counts).toMatchObject({ issues: 0, routed: 0, unrouted: 0, ambiguous: 0 });
  });

  it('renders the human summary with route counts and no titles, bodies or labels', async () => {
    const { file } = writeInput(JSON.stringify([issue({ number: 5, title: SECRET_TITLE, body: SECRET_BODY, labels: ['route:any', SECRET_LABEL] })]));
    const { code, out } = await run(['--file', file]);
    expect(code).toBe(0);
    expect(out).toContain('1 issues');
    expect(out).toContain('1 routed (0 codex, 0 claude, 0 grok, 1 any)');
    expect(out).toContain('#5 route:any');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain(SECRET_LABEL);
  });

  it('refuses malformed JSON, zero-byte files and non-array roots, without echoing the content', async () => {
    for (const content of ['[ SECRET-RAW-641', '', '{"number":1}', '"SECRET-RAW-641"']) {
      const { file } = writeInput(content);
      const { code, out, err } = await run(['--file', file, '--json']);
      expect(code).toBe(2);
      const report = JSON.parse(out);
      expect(report).toMatchObject({ status: 'error', reason: 'malformed', readOnly: true });
      expect(out + err).not.toContain('SECRET-RAW-641');
    }
  });

  it.each([
    ['zero', '{"number":0,"title":"t","body":"","labels":[]}'],
    ['negative', '{"number":-3,"title":"t","body":"","labels":[]}'],
    ['fraction', '{"number":1.5,"title":"t","body":"","labels":[]}'],
    ['numeric string', '{"number":"7","title":"t","body":"","labels":[]}'],
    ['above safe integer', '{"number":9007199254740992,"title":"t","body":"","labels":[]}'],
    ['overflow to Infinity', '{"number":1e400,"title":"t","body":"","labels":[]}'],
  ])('rejects an unsafe number (%s) with exit 2 and no partial report', async (_name, badRow) => {
    const { file } = writeInput(`[${JSON.stringify(issue({ number: 1 }))},${badRow}]`);
    const { code, out } = await run(['--file', file, '--json']);
    expect(code).toBe(2);
    expect(out).not.toContain('"issues"');
    expect(JSON.parse(out)).toMatchObject({ status: 'error', reason: 'malformed' });
  });

  it('accepts the largest safe integer and rejects unsafe numbers in the core parser', () => {
    expect(parseIssues(JSON.stringify([issue({ number: Number.MAX_SAFE_INTEGER })]))[0]!.number).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseIssues(JSON.stringify([issue({ number: Number.MAX_SAFE_INTEGER + 1 })]))).toThrow(/safe positive integer/);
    expect(() => parseIssues('[{"number":1e400,"title":"t","body":"","labels":[]}]')).toThrow(/safe positive integer/);
  });

  it.each([
    ['blank title', issue({ title: '   ' })],
    ['missing title', { number: 1, body: 'b', labels: [] }],
    ['non-string title', issue({ title: 7 })],
    ['non-string body', issue({ body: null })],
    ['missing body', { number: 1, title: 't', labels: [] }],
    ['non-array labels', issue({ labels: 'route:any' })],
    ['nonstring label', issue({ labels: ['route:any', 9] })],
    ['null row', null],
    ['array row', ['x']],
  ])('refuses an invalid row (%s) whole, exit 2', async (_name, row) => {
    const { file } = writeInput(JSON.stringify([issue({ number: 1 }), row]));
    const { code, out, err } = await run(['--file', file, '--json']);
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ status: 'error', reason: 'malformed' });
    expect(out + err).not.toContain('SECRET');
  });

  it('enforces the 1000-issue ceiling exactly', async () => {
    const at = Array.from({ length: RECORDED_ISSUES_MAX_COUNT }, (_v, i) => issue({ number: i + 1 }));
    const ok = writeInput(JSON.stringify(at));
    const okRun = await run(['--file', ok.file, '--json']);
    expect(okRun.code).toBe(0);
    expect(JSON.parse(okRun.out).counts.issues).toBe(RECORDED_ISSUES_MAX_COUNT);

    const over = writeInput(JSON.stringify([...at, issue({ number: RECORDED_ISSUES_MAX_COUNT + 1 })]));
    const overRun = await run(['--file', over.file, '--json']);
    expect(overRun.code).toBe(2);
    expect(JSON.parse(overRun.out)).toMatchObject({ reason: 'too-many', status: 'error' });
  });

  it('enforces the 256 KiB byte ceiling exactly, refusing before parsing', async () => {
    const atLimit = writeInput(`[${' '.repeat(RECORDED_ISSUES_MAX_BYTES - 2)}]`);
    expect(readRecordedIssues(atLimit.file)).toMatchObject({ ok: true, bytes: RECORDED_ISSUES_MAX_BYTES });
    const { code, out } = await run(['--file', atLimit.file, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).status).toBe('empty');

    const over = writeInput(`[${' '.repeat(RECORDED_ISSUES_MAX_BYTES - 1)}]`);
    expect(readRecordedIssues(over.file)).toEqual({ ok: false, failure: 'oversized' });
    const overRun = await run(['--file', over.file, '--json']);
    expect(overRun.code).toBe(2);
    expect(JSON.parse(overRun.out)).toMatchObject({ reason: 'oversized' });
  });

  it('refuses a symlink to a valid file without reading it', async () => {
    const { dir, file } = writeInput(JSON.stringify([issue()]));
    const link = join(dir, 'link.json');
    symlinkSync(file, link);
    expect(readRecordedIssues(link)).toEqual({ ok: false, failure: 'refused' });
    const { code, out } = await run(['--file', link, '--json']);
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ reason: 'refused' });
  });

  it('refuses a directory and reports missing files as unavailable, with fixed diagnostics', async () => {
    const dir = fixtureDir();
    const subdir = join(dir, 'nested');
    mkdirSync(subdir);
    expect(readRecordedIssues(subdir)).toEqual({ ok: false, failure: 'refused' });

    const missing = join(dir, 'does-not-exist.json');
    const { code, out, err } = await run(['--file', missing]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain('unavailable');
    expect(err).not.toContain(dir);
  });

  it('rejects option errors with exit 2 and usage, and exits 0 for help without reading the file', async () => {
    const { file } = writeInput('[]');
    const bad: string[][] = [
      [],
      ['--file'],
      ['--file', 'relative.json'],
      ['--file=relative.json'],
      ['--file', file, '--bogus'],
      ['--file', file, '--file', file],
      ['--json'],
    ];
    for (const args of bad) {
      const { code, err } = await run(args);
      expect(code, JSON.stringify(args)).toBe(2);
      expect(err).toContain('Usage: phm fleet issue-input');
    }

    const missing = join(fixtureDir(), 'never-read.json');
    const helpLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const help = await cmdFleetIssueInput(['--file', missing, '--help']);
    expect(help).toBe(0);
    expect(helpLog.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Usage: phm fleet issue-input');
    expect((await run(['-h'])).code).toBe(0);
  });

  it('accepts the --file=<path> form', async () => {
    const { file } = writeInput(JSON.stringify([issue({ number: 2, labels: ['route:claude'] })]));
    const { code, out } = await run([`--file=${file}`, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).issues).toEqual([{ number: 2, route: 'route:claude' }]);
  });
});

describe('preserved source semantics (worker-plan.ts at 3d6c8fb7)', () => {
  it.each([
    [[], null],
    [['bug'], null],
    [['route:codex'], 'route:codex'],
    [['route:claude'], 'route:claude'],
    [['route:grok', 'bug'], 'route:grok'],
    [['route:any'], 'route:any'],
    [['route:codex', 'route:claude'], 'ambiguous'],
    [['route:codex', 'route:codex'], 'ambiguous'],
    [['route:codexx'], null],
    [['Route:Codex'], null],
  ])('routeOf(%j) === %s', (labels, expected) => {
    expect(routeOf(labels)).toBe(expected);
  });

  it('keeps the source row acceptance: trimmed title, string body, string labels kept in order', () => {
    expect(parseIssues('[{"number":7,"title":"  Fake title  ","body":"","labels":["route:any","bug"]}]')).toEqual([
      { number: 7, title: 'Fake title', body: '', labels: ['route:any', 'bug'] },
    ]);
    expect(parseIssues('[]')).toEqual([]);
  });

  it('keeps the source top-level failure: a non-array root and a whole-array throw', () => {
    expect(() => parseIssues('{}')).toThrow('issues file must be an array');
    expect(() => parseIssues('[{"number":1,"title":"t","body":"","labels":[]},{"number":0,"title":"t","body":"","labels":[]}]'))
      .toThrow('issues[1].number');
  });
});
