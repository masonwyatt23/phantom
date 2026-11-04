/** Pure Git environment hardening, independent of sandbox lifecycle loading. */
const DAEMON_GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Command-scope config forced on EVERY git call this module makes (worktree
 * add/remove/prune, branch -D, rev-parse, diff capture), directly or through
 * the pinned-worktree child scripts, which inherit it through the env.
 *
 * WHY: a sandbox worktree is LINKED to its source repo (the fleet mirror, or
 * Mason's checkout in legacy mode) and shares that repo's config and hooks
 * directory. Anything that plants `core.fsmonitor=<cmd>`, a hook or a
 * `core.hooksPath` there — between two mirror syncs, or in a legacy checkout —
 * would otherwise run as Mason, unconfined, the next time the daemon touched
 * the worktree. GIT_CONFIG_COUNT entries are COMMAND scope, which beats every
 * config file, and unlike `-c` they reach git spawned by the child scripts.
 */
export const DAEMON_GIT_FORCED_CONFIG: readonly (readonly [string, string])[] = Object.freeze([
  ['core.hooksPath', DAEMON_GIT_NULL_DEVICE],
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['core.pager', 'cat'],
  ['credential.helper', ''],
  ['commit.gpgSign', 'false'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['submodule.recurse', 'false'],
  ['protocol.ext.allow', 'never'],
] as const);

/**
 * Content filter drivers (`filter.<name>.clean|smudge|process`) are the same
 * kind of configured program, but under a name the attacker picks, so no
 * fixed key can null them. `worktree add` runs smudge on checkout and `add -A`
 * runs clean, for any path an attribute maps to the driver — `.gitattributes`
 * in the checked-out tree, or `$GIT_DIR/info/attributes`, which
 * `--attr-source` does not cover. The drivers defined in the repository's own
 * config (local / worktree scope, includes counted where they are included)
 * are read first and each is nulled at command scope; global and system
 * drivers (git-lfs) are the operator's own and stay.
 */
const FILTER_DRIVER_KEY_RE = /^filter\.(.+)\.(?:clean|smudge|process|required)$/;
const REPO_CONFIG_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

/** Driver names from `git config --show-scope --null --name-only --get-regexp '^filter\.'` output. */
export function repoScopedFilterDrivers(listing: string): string[] {
  const parts = listing.split('\0');
  const names = new Set<string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const match = FILTER_DRIVER_KEY_RE.exec(parts[i + 1]!);
    if (match && REPO_CONFIG_SCOPES.has(parts[i]!)) names.add(match[1]!);
  }
  return [...names].sort();
}

/** Command-scope entries that leave each named filter driver with no program to run. */
export function filterDriverOverrides(names: readonly string[]): (readonly [string, string])[] {
  return names.flatMap((name) => [
    [`filter.${name}.process`, ''],
    [`filter.${name}.clean`, ''],
    [`filter.${name}.smudge`, ''],
    [`filter.${name}.required`, 'false'],
  ] as const);
}

/**
 * `env` plus DAEMON_GIT_FORCED_CONFIG (and `extra`, e.g. filterDriverOverrides)
 * as GIT_CONFIG_COUNT entries. Existing well-formed entries are kept and ours
 * are appended AFTER them (the last value wins, so ours hold); a malformed
 * count is replaced rather than trusted.
 */
export function withDaemonGitHardening(env: NodeJS.ProcessEnv, extra: readonly (readonly [string, string])[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const raw = out.GIT_CONFIG_COUNT;
  let count = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  for (let i = 0; i < count; i += 1) {
    if (out[`GIT_CONFIG_KEY_${i}`] === undefined || out[`GIT_CONFIG_VALUE_${i}`] === undefined) { count = 0; break; }
  }
  if (count === 0) {
    for (const key of Object.keys(out)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete out[key];
  }
  for (const [key, value] of [...DAEMON_GIT_FORCED_CONFIG, ...extra]) {
    out[`GIT_CONFIG_KEY_${count}`] = key;
    out[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}
