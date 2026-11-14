import { execFile } from 'node:child_process';

/** One tailnet host. IPs, keys, node ids, tags and user logins are deliberately never carried. */
export interface TailnetPeer {
  hostName: string;
  os: string;
  online: boolean;
  lastSeen: string | 'unknown';
  isSelf: boolean;
}

export interface TailnetPeers {
  asOf: string;
  self: TailnetPeer;
  peers: TailnetPeer[];
  reasons: string[];
}

export type TailnetPeersResult =
  | ({ available: true } & TailnetPeers)
  | { available: false; reason: string };

/** Injected runner: resolves stdout, rejects on missing binary, non-zero exit or timeout. */
export type TailnetExec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<string>;

// Read-only argv. Never add `up`, `set`, `login`, `serve`, `funnel` or anything that changes state.
const STATUS_ARGV = ['status', '--json'] as const;
const TIMEOUT_MS = 5_000;
const MAX_PEERS = 1_000;

const EMPTY_SELF: TailnetPeer = { hostName: 'unknown', os: 'unknown', online: false, lastSeen: 'unknown', isSelf: true };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);

function lastSeen(v: unknown): string | 'unknown' {
  const s = str(v);
  if (!s) return 'unknown';
  const t = Date.parse(s);
  // Tailscale reports the zero time for never-seen peers.
  if (Number.isNaN(t) || new Date(t).getUTCFullYear() <= 1) return 'unknown';
  return new Date(t).toISOString();
}

function toPeer(raw: unknown, isSelf: boolean): TailnetPeer | null {
  if (!isRecord(raw)) return null;
  const hostName = str(raw.HostName) ?? str(raw.DNSName)?.split('.')[0];
  if (!hostName) return null;
  return {
    hostName,
    os: str(raw.OS) ?? 'unknown',
    online: raw.Online === true,
    lastSeen: lastSeen(raw.LastSeen),
    isSelf,
  };
}

/** Validate `tailscale status --json` defensively; malformed input yields empty peers plus a reason. */
export function parseTailnetStatus(json: unknown, now: Date = new Date()): TailnetPeers {
  const asOf = now.toISOString();
  if (!isRecord(json)) return { asOf, self: EMPTY_SELF, peers: [], reasons: ['status is not a JSON object'] };
  const reasons: string[] = [];
  const self = toPeer(json.Self, true);
  if (!self) reasons.push('Self entry missing or malformed');
  const peers: TailnetPeer[] = [];
  if (json.Peer === undefined || json.Peer === null) {
    reasons.push('Peer map absent');
  } else if (!isRecord(json.Peer)) {
    reasons.push('Peer is not a map');
  } else {
    let skipped = 0;
    for (const raw of Object.values(json.Peer).slice(0, MAX_PEERS)) {
      const p = toPeer(raw, false);
      if (p) peers.push(p); else skipped++;
    }
    if (skipped) reasons.push(`${skipped} malformed peer entr${skipped === 1 ? 'y' : 'ies'} skipped`);
  }
  peers.sort((a, b) => a.hostName.localeCompare(b.hostName));
  return { asOf, self: self ?? EMPTY_SELF, peers, reasons };
}

/** Run `tailscale status --json` through the injected runner. Read-only; never throws. */
export async function readTailnetPeers(exec: TailnetExec = defaultExec, now: Date = new Date()): Promise<TailnetPeersResult> {
  let stdout: string;
  try {
    stdout = await exec('tailscale', [...STATUS_ARGV], { timeoutMs: TIMEOUT_MS });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const reason = code === 'ENOENT' ? 'tailscale binary not found' : `tailscale status failed: ${(err as Error)?.message?.split('\n')[0] ?? 'unknown error'}`;
    return { available: false, reason: reason.slice(0, 300) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { available: true, ...parseTailnetStatus(null, now), reasons: ['tailscale status output is not valid JSON'] };
  }
  return { available: true, ...parseTailnetStatus(parsed, now) };
}

function defaultExec(file: string, args: string[], opts: { timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}
