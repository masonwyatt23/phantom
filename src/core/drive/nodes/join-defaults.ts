import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { validCap, validId } from './state.js';
import { probeNodeLanes } from './worker.js';

/** Defaults for `phm node join` so a machine joins in one command: node id from
 * the hostname, owner scope from this machine's own `gh` login, caps from the
 * same lane probe the worker uses. Every value stays overridable by flags and
 * nothing secret is read: `gh api user` returns only the public login, and caps
 * are capability names, never credentials. */
export interface JoinDefaultsDeps {
  ghLogin?: () => string | null;
  caps?: () => string[];
  host?: () => string;
}

export interface JoinDefaults {
  node?: string;
  owners?: string[];
  caps?: string[];
}

/** Which join flags were absent and may take a computed default. */
export interface JoinDefaultsWanted {
  node?: boolean;
  owner?: boolean;
  caps?: boolean;
}

const GH_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The gh login of this machine's own session, or null. Only the login string is
 * read; the token never leaves gh and nothing is stored or sent. */
export function ghLogin(run: typeof spawnSync = spawnSync): string | null {
  // Tests never shell out to a real gh login (network + real account).
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') return null;
  const res = run('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  const login = res.status === 0 ? String(res.stdout).trim() : '';
  return GH_LOGIN.test(login) ? login : null;
}

/** Lane caps this machine can serve, identical to what `phm node worker` would
 * advertise. Empty under test (the probe spawns real provider CLIs). */
export function joinCaps(): string[] {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') return [];
  try {
    return [...new Set(probeNodeLanes().filter(validCap))];
  } catch {
    return [];
  }
}

/** Hostname folded to a valid node id (`MacBook-Pro.local` -> `macbook-pro-local`). */
export function defaultNodeId(host: () => string = () => hostname()): string | undefined {
  const id = host().toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '-').replace(/^[-_.:/]+/, '').slice(0, 200);
  return validId(id) ? id : undefined;
}

/** Compute only the defaults for flags the caller did not pass. */
export function joinDefaults(wanted: JoinDefaultsWanted, deps: JoinDefaultsDeps = {}): JoinDefaults {
  const out: JoinDefaults = {};
  if (wanted.node) {
    const node = defaultNodeId(deps.host);
    if (node !== undefined) out.node = node;
  }
  if (wanted.owner) {
    const login = (deps.ghLogin ?? ghLogin)();
    if (login !== null) out.owners = [`person:${login}`];
  }
  if (wanted.caps) {
    const caps = (deps.caps ?? joinCaps)();
    if (caps.length) out.caps = caps;
  }
  return out;
}
