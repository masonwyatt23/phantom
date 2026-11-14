/**
 * core/fleet/fleet-recheck-reply.ts: turn a fleet.recheck.v1 verdict into a
 * short, paste-ready thread reply — the answer a reply worker can post when a
 * thread asks "can you reach live state". Backs `ashlr fleet recheck --reply`.
 *
 * The formatter is pure: no I/O, no clock reads, only the verdict's own asOf.
 * Output is one plain-text block capped at 900 characters, five evidence lines
 * plus a verdict line. A VERIFIED reply closes with "Evidence only; this reply
 * grants no dispatch."; anything else names what is missing. The words
 * 'routed' and 'dispatched' never appear — evidence is observed, not claimed.
 *
 * Every interpolated value is sanitized again here, not trusted from upstream:
 * IPv4/IPv6 via sanitizeIdentityText and the /Users|/home/<name> path shape via
 * a regex, so a hand-built verdict carrying another user's home path cannot
 * leak it into a thread reply.
 */
import type { FleetRecheck } from './fleet-recheck.js';
import { sanitizeIdentityText } from './runtime-identity.js';

/** Hard cap on the whole reply, including ellipses and newlines. */
const REPLY_MAX = 900;
/** Claims named in the reply; the ledger itself already caps the top list. */
const TOP_CLAIMS = 3;
/**
 * Home-dir shape from any user — /Users/<name>, /home/<name>. A verdict not
 * produced by readFleetRecheck can carry a path sanitizeIdentityText would not
 * know to strip, so the shape itself is redacted to '~'.
 */
const HOME_PATH = /\/(?:Users|home)\/[^/\s;,)]+/g;
/** The reply contract forbids these words even inside an evidence string. */
const FORBIDDEN_WORDS = /\b(?:routed|dispatched)\b/gi;

/** Redact home paths, IP addresses and contract-banned words from one value. */
function scrub(value: string): string {
  return sanitizeIdentityText(value.replace(HOME_PATH, '~'), '').replace(FORBIDDEN_WORDS, '[verb]');
}

/** Scrub before clipping so truncation cannot expose part of a sensitive value. */
function bounded(value: string, max: number): string {
  const clean = scrub(value);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Format a fleet recheck verdict as one paste-ready thread reply. */
export function formatRecheckReply(r: FleetRecheck): string {
  const { runtime, claims, bridge, task } = r.sections;
  const channel = (name: 'slack' | 'imessage'): string =>
    bridge.channels.find(c => c.channel === name)?.state ?? 'absent';
  const age = typeof runtime.fleetState.ageSeconds === 'number'
    ? `${runtime.fleetState.ageSeconds}s`
    : 'unknown';
  const top = claims.top.slice(0, TOP_CLAIMS)
    .map(c => `${bounded(c.agent, 30)}/${bounded(c.repo, 30)}`).join(', ') || 'none';
  const lines = [
    `Phantom recheck ${r.overall.state} · as of ${bounded(r.asOf, 40)} · source fleet-recheck`,
    `Runtime: ${bounded(runtime.host, 45)} · ${bounded(runtime.installedVersion, 30)} · fleet state ${age}`
      + `${runtime.fleetState.stale === true ? ' · stale' : ''} (${runtime.state})`,
    `Claims: ${claims.active === null ? 'unknown' : claims.active} live, top: ${top} (${claims.state})`,
    `Bridge: slack ${channel('slack')}, imessage ${channel('imessage')}`
      + `${bridge.missingBridge === null ? '' : ` · missing: ${bounded(bridge.missingBridge, 70)}`} (${bridge.state})`,
    task.task === null
      ? `Task: none, ${bounded(task.missing[0] ?? 'no task evidence', 70)} (${task.state})`
      : `Task: ${bounded(task.task.id, 45)} ${task.task.state} · owner ${bounded(task.task.owner, 45)} · claim ${bounded(task.task.claimReceipt, 45)} (${task.state})`,
  ];
  const evidence = lines.join('\n');
  if (r.overall.state === 'VERIFIED') {
    return `${evidence}\nEvidence only; this reply grants no dispatch.`;
  }
  const prefix = r.overall.state === 'BLOCKED' ? 'BLOCKED on: ' : 'UNKNOWN: ';
  const available = REPLY_MAX - evidence.length - 1 - prefix.length;
  const missing = r.overall.missing.map(scrub).join('; ') || 'no missing detail';
  return `${evidence}\n${prefix}${missing.length <= available ? missing : `${missing.slice(0, available - 1)}…`}`;
}
