import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runEncodedPayloadCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles encoded payload coverage', () => {
  it('selects existing .b64 and .hex files and skips deleted, other-extension and uppercase-miss paths', () => {
    const selection = selectChangedFiles(
      ['test/fixtures/m518/payload.json.b64', 'test/fixtures/locus/obs.cli.hex', 'workplans/x/receipt.hex', 'package.json', 'src/core/x.ts', 'gone.b64', 'data.hex.json'],
      ['test/fixtures/m518/payload.json.b64', 'test/fixtures/locus/obs.cli.hex', 'workplans/x/receipt.hex', 'package.json', 'src/core/x.ts', 'data.hex.json'],
    );
    expect(selection.encodingFiles).toEqual(['test/fixtures/locus/obs.cli.hex', 'test/fixtures/m518/payload.json.b64', 'workplans/x/receipt.hex']);
    expect(selection.jsonFiles).toEqual(['data.hex.json', 'package.json']);
  });
});

describe('runEncodedPayloadCheck', () => {
  it('accepts canonical base64 and strict hex payloads, trailing newline included', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-encoding-'));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // "hello world" canonical base64, the same shape the m518 fixtures carry.
      writeFileSync(join(root, 'ok.b64'), `${Buffer.from('hello world').toString('base64')}\n`);
      writeFileSync(join(root, 'ok.hex'), '7b2261223a317d\n'); // {"a":1}
      writeFileSync(join(root, 'upper.B64'), `${Buffer.from('x').toString('base64')}\n`);
      // The backlog-marker fixture wraps a long payload across lines; the
      // decoder skips the ASCII whitespace, so wrapping is legal.
      const wrapped = Buffer.from('x'.repeat(200)).toString('base64');
      writeFileSync(join(root, 'wrapped.b64'), `${wrapped.slice(0, 76)}\n${wrapped.slice(76)}\n`);
      expect(runEncodedPayloadCheck(root, ['ok.b64', 'ok.hex', 'upper.B64', 'wrapped.b64'])).toBe(true);
    } finally {
      logs.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects base64 that is not canonical, naming the rule it broke', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-encoding-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'stray.b64'), 'aGVsbG8gd29ybGQ*!\n'); // '!' outside the alphabet
      writeFileSync(join(root, 'unpadded.b64'), 'YR==\n'); // decodes to 'a' but re-encodes as 'YQ==' — non-canonical trailing bits
      writeFileSync(join(root, 'odd.b64'), 'abc\n'); // length not a multiple of 4
      writeFileSync(join(root, 'empty.b64'), '  \n');
      writeFileSync(join(root, 'ok.b64'), 'aGVsbG8=\n');
      expect(runEncodedPayloadCheck(root, ['stray.b64', 'unpadded.b64', 'odd.b64', 'empty.b64', 'ok.b64'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('stray.b64') && line.includes('alphabet'))).toBe(true);
      expect(reported.some((line) => line.includes('unpadded.b64') && line.includes('round-trip'))).toBe(true);
      expect(reported.some((line) => line.includes('odd.b64') && line.includes('multiple of 4'))).toBe(true);
      expect(reported.some((line) => line.includes('empty.b64') && line.includes('empty'))).toBe(true);
      expect(reported.every((line) => line.startsWith('FAIL encoded payload check: '))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects hex with non-hex characters or an odd length', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-encoding-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'badchar.hex'), '7b2261223a317dzz\n');
      writeFileSync(join(root, 'odd.hex'), '7b2261223a317\n');
      writeFileSync(join(root, 'spaced.hex'), '7b22 617b\n');
      writeFileSync(join(root, 'ok.hex'), 'deadbeef\n');
      expect(runEncodedPayloadCheck(root, ['badchar.hex', 'odd.hex', 'spaced.hex', 'ok.hex'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('badchar.hex') && line.includes('hexadecimal alphabet'))).toBe(true);
      expect(reported.some((line) => line.includes('odd.hex') && line.includes('odd'))).toBe(true);
      expect(reported.some((line) => line.includes('spaced.hex') && line.includes('hexadecimal alphabet'))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when a file cannot be read and passes an empty list', () => {
    const read = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(runEncodedPayloadCheck('/repo', ['locked.b64'], read as never)).toBe(false);
    expect(runEncodedPayloadCheck('/repo', [], read as never)).toBe(true);
  });
});
