/**
 * RQ-PHX-EMPTYTESTGUARD371 — no empty "proof" test files. #5704 merged a
 * 0-byte test file that passed precheck and CI because it runs zero tests.
 * This walks test/ and src/ and fails, naming each path, for every
 * *.test.ts|tsx|mts file that is blank or defines no test after comments are
 * stripped. Read-only against the repo checkout; no home or network access.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findEmptyTestFiles } from './support/empty-test-scan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const TEST_FILE = /\.test\.(?:ts|tsx|mts)$/;

/** Non-empty files that legitimately hold no test call (repo-relative, posix). Keep this list tiny. */
const ALLOW_NO_TEST_CALL: ReadonlySet<string> = new Set<string>([
  // Shims that import a colocated suite so it runs under the test/ inventory.
  'test/email-drop-bridge.test.ts',
  'test/fleet-graph-api.test.ts',
  'test/red-pr-fix-job.test.ts',
  'test/verse-host-load.test.ts',
  // Register tests through the shared groupingFallbackRegression() helper.
  'src/web-ui/routes/verse/resources/grouping-invalid-fallback.test.tsx',
  'src/web-ui/routes/verse/resources/grouping-loader-fallback.test.tsx',
]);

function collect(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(ROOT, full).split('\\').join('/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || rel === 'test/fixtures') continue;
      collect(full, out);
    } else if (e.isFile() && TEST_FILE.test(e.name)) out.push(rel);
  }
  return out;
}

describe('findEmptyTestFiles', () => {
  const run = (text: string) => findEmptyTestFiles([{ path: 'a.test.ts', text }]);
  it('flags a 0-byte file', () => expect(run('')).toEqual(['a.test.ts']));
  it('flags whitespace only', () => expect(run(' \n\t\r\n')).toEqual(['a.test.ts']));
  it('flags comment-only files', () => {
    expect(run('// it(\'x\', () => {})\n/* describe("y", () => {}) */\n')).toEqual(['a.test.ts']);
  });
  it('flags imports with no test call', () => {
    expect(run("import { it } from 'vitest';\nconst x = 1;\n")).toEqual(['a.test.ts']);
  });
  it('accepts a real it( case', () => expect(run("it('works', () => {});")).toEqual([]));
  it('accepts describe.skip(', () => expect(run("describe.skip('later', () => {});")).toEqual([]));
  it('accepts test.each and bench', () => {
    expect(run('test.each([1])("n %i", () => {});')).toEqual([]);
    expect(run("bench('b', () => {});")).toEqual([]);
  });
  it('keeps // inside strings and only reports offenders', () => {
    const entries = [
      { path: 'ok.test.ts', text: "const u = 'http://x'; it('a', () => {});" },
      { path: 'bad.test.ts', text: '' },
    ];
    expect(findEmptyTestFiles(entries)).toEqual(['bad.test.ts']);
  });
});

describe('repository test files', () => {
  it('has no empty or test-less *.test.* files', () => {
    const files = [...collect(join(ROOT, 'test')), ...collect(join(ROOT, 'src'))];
    expect(files.length).toBeGreaterThan(0);
    const entries = files.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
    const offenders = findEmptyTestFiles(entries).filter((p) => !ALLOW_NO_TEST_CALL.has(p));
    expect(offenders, `empty test files (add tests or delete):\n${offenders.join('\n')}`).toEqual([]);
  });
});
