/** Shared bounded origin/master history reader for surface ownership evidence. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SurfaceOwnerDeps } from './surface-owner.js';

const exec = promisify(execFile);
const waiting: Array<() => void> = [];
let active = 0;

// A slot belongs to the child until execFile settles, including timeout/error paths.
async function git(args: string[]): Promise<string> {
  await new Promise<void>(resolve => {
    const start = () => { active++; resolve(); };
    if (active < 2) start();
    else waiting.push(start);
  });
  try {
    return (await exec('git', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export const gitSurfaceLog: SurfaceOwnerDeps['log'] = async (file, count) => {
  const stdout = await git(['--literal-pathspecs', 'log', `-n${count * 3}`, '--format=%H%x09%h%x09%cI%x09%s', 'origin/master', '--', file]);
  const rows = stdout.split('\n').filter(Boolean).map(line => {
    const [fullSha = '', sha = '', date = '', ...subject] = line.split('\t');
    return { fullSha, sha, date, subject: subject.join('\t') };
  });
  const counts = new Map<string, number>();
  if (rows.length) {
    try {
      // One bounded process per path, rather than one per commit. Empty NUL
      // fields frame headers; filenames themselves cannot contain NUL.
      const names = await git(['show', '--format=%x00%H%x00', '--name-only', '-z', ...rows.map(row => row.fullSha)]);
      const parts = names.split(/\0([0-9a-f]{40,64})\0\0/g);
      for (let i = 1; i + 1 < parts.length; i += 2) {
        const files = parts[i + 1]!.replace(/^\n/, '').split('\0').filter(Boolean);
        counts.set(parts[i]!, files.length);
      }
    } catch { /* Unknown counts preserve existing behavior. */ }
  }
  return rows.map(({ fullSha, ...row }) => ({ ...row, filesChanged: counts.get(fullSha) ?? null }));
};
