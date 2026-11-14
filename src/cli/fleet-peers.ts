import { readTailnetPeers, type TailnetExec, type TailnetPeer, type TailnetPeersResult } from '../core/fleet/tailnet-peers.js';

const usage = `Usage: ashlr fleet peers [--json]
Read which fleet hosts are up on the tailnet (tailscale status --json). Read-only.
Exit 1 if tailscale is unavailable.`;

const row = (p: TailnetPeer): string[] => [p.isSelf ? `${p.hostName} (self)` : p.hostName, p.os, p.online ? 'yes' : 'no', p.lastSeen];

export function renderPeersTable(r: TailnetPeersResult): string {
  if (!r.available) return `tailnet unavailable: ${r.reason}`;
  const rows = [['HOST', 'OS', 'ONLINE', 'LAST SEEN'], row(r.self), ...r.peers.map(row)];
  const w = rows[0]!.map((_, i) => Math.max(...rows.map(x => x[i]!.length)));
  const lines = rows.map(x => x.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd());
  for (const reason of r.reasons) lines.push(`note: ${reason}`);
  return lines.join('\n');
}

/** Read tailnet peers only; never changes network or security settings. */
export async function cmdFleetPeers(args: string[], exec?: TailnetExec): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  const unknown = args.filter(a => a !== '--json');
  if (unknown.length) {
    console.error(`unknown argument: ${unknown[0]}\n${usage}`);
    return 2;
  }
  const result = await readTailnetPeers(exec);
  console.log(args.includes('--json') ? JSON.stringify(result) : renderPeersTable(result));
  return result.available ? 0 : 1;
}
