import { describe, expect, it } from 'vitest';
import { profileVitest, renderVitestProfile, main } from '../scripts/vitest-profile.mjs';

const file = (name: string, milliseconds: number, status = 'passed') => ({
  name, startTime: 1000, endTime: 1000 + milliseconds, status,
});
const report = (testResults = [file('test/a.test.ts', 1000)]) => ({
  testResults, success: true, numTotalTests: 4, numPassedTests: 2,
  numFailedTests: 1, numPendingTests: 1, numTodoTests: 0,
});

describe('Vitest timing profile', () => {
  it('ranks file spans, uses process wall time and breaks ties by path', () => {
    const result = profileVitest(report([
      file('/repo/test/z.test.ts', 2000), file('/repo/test/b.test.ts', 3000),
      file('/repo/test/a.test.ts', 3000),
    ]), 10, '/repo');
    expect(result.files.map(row => row.file)).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/z.test.ts']);
    expect(result.files[0]).toMatchObject({ seconds: 3, wallPercent: 30 });
  });

  it('flags strictly over 30 seconds and retains failed timings', () => {
    const result = profileVitest({ ...report([
      file('test/boundary.test.ts', 30_000), file('test/slow.test.ts', 30_001, 'failed'),
    ]), success: false }, 60);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ seconds: 30.001, status: 'failed' });
    expect(renderVitestProfile(result)).toContain('Vitest success: **false**');
    expect(renderVitestProfile(result)).toContain('2 passed, 1 failed, 1 pending, 0 todo; 4 total');
  });

  it('limits the ranking to 25 while listing every split candidate', () => {
    const rendered = renderVitestProfile(profileVitest(report(Array.from({ length: 27 }, (_, i) =>
      file(`test/${i}.test.ts`, 60_000 - i * 1000))), 120));
    expect(rendered.match(/^\| \d+ \|/gm)).toHaveLength(25);
    expect(rendered).toContain('RQ-PERF-2 split candidates (27)');
    expect(rendered).toContain('- test/26.test.ts — 34.000 s');
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid wall time %s', wall => {
    expect(() => profileVitest(report(), wall)).toThrow('wallSeconds');
  });

  it.each([
    { startTime: undefined }, { endTime: NaN }, { endTime: Infinity },
    { startTime: -1 }, { endTime: 999 },
  ])('refuses unknown or reversed spans: %j', patch => {
    expect(() => profileVitest(report([{ ...file('test/a.test.ts', 1000), ...patch }]), 10)).toThrow('Invalid reporter span');
  });

  it('rejects an impossible span, empty results, invalid counts and duplicate paths', () => {
    expect(() => profileVitest(report(), 0.5)).toThrow('exceeds process wall time');
    expect(() => profileVitest(report([]), 10)).toThrow('nonempty');
    expect(() => profileVitest({ ...report(), numFailedTests: undefined }, 10)).toThrow('numFailedTests');
    expect(() => profileVitest(report([file('test/a', 1), file('/repo/test/a', 2)]), 10, '/repo')).toThrow('Duplicate');
    expect(() => profileVitest(report([file('test/a', 1), file('test/../test/a', 2)]), 10, '/repo')).toThrow('Duplicate');
  });

  it('refuses paths outside the repository and missing names', () => {
    expect(() => profileVitest(report([file('/elsewhere/a', 1)]), 10, '/repo')).toThrow('outside');
    expect(() => profileVitest(report([file('../a', 1)]), 10)).toThrow('outside');
    expect(() => profileVitest(report([file('test/../../a', 1)]), 10)).toThrow('outside');
    expect(() => profileVitest(report([file('', 1)]), 10)).toThrow('Missing');
  });

  it('escapes Markdown cells and handles a zero-duration file without a candidate', () => {
    const rendered = renderVitestProfile(profileVitest(report([file('test/a|<b>`\n.test.ts', 0)]), 10));
    expect(rendered).toContain('test/a&#124;&lt;b&gt;&#96; .test.ts | 0.000 | 0.00%');
    expect(rendered).toContain('\nNone.\n');
    expect(rendered).toContain('zero does not establish that a file was fast');
    expect(() => main([])).toThrow('Usage:');
  });
});
