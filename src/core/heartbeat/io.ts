/** Bounded, owner-only reads of the same fleet sources used by teammate context. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { openStableDirectoryGuard } from '../util/stable-file-read.js';
import { scrubPrivateText } from '../util/scrub.js';

export const scrub = (text: string): string => scrubPrivateText(text, { emails: true }).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
export function bytePrefix(text: string, max: number): string {
  return Buffer.from(text).subarray(0, max).toString('utf8').replace(/\uFFFD$/u, '');
}

function safe(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
}

export function readHeartbeatFile(root: string, relative: string, max = 64 * 1024, tail = false): { text: string; mtime: number } | null {
  const path = join(root, relative);
  // A directory guard checks every ancestor below the anchor and rejects links.
  const guard = openStableDirectoryGuard(dirname(path), { anchorPath: dirname(root) });
  if (!guard.ok) return null;
  let fd: number | undefined;
  let finished = false;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!safe(stat) || (!tail && stat.size > max)) return null;
    const start = tail ? Math.max(0, stat.size - max) : 0;
    const buf = Buffer.alloc(Math.min(stat.size, max));
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, start + offset);
      if (!n) break;
      offset += n;
    }
    const after = fstatSync(fd);
    if (!safe(after) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
    let text = buf.subarray(0, offset).toString('utf8');
    if (start) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    if (tail) text = text.slice(0, text.lastIndexOf('\n') + 1); // incomplete append is never evidence
    const changed = guard.finish(); finished = true;
    return changed ? null : { text, mtime: stat.mtimeMs };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); if (!finished) guard.finish(); }
}

/** Append only our journal. No fleet/admission/queue file is ever written. */
export function appendHeartbeat(root: string, text: string): void {
  const path = join(root, 'metrics/heartbeat-fast.jsonl');
  const guard = openStableDirectoryGuard(dirname(path), { anchorPath: dirname(root) });
  if (!guard.ok) throw new Error('Heartbeat journal unavailable');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = fstatSync(fd);
    if (!safe(stat) || (stat.mode & 0o077) !== 0 || lstatSync(path).ino !== stat.ino) throw new Error('Unsafe heartbeat journal');
    const bytes = Buffer.from(text + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('Heartbeat journal write failed');
      offset += written;
    }
    fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); guard.finish(); }
}
