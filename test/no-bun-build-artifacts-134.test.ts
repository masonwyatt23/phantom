import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MAX_BYTES = 20 * 1024 * 1024;
const LARGE_FILE_ALLOWLIST: string[] = [];

function trackedFiles(): string[] {
  return execSync('git ls-files -z', { cwd: ROOT, encoding: 'utf-8' })
    .split('\0').filter(Boolean);
}

describe('tracked build artifacts', () => {
  it('tracks no Bun build temporary files', () => {
    expect(trackedFiles().filter((file) => file.endsWith('.bun-build'))).toEqual([]);
  });

  it('tracks no files larger than 20 MiB without an explicit exception', () => {
    const oversized = trackedFiles().filter((file) => {
      if (LARGE_FILE_ALLOWLIST.includes(file)) return false;
      try {
        return statSync(join(ROOT, file)).size > MAX_BYTES;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
    expect(oversized).toEqual([]);
  });
});
