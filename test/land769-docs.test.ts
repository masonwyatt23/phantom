import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = resolve(__dirname, '..');
const carriedDocs = ['docs/AGENTS-MD-AUDIT.md', 'docs/llms.txt'];

describe('PR #7765 carried documentation', () => {
  it.each(carriedDocs)('resolves every relative file and anchor in %s', (file) => {
    const result = checkDocumentation({ root, mode: 'source', entrypoints: [file] });
    expect(result.errors).toEqual([]);
    expect(result.localLinks).toBeGreaterThan(0);
    expect(result.externalRequests).toBe(0);
  });

  it('preserves the refreshed audit and its generated synopsis', () => {
    const audit = readFileSync(resolve(root, carriedDocs[0]!), 'utf8');
    const index = readFileSync(resolve(root, carriedDocs[1]!), 'utf8');
    for (const text of [audit, index]) {
      expect(text).toContain('Public-source snapshot: 2026-11-20');
    }
    expect(audit).toContain('[agent readiness scorer](AGENT-READINESS.md)');
    expect(audit).toContain('phm improve promote <id> --repo <dir> --queue-merge');
    expect(audit).toContain('full suites run on scheduled master qualification');
  });
});
