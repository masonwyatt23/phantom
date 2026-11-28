import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Script sources must stay plain text: a literal NUL or other C0 control byte
 * inside a string literal makes ripgrep, `file` and git treat the file as
 * binary, so code search silently skips it and diffs degrade. Write the escape
 * (`\u0000`, `\u0003`, ...) instead — it produces the identical string.
 *
 * Only script extensions are scanned: binary assets (fonts, images) live under
 * src/ legitimately, and test/ fixtures deliberately embed control bytes to
 * exercise sanitizers.
 */
const SCRIPT_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SOURCE_ROOTS = ['src', 'scripts'];

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', ...SOURCE_ROOTS], { cwd: process.cwd() })
      .toString()
      .split('\n')
      .filter(Boolean);
  } catch {
    return SOURCE_ROOTS.flatMap((root) => walk(join(process.cwd(), root)))
      .map((path) => relative(process.cwd(), path));
  }
}

/** Byte offset (0-based) and value of the first offending control byte, or null. */
function firstControlByte(path: string): { offset: number; byte: number } | null {
  const data = readFileSync(path);
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) {
      return { offset: i, byte: b };
    }
  }
  return null;
}

describe('source control bytes', () => {
  it('keeps tracked script sources free of literal control bytes', () => {
    const files = trackedFiles().filter((file) => SCRIPT_FILE.test(file));
    expect(files.length, 'source scan must include more than 100 files').toBeGreaterThan(100);

    const offenders = files
      .map((file) => ({ file, hit: firstControlByte(join(process.cwd(), file)) }))
      .filter((entry): entry is { file: string; hit: { offset: number; byte: number } } => entry.hit !== null);

    const report = offenders
      .map(({ file, hit }) => `${file}: byte 0x${hit.byte.toString(16).padStart(2, '0')} at offset ${hit.offset} — write the escape sequence instead of a literal control byte`)
      .join('\n');
    expect(offenders, `Literal control bytes in script sources:\n${report}`).toEqual([]);
  });
});
