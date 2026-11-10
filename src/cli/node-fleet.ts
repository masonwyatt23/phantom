/** `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave`: thin handlers over DriveNodes. */
import type { NodesStore } from '../core/drive/nodes/index.js';
import { UsageError, parseNodeFleetFlags, runNodeFleet } from '../core/drive/nodes/commands.js';
import type { JoinDefaultsDeps } from '../core/drive/nodes/join-defaults.js';
import type { NodeAuth } from '../core/drive/nodes/state.js';

export interface NodeFleetDeps {
  store?: NodesStore;
  now?: () => number;
  probeAuth?: () => NodeAuth;
  joinDefaults?: JoinDefaultsDeps;
}

function hasFlag(args: string[], name: string): boolean {
  return args.some(a => a === name || a.startsWith(`${name}=`));
}

/** Fill absent join flags from this machine's own identity (hostname, gh login,
 * detected lanes). Explicit flags always win; the SSH pool path never sees these. */
async function withJoinDefaults(args: string[], deps: NodeFleetDeps): Promise<string[]> {
  const wanted = { node: !hasFlag(args, '--node'), owner: !hasFlag(args, '--owner'), caps: !hasFlag(args, '--caps') };
  if (!wanted.node && !wanted.owner && !wanted.caps) return args;
  const { joinDefaults } = await import('../core/drive/nodes/join-defaults.js');
  const d = joinDefaults(wanted, deps.joinDefaults);
  const extra: string[] = [];
  if (wanted.node && d.node !== undefined) extra.push('--node', d.node);
  if (wanted.owner && d.owners !== undefined) extra.push('--owner', d.owners.join(','));
  if (wanted.caps && d.caps !== undefined && d.caps.length) extra.push('--caps', d.caps.join(','));
  const out = [...args, ...extra];
  if (wanted.owner && d.owners === undefined) {
    throw new UsageError('missing-owner',
      '--owner is required: pass --owner <scope>, or run `gh auth login` so join defaults to person:<your gh login>.',
      'Run: gh auth login, or pass --owner <scope>. Run: phm node --help');
  }
  return out;
}


function text(verb: string, out: Record<string, unknown>): string {
  const routes = out['routes'] as { jobId: string; nodeId: string | null; fix?: string }[] | undefined;
  if (routes) return routes.length ? routes.map(r => `${r.jobId} -> ${r.nodeId ?? `nobody. ${r.fix}`}`).join('\n') : 'No routable jobs.';
  if (verb === 'status' || verb === 'list') {
    const nodes = out['nodes'] as { nodeId: string; live: boolean; usage: number; auth: string; caps: string[] }[];
    const jobs = out['jobs'] as { id: string; state: string }[];
    return [`Owner scope: ${(out['owners'] as string[]).join(',')}`,
      ...nodes.map(n => `node ${n.nodeId} ${n.live ? 'live' : 'expired'} usage=${n.usage} auth=${n.auth} caps=${n.caps.join(',') || '-'}`),
      ...jobs.map(j => `job ${j.id} ${j.state}`)].join('\n');
  }
  if (verb === 'pull') return out['pulled'] ? `Claimed ${(out['claim'] as { jobId: string }).jobId}. Renew before expiry; pass the token to every effect.` : 'No job for this node. Run: phm node plan';
  return Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : String(v)}`).join('\n');
}

export async function cmdNodeFleet(verb: string, args: string[], deps: NodeFleetDeps = {}): Promise<number> {
  let json = false;
  try {
    parseNodeFleetFlags(verb, args);
    if (!deps.store) {
      const { cmdNodePool, hasNodePool } = await import('./node-pool.js');
      if (hasNodePool()) return cmdNodePool(verb, args);
    }
    // Local router only: join flags the caller omitted take this machine's own
    // defaults (hostname, gh login, detected lanes). The pool path above keeps
    // the raw args so its --caps/--slots routing rule is unchanged.
    const effective = verb === 'join' ? await withJoinDefaults(args, deps) : args;
    const flags = parseNodeFleetFlags(verb, effective);
    json = flags.has('--json');
    // Parsing happens first and the store modules load after it, so a usage error never touches (or creates) state.
    const [{ DriveNodes, LocalNodesStore }, { probeLocalAuth }, { ashlrHome }, { privateDirectory }, { join }] = await Promise.all([
      import('../core/drive/nodes/index.js'), import('../core/drive/nodes/auth-probe.js'),
      import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path')]);
    const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(join(ashlrHome(), 'nodes'))).transaction(fn) };
    const out = runNodeFleet(verb, flags, new DriveNodes(store, deps.now ? { now: deps.now } : {}), deps.probeAuth ?? probeLocalAuth);
    console.log(json ? JSON.stringify({ schemaVersion: 1, command: verb, ...out }) : text(verb, out));
    return 0;
  } catch (error) {
    const known = error instanceof UsageError;
    const message = known ? error.message : error instanceof Error && /^Invalid drive/.test(error.message) ? error.message : 'Node store unavailable or invalid.';
    const fix = known ? error.fix : /^Invalid drive/.test(message) ? 'Check ids (letters, digits, . _ : / -), caps (lowercase) and secret NAMES (UPPER_SNAKE). Run: phm node --help'
      : 'Check that ~/.ashlr/nodes is a private (0700) directory you own, and that no other process holds its lock.';
    const code = known ? error.code : 'rejected';
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: verb, error: { code, message, fix } }));
    else console.error(`${message} Fix: ${fix}`);
    return known ? error.exit : 1;
  }
}
