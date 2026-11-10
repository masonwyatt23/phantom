/**
 * `ashlr fleet salvage` backing read (RQ-PHX-SALVAGEREAD86).
 *
 * When a finished job's publish aborts (G1 abort, classifier failure,
 * secret-shape abort) the diff is kept under `~/.ashlr-runs/salvage/<JOB-ID>/`
 * so the work is not lost — but nothing read that folder, so a planner or the
 * Leader could not find finished work to recut. This index answers "what is
 * retained, how big is it, and did it ever become a PR".
 *
 * READ-ONLY: lstat/readdir only, never follows symlinks, never reads patch
 * content (only the bounded `queue/run/<id>.fin` marker for a PR URL), and
 * never writes under the runs dir.
 */

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { validJobId } from './job-path-history.js';

export interface SalvageEntry {
  id: string;
  fileCount: number;
  bytes: number;
  modifiedAt: string;
  patchFiles: string[];
  publishedPr: number | null;
}

export interface SalvageIndex {
  v: 1;
  observedAt: string;
  entries: SalvageEntry[];
  state?: 'absent' | 'unavailable';
}

/** Files directly in the entry are level 1; one subdir down is level 2. */
const MAX_DEPTH = 2;
const MAX_FILES_PER_ENTRY = 500;
const MAX_PATCH_FILES = 20;
const FIN_MAX_BYTES = 64 * 1024;
const PHANTOM_PR_URL = /https:\/\/github\.com\/ashlrai\/phantom\/pull\/(\d{1,9})\b/i;
const PATCH_NAME = /\.(patch|diff)$/;

interface EntryScan { fileCount: number; bytes: number; newestMs: number; patchFiles: string[] }

/** Bounded no-follow walk: <= 2 levels, <= 500 regular files, content never read. */
async function scanEntry(dir: string, dirMtimeMs: number): Promise<EntryScan> {
  let fileCount = 0, bytes = 0, newestMs = dirMtimeMs;
  const patchFiles: string[] = [];
  // Each pending dir lists children at `childDepth`; dirs at MAX_DEPTH are never listed.
  const pending: Array<{ path: string; childDepth: number }> = [{ path: dir, childDepth: 1 }];
  while (pending.length > 0 && fileCount < MAX_FILES_PER_ENTRY) {
    const { path, childDepth } = pending.pop()!;
    let names: string[];
    try { names = await readdir(path); } catch { continue; }
    for (const name of names.sort()) {
      if (fileCount >= MAX_FILES_PER_ENTRY) break;
      const child = join(path, name);
      let stat;
      try { stat = await lstat(child); } catch { continue; }
      if (stat.isDirectory()) {
        if (childDepth < MAX_DEPTH) pending.push({ path: child, childDepth: childDepth + 1 });
      } else if (stat.isFile()) {
        fileCount++;
        bytes += stat.size;
        if (stat.mtimeMs > newestMs) newestMs = stat.mtimeMs;
        if (PATCH_NAME.test(name) && patchFiles.length < MAX_PATCH_FILES) {
          patchFiles.push(relative(dir, child).split(sep).join('/'));
        }
      }
    }
  }
  patchFiles.sort();
  return { fileCount, bytes, newestMs, patchFiles };
}

/** First ashlrai/phantom PR URL in the finish marker, bounded and no-follow. */
async function readPublishedPr(runDir: string, id: string): Promise<number | null> {
  let file;
  try {
    file = await open(join(runDir, `${id}.fin`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, FIN_MAX_BYTES);
    const buffer = Buffer.alloc(size);
    let used = 0;
    while (used < size) {
      const { bytesRead } = await file.read(buffer, used, size - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const match = PHANTOM_PR_URL.exec(buffer.subarray(0, used).toString('utf8'));
    return match ? Number(match[1]) : null;
  } catch { return null; } finally { await file?.close(); }
}

export async function readSalvageIndex(root?: string): Promise<SalvageIndex> {
  const base = root ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const salvageDir = join(base, 'salvage');
  const observedAt = new Date().toISOString();
  let names: string[];
  try {
    if (!(await lstat(salvageDir)).isDirectory()) {
      return { v: 1, observedAt, entries: [], state: 'absent' };
    }
    names = await readdir(salvageDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // A missing or non-directory salvage root is normal; anything else must
    // never look like an empty index.
    return { v: 1, observedAt, entries: [], state: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unavailable' };
  }
  const runDir = join(base, 'queue', 'run');
  const entries: SalvageEntry[] = [];
  for (const name of names) {
    if (!validJobId(name)) continue;
    try {
      const dir = join(salvageDir, name);
      const stat = await lstat(dir);
      if (!stat.isDirectory()) continue;
      const scan = await scanEntry(dir, stat.mtimeMs);
      entries.push({
        id: name, fileCount: scan.fileCount, bytes: scan.bytes,
        modifiedAt: new Date(scan.newestMs).toISOString(),
        patchFiles: scan.patchFiles, publishedPr: await readPublishedPr(runDir, name),
      });
    } catch { continue; }
  }
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id));
  return { v: 1, observedAt, entries };
}
