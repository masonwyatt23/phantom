/**
 * Pure classifier for "empty" test files (RQ-PHX-EMPTYTESTGUARD371). A file is
 * empty when it is blank, or has no test-defining call once comments are gone.
 * An empty file runs zero tests, so vitest passes it and it proves nothing.
 */

/** Calls that count as test content. `describe.skip(` still matches `describe(`-style intent via `describe`. */
const TEST_CALL = /\b(?:it|test|describe|bench)(?:\.\w+)*\s*\(|\b(?:it|test)\.each\b/;

/** Remove `//` and block comments while leaving string/template contents intact. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function findEmptyTestFiles(entries: { path: string; text: string }[]): string[] {
  return entries
    .filter(({ text }) => {
      const code = stripComments(text);
      return code.trim() === '' || !TEST_CALL.test(code);
    })
    .map((e) => e.path);
}
