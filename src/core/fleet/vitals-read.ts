/** Bounded, observational fleet reads. Never follows a source or directory link. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

export const VITALS_SOURCE_BYTES = 128 * 1024;
export const VITALS_TAIL_BYTES = 96 * 1024;
export interface VitalsRead {
  state: 'present' | 'missing' | 'unavailable';
  text: string;
  observedAt: string | null;
  truncated: boolean;
}

function safe(stat: BigIntStats, directory = false): boolean {
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)
    && (process.platform === 'win32' || ((stat.mode & 0o022n) === 0n
      && (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()))));
}

function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
    && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Fixed paths are at most one directory below runsDir. */
export function readVitalsSource(runsDir: string, relative: string, tail = false): VitalsRead {
  const failed: VitalsRead = { state: 'unavailable', text: '', observedAt: null, truncated: false };
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(relative)
    || relative.split('/').some(part => part === '.' || part === '..')) return failed;
  const file = join(runsDir, relative);
  let fd: number | undefined;
  try {
    // Check ancestors before testing absence: a dangling directory link is unavailable.
    const paths = [...new Set([runsDir, dirname(file)])];
    const directories = paths.map(path => lstatSync(path, { bigint: true }));
    if (directories.some(stat => !safe(stat, true))) return failed;
    const realDirectories = paths.map(path => realpathSync(path));
    let before: BigIntStats;
    try { before = lstatSync(file, { bigint: true }); } catch (error) {
      return { ...failed, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' };
    }
    if (!safe(before)) return failed;
    if (!tail) {
      const result = readStableRegularFile(file, {
        anchorPath: runsDir, maxFileBytes: VITALS_SOURCE_BYTES, remainingBytes: VITALS_SOURCE_BYTES,
      });
      return result.ok ? { state: 'present', text: result.text, observedAt: new Date(result.mtimeMs).toISOString(), truncated: false } : failed;
    }
    if (process.platform === 'win32' && !assurePrivateStoragePath(file, 'file', 'inspect-owned', { anchorPath: runsDir }).ok) return failed;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!safe(opened) || !same(before, opened) || opened.size > BigInt(Number.MAX_SAFE_INTEGER)) return failed;
    const size = Number(opened.size), start = Math.max(0, size - VITALS_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, start + bytes);
      if (!count) return failed;
      bytes += count;
    }
    if (!same(opened, fstatSync(fd, { bigint: true })) || !same(opened, lstatSync(file, { bigint: true }))
      || paths.some((path, index) => !same(directories[index]!, lstatSync(path, { bigint: true }))
        || realpathSync(path) !== realDirectories[index])) return failed;
    let text = buffer.toString('utf8');
    // Neither a cut first record nor an in-progress last record is evidence.
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    const last = text.lastIndexOf('\n');
    const incomplete = last !== text.length - 1;
    text = last < 0 ? '' : text.slice(0, last);
    return { state: 'present', text, observedAt: new Date(Number(opened.mtimeNs) / 1e6).toISOString(), truncated: start > 0 || incomplete };
  } catch (error) {
    return { ...failed, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* observational read */ } }
  }
}
