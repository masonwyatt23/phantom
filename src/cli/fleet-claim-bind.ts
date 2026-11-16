/** `ashlr fleet claim-bind` — record which Slack thread a fleet claim came
 * from, so `runClaimNoticePass` (the `phm channels slack run` tick and
 * `ashlr fleet claim-notices`) posts that claim's ASSIGNED / RELEASED /
 * BLOCKED / VERIFIED notices back into it. Without a binding every planned
 * notice is dropped rather than guessed into a channel.
 *
 * Binding is local state only: it writes one private JSONL row under the
 * fleet runs root and sends nothing, so it does not consult the ~/.ashlr/KILL
 * switch — the notice pass that later sends does. No message text or token
 * is stored; labels grant no authority. */
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { listWorkBoard } from '../core/comms/work-board.js';
import { claimNoticeDir, claimNoticePaths } from '../core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding, validateClaimThreadKey } from '../core/fleet/claim-thread-binding-write.js';
import type { ClaimThreadBinding } from '../core/fleet/claim-thread-notice.js';

const usage = 'Usage: ashlr fleet claim-bind <claimId> --repo <owner/name> (--thread <threadKey> | --request <workItemId>) [--pr N] [--head SHA] [--json]\n'
  + 'Binds a fleet claim to the Slack thread it came from. <threadKey> is\n'
  + 'slack:<team>:<channel>:<rootTs> or <team>/<channel>/<threadTs>. A later bind for the\n'
  + 'same claim and repo replaces the earlier one. Local state only; sends nothing.';

export interface ClaimBindCliDeps {
  /** State dir override; defaults to the fleet runs root (~/.ashlr-runs). */
  runsRoot?: string;
  /** Work-board root override; defaults to ~/.ashlr/fleet. */
  fleetRoot?: string;
  listBoard?: typeof listWorkBoard;
  now?: () => number;
}

export async function cmdFleetClaimBind(args: string[], deps: ClaimBindCliDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  const fail = (reason?: string): number => {
    if (reason) console.error(`claim-bind: ${reason}`);
    console.error(usage);
    return 2;
  };
  let claimId: string | undefined, repo: string | undefined, thread: string | undefined, request: string | undefined;
  let pr: number | undefined, head: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!arg.startsWith('--')) {
      if (claimId !== undefined) return fail();
      claimId = arg;
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) return fail();
    if (arg === '--repo' && repo === undefined) repo = value;
    else if (arg === '--thread' && thread === undefined) thread = value;
    else if (arg === '--request' && request === undefined) request = value;
    else if (arg === '--head' && head === undefined) head = value;
    else if (arg === '--pr' && pr === undefined && /^\d{1,15}$/.test(value)) pr = Number(value);
    else return fail();
  }
  if (claimId === undefined || repo === undefined || (thread === undefined) === (request === undefined)) return fail();
  const now = (deps.now ?? Date.now)();
  if (request !== undefined) {
    const board = (deps.listBoard ?? listWorkBoard)({ root: deps.fleetRoot ?? join(ashlrHome(), 'fleet'), now, limit: 100 });
    const matches = board.items.filter(item => item.id === request);
    const item = matches.length === 1 ? matches[0] : undefined;
    const reason = board.inbox === 'unavailable' ? 'request-board-unavailable'
      : item === undefined ? 'request-not-found'
      : item.channel !== 'slack' ? 'request-not-slack'
      : item.channelRef === null || !validateClaimThreadKey(item.channelRef) ? 'request-thread-invalid'
      : undefined;
    if (reason !== undefined) {
      if (json) console.log(JSON.stringify({ status: 'refused', reason, claimId, repo, request }));
      else console.error(`claim-bind: refused (${reason}); nothing written`);
      return 1;
    }
    thread = item!.channelRef!;
  }
  // Exactly one source was supplied, and request references were validated above.
  const threadKey = thread!;
  const binding: ClaimThreadBinding = { claimId, repo, threadKey,
    ...(pr !== undefined ? { pr } : {}), ...(head !== undefined ? { head } : {}) };
  const path = claimNoticePaths(claimNoticeDir(deps.runsRoot)).bindings;
  const result = appendClaimThreadBinding(path, binding, now);
  if (!result.ok) {
    if (result.kind === 'invalid') return fail(result.reason);
    if (json) console.log(JSON.stringify({ status: 'refused', reason: result.reason, claimId, repo, threadKey: thread }));
    else console.error(`claim-bind: refused (${result.reason}); nothing written`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ status: result.status, claimId, repo, threadKey: thread,
      ...(request !== undefined ? { request } : {}) }));
  } else {
    console.log(`claim-bind: ${result.status} ${claimId} (${repo}) -> ${thread}${request !== undefined ? ` request=${request}` : ''}`);
    console.log('The next `phm channels slack run` tick or `ashlr fleet claim-notices` posts its transitions there.');
  }
  return 0;
}
