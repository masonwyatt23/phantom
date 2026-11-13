/**
 * RQ-PHX-REGISTRYSORTORIGINAL246S: pure-library slice of original PR #4543
 * (commit d0bfe3709307c7897bf675840e2fed3473bf20b4). Covers only
 * scripts/lib/cli-registry-sort.mjs — the deterministic sorting helpers —
 * against inline fixtures. The registry rewrites, .gitattributes union-merge
 * rules and the scripts/sort-cli-registries.mjs driver from #4543 are out of
 * scope for this job and are NOT asserted here.
 */
import { describe, expect, it } from 'vitest';

import { sortHelpEntriesSource, sortSubcommandsSource } from '../scripts/lib/cli-registry-sort.mjs';

const HELP_FIXTURE = [
  'export const HELP_ENTRIES: HelpEntry[] = [',
  "  { cmd: 'beta', desc: 'b', topic: 'core' },",
  '',
  "  { cmd: 'zeta', desc: 'z', topic: 'core' },",
  "  { cmd: 'alpha [--json]', desc: 'a', topic: 'core' },",
  '];',
].join('\n');

const HELP_SORTED = [
  'export const HELP_ENTRIES: HelpEntry[] = [',
  "  { cmd: 'alpha [--json]', desc: 'a', topic: 'core' },",
  "  { cmd: 'beta', desc: 'b', topic: 'core' },",
  "  { cmd: 'zeta', desc: 'z', topic: 'core' },",
  '];',
].join('\n');

const SUB_FIXTURE = [
  'const SUBCOMMANDS: Record<string, string[]> = {',
  "  zed: ['a'],",
  '  // about beta',
  '  beta: [',
  "    'x', 'y',",
  '  ],',
  '};',
].join('\n');

const SUB_SORTED = [
  'const SUBCOMMANDS: Record<string, string[]> = {',
  '  // about beta',
  "  beta: ['x', 'y'],",
  "  zed: ['a'],",
  '};',
].join('\n');

describe('sortHelpEntriesSource (original #4543 pure fixture tests)', () => {
  it('a new help entry inserted anywhere is moved to its sorted slot', () => {
    const out = sortHelpEntriesSource(HELP_FIXTURE).split('\n');
    expect(out.slice(1, 4).map((l) => /cmd: '(\w+)/.exec(l)?.[1])).toEqual(['alpha', 'beta', 'zeta']);
    expect(sortHelpEntriesSource(HELP_FIXTURE)).toBe(HELP_SORTED);
  });

  it('rejects a malformed multiline help entry', () => {
    expect(() => sortHelpEntriesSource(HELP_FIXTURE.replace("{ cmd: 'zeta'", "{\n    cmd: 'zeta'"))).toThrow(/single-line/);
  });

  it('is idempotent on an already-sorted source', () => {
    expect(sortHelpEntriesSource(HELP_SORTED)).toBe(HELP_SORTED);
  });

  it('preserves surrounding source outside the HELP_ENTRIES block', () => {
    const src = `// header\n${HELP_SORTED}\n// footer\n`;
    expect(sortHelpEntriesSource(src)).toBe(src);
  });

  it('rejects a source missing the registry markers', () => {
    expect(() => sortHelpEntriesSource('const x = 1;')).toThrow(/registry start marker/);
  });
});

describe('sortSubcommandsSource (original #4543 pure fixture tests)', () => {
  it('collapses multi-line entries, keeps comments, rejects duplicates', () => {
    expect(sortSubcommandsSource(SUB_FIXTURE)).toBe(SUB_SORTED);
    expect(() => sortSubcommandsSource(SUB_FIXTURE.replace('zed', 'beta'))).toThrow(/duplicate/);
  });

  it('is idempotent on an already-sorted source', () => {
    expect(sortSubcommandsSource(SUB_SORTED)).toBe(SUB_SORTED);
  });

  it('rejects an unterminated entry', () => {
    const src = [
      'const SUBCOMMANDS: Record<string, string[]> = {',
      "  alpha: [",
      "    'x',",
      '};',
    ].join('\n');
    expect(() => sortSubcommandsSource(src)).toThrow(/unterminated/);
  });

  it('rejects a trailing comment with no following entry', () => {
    const src = [
      'const SUBCOMMANDS: Record<string, string[]> = {',
      "  alpha: ['x'],",
      '  // dangling note',
      '};',
    ].join('\n');
    expect(() => sortSubcommandsSource(src)).toThrow(/unterminated|trailing comment/);
  });

  it('sorts quoted and bare keys by key text', () => {
    const src = [
      'const SUBCOMMANDS: Record<string, string[]> = {',
      "  'quoted-key': ['a'],",
      '  bare: [\'b\'],',
      '};',
    ].join('\n');
    const out = sortSubcommandsSource(src);
    expect(out.indexOf('bare:')).toBeLessThan(out.indexOf("'quoted-key':"));
  });
});
