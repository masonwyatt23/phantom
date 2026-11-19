/** core/queue/launch-evidence.ts: read local main history and the open-PR snapshot for launchDedupe. Read-only; any failure becomes `null`. */
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { nameWithOwnerFromRemote } from '../fleet/repo-identity.js';
import { defaultRunsDir } from '../fleet/landed-closes-read.js';
import { parseMergeBatchPrs } from '../fleet/merge-batch.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import type { LaunchEvidence, MainCommit, OpenPrRecord } from './launch-dedupe.js';

const exec = promisify(execFile);
const MAIN_DAYS = 14, MAX_COMMITS = 2000;

/** Parse `git log --name-only --format=%x1e%H%x1f%ct%x1f%s` output. */
export function parseMainLog(raw: string): MainCommit[] {
  return raw.split('\x1e').flatMap(chunk => {
    const [head = '', ...names] = chunk.split('\n');
    const [sha, ct, subject] = head.split('\x1f');
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha) || subject === undefined) return [];
    const at = Number(ct) * 1000;
    return [{ sha, subject, at: Number.isFinite(at) && at > 0 ? at : null, paths: names.filter(Boolean) }];
  });
}

export async function readLaunchEvidence({ cwd = process.cwd(), runsDir = defaultRunsDir(), now = Date.now() } = {}): Promise<LaunchEvidence> {
  const git = async (...args: string[]): Promise<string | null> => {
    try { return (await exec('git', args, { cwd, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, timeout: 10000, maxBuffer: 32 * 1024 * 1024 })).stdout; } catch { return null; }
  };
  const repo = nameWithOwnerFromRemote((await git('remote', 'get-url', 'origin'))?.trim() ?? '')?.toLowerCase() ?? '';
  const ref = (await git('symbolic-ref', 'refs/remotes/origin/HEAD'))?.trim();
  const log = ref ? await git('log', ref, `--since=${new Date(now - MAIN_DAYS * 86_400_000).toISOString()}`, `-n${MAX_COMMITS}`, '--no-renames', '--name-only', '--format=%x1e%H%x1f%ct%x1f%s') : null;
  let openPrs: OpenPrRecord[] | null = null;
  const snapshotPath = resolve(join(runsDir, 'fleet/open-prs.json'));
  const file = readStableRegularFile(snapshotPath, { anchorPath: dirname(snapshotPath), maxFileBytes: 16 * 1024 * 1024, remainingBytes: 16 * 1024 * 1024 });
  try {
    const snapshot = file.ok ? parseMergeBatchPrs(JSON.parse(file.text)) : null;
    if (repo && snapshot?.ok && snapshot.upstream === 'ok' && snapshot.repo?.toLowerCase() === repo) {
      openPrs = snapshot.prs.map(p => ({ number: p.number, title: p.title, headRef: p.headRef, updatedAt: p.updatedAt === null ? null : Date.parse(p.updatedAt) || null, paths: p.files }));
    }
  } catch { openPrs = null; }
  return { repo, main: repo && log !== null ? parseMainLog(log) : null, openPrs };
}
