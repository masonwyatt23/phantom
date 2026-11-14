/**
 * core/drive/nodes/join-reach-hint.ts: turn the sanitized pool-reach evidence
 * into one plain-language hint line for the node-pool refusal paths, so a
 * failed `phm node join` tells the operator whether a failover Mac is simply
 * offline on the tailnet or whether SSH approval is the likely blocker.
 *
 * reachHint is pure and total; safeReach wraps any reach read so the failure
 * output can never be made worse by the evidence reader itself. Neither
 * function does I/O, touches the network, or calls SSH or tailscale — the
 * PoolReach it consumes is already sanitized upstream (no IPs, no home
 * paths). Evidence only: it changes no exit code, retry or admission logic.
 */
import { UNKNOWN } from '../../fleet/runtime-identity.js';
import type { PoolReach } from '../../fleet/pool-reach.js';

/** First match wins: offline host, unmatched alias, missing evidence, else SSH approval. */
export function reachHint(reach: PoolReach): string {
  const offline = reach.hosts.find(host => host.online === false);
  if (offline) {
    return `${offline.slot} ${offline.alias} is offline on the tailnet (last seen ${offline.lastSeen}); start it or check tailscale before retrying`;
  }
  const unmatched = reach.hosts.find(host => host.matched === UNKNOWN);
  if (unmatched) {
    return `${unmatched.slot} ${unmatched.alias} is not a tailnet peer this computer can see; check the SSH alias or tailnet membership`;
  }
  if (reach.hosts.length === 0) {
    return `tailnet or pool evidence unavailable: ${reach.reasons[0] ?? 'no reasons reported'}`;
  }
  return 'primary and backup are online on the tailnet; the refusal is likely SSH approval or sign-in, see approvalSteps';
}

/** Run a reach read that is allowed to fail; a throw degrades to a null reach plus a fixed hint. */
export function safeReach(read: () => PoolReach): { reach: PoolReach | null; hint: string } {
  try {
    const reach = read();
    return { reach, hint: reachHint(reach) };
  } catch {
    return { reach: null, hint: 'tailnet reach unknown (reader failed)' };
  }
}
