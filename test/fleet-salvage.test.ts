import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetSalvage } from '../src/cli/fleet-salvage.js';
import { readSalvageIndex } from '../src/core/fleet/salvage-index.js';

const T1 = new Date('2026-11-05T10:00:00.000Z');
const T2 = new Date('2026-11-08T10:00:00.000Z');
const NOW = Date.parse('2026-11-10T10:00:00.000Z');

interface Fixture { root: string; salvage: string; run: string }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'fleet-salvage-'));
  const salvage = join(root, 'salvage');
  const run = join(root, 'queue', 'run');
  mkdirSync(run, { recursive: true });
  mkdirSync(salvage);
  return { root, salvage, run };
}

function writeEntry(f: Fixture, id: string, files: Record<string, number>, mtime: Date): string {
  const dir = join(f.salvage, id);
  mkdirSync(dir);
  for (const [name, size] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'x'.repeat(size));
    utimesSync(path, mtime, mtime);
  }
  utimesSync(dir, mtime, mtime);
  return dir;
}

function buildTwoEntries(f: Fixture): void {
  writeEntry(f, 'RQ-ALPHA100', { 'fix.patch': 2048, 'notes.txt': 1024 }, T1);
  const beta = writeEntry(f, 'RQ-BETA200', { 'change.diff': 1024, 'sub/inner.patch': 1024 }, T2);
  // Level 3 is beyond the walk bound and must not be counted.
  mkdirSync(join(beta, 'sub', 'deep'), { recursive: true });
  const buried = join(beta, 'sub', 'deep', 'buried.patch');
  writeFileSync(buried, 'x'.repeat(999));
  utimesSync(buried, new Date('2026-11-09T10:00:00.000Z'), new Date('2026-11-09T10:00:00.000Z'));
  // A symlinked file inside an entry is never followed or counted.
  symlinkSync(join(beta, 'change.diff'), join(beta, 'link.patch'));
  // A symlinked entry directory is skipped.
  symlinkSync(join(f.salvage, 'RQ-ALPHA100'), join(f.salvage, 'RQ-LINK300'));
  // Folder names that are not job ids are ignored, as is a job-id-named file.
  mkdirSync(join(f.salvage, 'random-folder'));
  writeFileSync(join(f.salvage, 'random-folder', 'stray.patch'), 'x'.repeat(8));
  writeFileSync(join(f.salvage, 'RQ-FILE600'), 'x'.repeat(8));
  utimesSync(beta, T2, T2);
  writeFileSync(join(f.run, 'RQ-ALPHA100.fin'), 'finished ok\nhttps://github.com/ashlrai/phantom/pull/123\n');
}

describe('readSalvageIndex', () => {
  it('lists entries with counts, bytes, modifiedAt and patchFiles, newest first', async () => {
    const f = fixture();
    try {
      buildTwoEntries(f);
      const index = await readSalvageIndex(f.root);
      expect(index.v).toBe(1);
      expect(index.state).toBeUndefined();
      expect(index.entries.map(entry => entry.id)).toEqual(['RQ-BETA200', 'RQ-ALPHA100']);
      const [beta, alpha] = index.entries;
      expect(alpha).toMatchObject({
        fileCount: 2, bytes: 3072, modifiedAt: T1.toISOString(),
        patchFiles: ['fix.patch'], publishedPr: 123,
      });
      expect(beta).toMatchObject({
        fileCount: 2, bytes: 2048, modifiedAt: T2.toISOString(),
        patchFiles: ['change.diff', 'sub/inner.patch'], publishedPr: null,
      });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('skips symlinked entries, symlinked files, non-job-id folders and deep files', async () => {
    const f = fixture();
    try {
      buildTwoEntries(f);
      const index = await readSalvageIndex(f.root);
      expect(index.entries.map(entry => entry.id)).toEqual(['RQ-BETA200', 'RQ-ALPHA100']);
      const beta = index.entries[0]!;
      expect(beta.fileCount).toBe(2);
      expect(beta.patchFiles).not.toContain('link.patch');
      expect(beta.patchFiles).not.toContain('sub/deep/buried.patch');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports publishedPr null when the .fin marker is missing or has no phantom PR', async () => {
    const f = fixture();
    try {
      writeEntry(f, 'RQ-NOFIN400', { 'a.patch': 16 }, T1);
      writeEntry(f, 'RQ-FOREIGN500', { 'b.patch': 16 }, T1);
      writeFileSync(join(f.run, 'RQ-FOREIGN500.fin'), 'done\nhttps://github.com/other/repo/pull/5\n');
      const index = await readSalvageIndex(f.root);
      expect(index.entries.find(entry => entry.id === 'RQ-NOFIN400')?.publishedPr).toBeNull();
      expect(index.entries.find(entry => entry.id === 'RQ-FOREIGN500')?.publishedPr).toBeNull();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports absent when salvage is missing and when it is a regular file', async () => {
    const missing = mkdtempSync(join(tmpdir(), 'fleet-salvage-none-'));
    try {
      expect((await readSalvageIndex(missing)).state).toBe('absent');
    } finally { rmSync(missing, { recursive: true, force: true }); }
    const f = mkdtempSync(join(tmpdir(), 'fleet-salvage-file-'));
    try {
      writeFileSync(join(f, 'salvage'), 'not a directory');
      const index = await readSalvageIndex(f);
      expect(index.state).toBe('absent');
      expect(index.entries).toEqual([]);
    } finally { rmSync(f, { recursive: true, force: true }); }
  });

  it('reports unavailable when the salvage dir cannot be listed', async () => {
    const f = fixture();
    try {
      chmodSync(f.salvage, 0o000);
      const index = await readSalvageIndex(f.root);
      expect(index.state).toBe('unavailable');
      expect(index.entries).toEqual([]);
      chmodSync(f.salvage, 0o755);
    } finally {
      try { chmodSync(f.salvage, 0o755); } catch { /* already restored */ }
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe('cmdFleetSalvage', () => {
  it('prints the index under --json', async () => {
    const f = fixture();
    const output: string[] = [];
    try {
      buildTwoEntries(f);
      const code = await cmdFleetSalvage(['--json'], { runsDir: f.root, output: text => output.push(text) });
      expect(code).toBe(0);
      const report = JSON.parse(output[0]!);
      expect(report.v).toBe(1);
      expect(report.entries.map((entry: { id: string }) => entry.id)).toEqual(['RQ-BETA200', 'RQ-ALPHA100']);
      expect(report.entries[1].publishedPr).toBe(123);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('keeps only unpublished entries under --unpublished', async () => {
    const f = fixture();
    const output: string[] = [];
    try {
      buildTwoEntries(f);
      const code = await cmdFleetSalvage(['--unpublished'], { runsDir: f.root, now: NOW, output: text => output.push(text) });
      expect(code).toBe(0);
      expect(output).toEqual([`RQ-BETA200\t2 files\t2 KB\t2d\tno PR`]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('formats one tab-separated line per entry in text mode', async () => {
    const f = fixture();
    const output: string[] = [];
    try {
      buildTwoEntries(f);
      const code = await cmdFleetSalvage([], { runsDir: f.root, now: NOW, output: text => output.push(text) });
      expect(code).toBe(0);
      expect(output).toEqual([
        'RQ-BETA200\t2 files\t2 KB\t2d\tno PR',
        'RQ-ALPHA100\t2 files\t3 KB\t5d\tPR #123',
      ]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('prints No salvaged work when the index is empty', async () => {
    const f = fixture();
    const output: string[] = [];
    try {
      const code = await cmdFleetSalvage([], { runsDir: f.root, output: text => output.push(text) });
      expect(code).toBe(0);
      expect(output).toEqual(['No salvaged work.']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('exits 2 on unknown and repeated flags', async () => {
    const f = fixture();
    const errors: string[] = [];
    try {
      expect(await cmdFleetSalvage(['--bogus'], { runsDir: f.root, error: text => errors.push(text) })).toBe(2);
      expect(await cmdFleetSalvage(['--json', '--json'], { runsDir: f.root, error: text => errors.push(text) })).toBe(2);
      expect(await cmdFleetSalvage(['--unpublished', '--unpublished'], { runsDir: f.root, error: text => errors.push(text) })).toBe(2);
      expect(errors.length).toBe(3);
      expect(errors[0]).toContain('Usage: ashlr fleet salvage');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('exits 1 with a one-line error when the index is unavailable', async () => {
    const f = fixture();
    const errors: string[] = [];
    try {
      chmodSync(f.salvage, 0o000);
      const code = await cmdFleetSalvage(['--json'], { runsDir: f.root, error: text => errors.push(text) });
      expect(code).toBe(1);
      expect(errors).toEqual(['error: salvage index unavailable (cannot read salvage/)']);
    } finally {
      try { chmodSync(f.salvage, 0o755); } catch { /* already restored */ }
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
