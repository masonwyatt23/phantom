/**
 * core/fleet/fleet-recheck.ts: one read-only verdict joining the five runtime
 * readers behind `ashlr fleet recheck` — runtime identity, the claims ledger,
 * channel health, the work board and the bus-work-claims table — so a single
 * answer can say which host is answering, whether shared state is fresh, which
 * bridge is missing and which authorized task is running. The task pick's
 * identity is the bus-work-claims row the board bound it to: the board stamps
 * `claimReceipt = bus-claim:<id>:<cursor>:<receivedAt>` only when a claim row
 * matches its inbox receipt on all three coordinates, so rebuilding that
 * string from each inspected row and comparing whole (never splitting — claim
 * ids may contain ':') recovers the exact binding. The task verifies only when
 * the claims table is available, exactly one row matches, the row's owner
 * equals the board owner, the claim is not completed, and its lease is live at
 * the verdict's clock. The coordination ledger no longer gates the verdict:
 * an owner's live ledger claim stays a weak pick-ordering signal only, and
 * ledgerClaim stays null because owner equality alone is not task identity.
 *
 * Every reader is injected (defaults come from the modules themselves), each
 * read is bounded at SECTION_TIMEOUT_MS, and a reader that throws or stalls
 * marks only its own section UNKNOWN with '<section>: reader failed'; the whole
 * recheck never fails. Nothing is written, sent or inferred from prose — the
 * verdict grants no dispatch or claim authority, and 'routed' never appears as
 * a state.
 *
 * Output is sanitized through sanitizeIdentityText (home → ~, IPs dropped);
 * no message bodies, leases or env values ever reach the result.
 *
 * Overall: VERIFIED only when all four sections verify. Otherwise the worst
 * section state wins, ranked BLOCKED > UNKNOWN > VERIFIED — a positively
 * identified gap (missing bridge, no eligible task) is a worse answer than an
 * unreadable reader — with missing[] gathered across sections.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { listWorkBoard, type WorkBoardResult } from '../comms/work-board.js';
import { inspectBusWorkClaims, type BusWorkClaimsInspection, type BusWorkClaimView } from './bus-work-claims.js';
import { readChannelHealth, type ChannelHealth, type ChannelHealthReport, type ChannelName } from './channel-health.js';
import { readFleetBoard, type FleetBoard, type FleetClaim } from './coordination.js';
import {
  defaultRuntimeIdentityDeps,
  readRuntimeIdentity,
  sanitizeIdentityText,
  UNKNOWN,
  type RuntimeIdentity,
} from './runtime-identity.js';

export const FLEET_RECHECK_SCHEMA = 'fleet.recheck.v1';
/** Per-reader bound; a stalled reader can never hold the verdict open. */
export const SECTION_TIMEOUT_MS = 5_000;
/** Claims listing cap and per-claim task text cap. */
const TOP_CLAIMS = 5;
const TASK_TEXT_MAX = 80;

export type FleetRecheckState = 'VERIFIED' | 'UNKNOWN' | 'BLOCKED';

export interface FleetRecheckRuntime {
  state: FleetRecheckState;
  source: 'runtime-identity';
  asOf: string;
  host: string;
  tailnetName: string;
  installedVersion: string;
  sourceVersion: string;
  fleetState: { ageSeconds: number | 'unknown'; stale: boolean | 'unknown' };
  missing: string[];
}

export interface FleetRecheckClaim {
  agent: string;
  repo: string;
  /** Claim task text truncated to 80 characters. */
  task: string;
  /** ISO expiry of the live claim. */
  expiresAt: string;
}

export interface FleetRecheckClaims {
  state: FleetRecheckState;
  source: 'coordination';
  asOf: string;
  /** Live claim count; null while the ledger is unreadable. */
  active: number | null;
  /** Reaped-claim count from the ledger; null while unreadable. */
  expiredClaims: number | null;
  /** Up to five live claims, newest first. */
  top: FleetRecheckClaim[];
  missing: string[];
}

export interface FleetRecheckBridgeChannel {
  channel: ChannelName;
  /** Raw channel-health state: LIVE | DEGRADED | BLOCKED | UNKNOWN. */
  state: ChannelHealth['state'];
  runtimeHost: string | null;
  processAlive: boolean | 'unknown';
  /** First exact missing[] entry for a channel that is not verified live. */
  missingBridge: string | null;
}

export interface FleetRecheckBridge {
  state: FleetRecheckState;
  source: 'channel-health';
  asOf: string;
  channels: FleetRecheckBridgeChannel[];
  /** First non-verified channel's missing entry — the bridge to name in a reply. */
  missingBridge: string | null;
  missing: string[];
}

export interface FleetRecheckTaskPick {
  id: string;
  state: 'RUNNING' | 'ASSIGNED';
  owner: string;
  claimReceipt: string;
  /** Always null: no coordination-claim field names a board item, so a live
   * ledger claim under the same owner never becomes task identity. */
  ledgerClaim: { id: string; repo: string; expiresAt: string } | null;
  /** The bus-work-claims row the pick verified against; null until verified. */
  busClaim: { owner: string; leaseUntil: string; completedAt: string | null } | null;
  asOf: string;
  source: string;
}

export interface FleetRecheckTask {
  state: FleetRecheckState;
  source: 'work-board';
  asOf: string;
  task: FleetRecheckTaskPick | null;
  /** RUNNING/ASSIGNED candidates lacking a named owner. */
  unowned: number;
  /** RUNNING/ASSIGNED candidates lacking a claim receipt. */
  unclaimed: number;
  missing: string[];
}

export interface FleetRecheck {
  schema: typeof FLEET_RECHECK_SCHEMA;
  asOf: string;
  sections: {
    runtime: FleetRecheckRuntime;
    claims: FleetRecheckClaims;
    bridge: FleetRecheckBridge;
    task: FleetRecheckTask;
  };
  overall: { state: FleetRecheckState; missing: string[] };
}

/** Every reader injectable; omitted readers fall back to the live modules. */
export interface FleetRecheckDeps {
  now?: () => Date;
  /** Home directory, used only to redact it from output. */
  homeDir?: () => string;
  readRuntimeIdentity?: () => RuntimeIdentity | Promise<RuntimeIdentity>;
  readChannelHealth?: () => ChannelHealthReport | Promise<ChannelHealthReport>;
  readFleetBoard?: () => FleetBoard | Promise<FleetBoard>;
  listWorkBoard?: () => WorkBoardResult | Promise<WorkBoardResult>;
  inspectBusWorkClaims?: () => BusWorkClaimsInspection | Promise<BusWorkClaimsInspection>;
}

/** Live readers, wired exactly as the standalone fleet commands wire them. */
export function defaultFleetRecheckDeps(now: () => Date = () => new Date()): Required<FleetRecheckDeps> {
  return {
    now,
    homeDir: () => homedir(),
    readRuntimeIdentity: () => readRuntimeIdentity(defaultRuntimeIdentityDeps()),
    readChannelHealth: () => readChannelHealth(),
    readFleetBoard: () => readFleetBoard(),
    listWorkBoard: () => listWorkBoard({ root: join(ashlrHome(), 'fleet'), now: now().getTime() }),
    inspectBusWorkClaims: () => inspectBusWorkClaims(join(ashlrHome(), 'fleet')),
  };
}

/** Run one reader inside the section bound; a throw or stall is a section failure, never a crash. */
async function attempt<T>(read: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('section reader timed out')), SECTION_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function runtimeSection(read: { ok: true; value: RuntimeIdentity } | { ok: false }, asOf: string): FleetRecheckRuntime {
  const section: FleetRecheckRuntime = {
    state: 'UNKNOWN', source: 'runtime-identity', asOf,
    host: UNKNOWN, tailnetName: UNKNOWN, installedVersion: UNKNOWN, sourceVersion: UNKNOWN,
    fleetState: { ageSeconds: 'unknown', stale: 'unknown' }, missing: ['runtime: reader failed'],
  };
  if (!read.ok) return section;
  const id = read.value;
  section.asOf = id.asOf;
  section.host = id.host;
  section.tailnetName = id.tailnetName;
  section.installedVersion = id.installedVersion;
  section.sourceVersion = id.sourceVersion;
  section.fleetState = { ageSeconds: id.fleetState.ageSeconds, stale: id.fleetState.stale };
  // VERIFIED only when a real host answers and the fleet-state read is fresh.
  if (id.host !== UNKNOWN && id.fleetState.stale === false) {
    section.state = 'VERIFIED';
    section.missing = [];
    return section;
  }
  section.missing = [...id.reasons];
  if (section.missing.length === 0) {
    section.missing.push(id.fleetState.stale === true
      ? `fleetState: stale (${id.fleetState.ageSeconds}s old)`
      : `fleetState: freshness ${id.fleetState.stale}`);
  }
  return section;
}

/** A claim is live at the verdict only with finite, ordered timestamps and
 * claimedAt <= now < expiresAt; future, expired and malformed rows never count. */
function claimLiveAt(claim: FleetClaim, nowMs: number): boolean {
  return Number.isFinite(claim.claimedAt) && Number.isFinite(claim.expiresAt)
    && claim.expiresAt > claim.claimedAt
    && claim.claimedAt <= nowMs && nowMs < claim.expiresAt;
}

function claimsSection(
  read: { ok: true; value: FleetBoard } | { ok: false },
  asOf: string,
  nowMs: number,
): FleetRecheckClaims {
  const section: FleetRecheckClaims = {
    state: 'UNKNOWN', source: 'coordination', asOf,
    active: null, expiredClaims: null, top: [], missing: ['claims: reader failed'],
  };
  if (!read.ok) return section;
  const board = read.value;
  if (board.state !== 'known') {
    section.missing = ['claims: ledger state unknown (unreadable)'];
    return section;
  }
  // An unreadable verdict clock leaves claim liveness unverifiable: keep the
  // ledger-supplied reaped count but never report a VERIFIED count or listing.
  if (!Number.isFinite(nowMs)) {
    section.expiredClaims = board.expiredClaims;
    section.missing = ['claims: verdict clock unknown, claim liveness unverifiable'];
    return section;
  }
  section.state = 'VERIFIED';
  section.missing = [];
  const live = board.claims.filter(claim => claimLiveAt(claim, nowMs));
  section.active = live.length;
  section.expiredClaims = board.expiredClaims ?? 0;
  section.top = [...live]
    .sort((a, b) => b.claimedAt - a.claimedAt || b.expiresAt - a.expiresAt)
    .slice(0, TOP_CLAIMS)
    .map(claim => ({
      agent: claim.agent,
      repo: claim.repo,
      task: claim.task.slice(0, TASK_TEXT_MAX),
      expiresAt: new Date(claim.expiresAt).toISOString(),
    }));
  return section;
}

function bridgeChannelView(channel: ChannelHealth): FleetRecheckBridgeChannel {
  const verified = channel.state === 'LIVE' && channel.runtimeHost !== null;
  return {
    channel: channel.channel,
    state: channel.state,
    runtimeHost: channel.runtimeHost,
    processAlive: channel.processAlive,
    // Name the exact missing piece for a non-verified channel; missing[] can be
    // empty on a bare DEGRADED, so fall back to the observed state itself.
    missingBridge: verified ? null : channel.missing[0] ?? `${channel.channel} bridge ${channel.state.toLowerCase()}`,
  };
}

function bridgeSection(read: { ok: true; value: ChannelHealthReport } | { ok: false }, asOf: string): FleetRecheckBridge {
  const section: FleetRecheckBridge = {
    state: 'UNKNOWN', source: 'channel-health', asOf,
    channels: [], missingBridge: null, missing: ['bridge: reader failed'],
  };
  if (!read.ok) return section;
  const report = read.value;
  section.asOf = report.asOf;
  section.channels = (['slack', 'imessage'] as const).map(name => {
    const channel = report.channels.find(c => c.channel === name);
    return channel !== undefined
      ? bridgeChannelView(channel)
      : { channel: name, state: 'UNKNOWN' as const, runtimeHost: null, processAlive: 'unknown' as const, missingBridge: `${name} bridge evidence absent` };
  });
  const missing = section.channels.map(c => c.missingBridge).filter((m): m is string => m !== null);
  section.missingBridge = missing[0] ?? null;
  section.missing = missing;
  // VERIFIED only when every channel is LIVE on a named runtime host.
  section.state = missing.length === 0 ? 'VERIFIED' : 'BLOCKED';
  return section;
}

/** Newest claim for owner that is live at the verdict's captured now; expiry and start are both judged against it. */
function liveClaimFor(board: FleetBoard, owner: string, nowMs: number): FleetClaim | undefined {
  let best: FleetClaim | undefined;
  for (const claim of board.claims) {
    if (claim.agent !== owner || !claimLiveAt(claim, nowMs)) continue;
    if (best === undefined || claim.claimedAt > best.claimedAt) best = claim;
  }
  return best;
}

/** The receipt the board stamps for a claim row, rebuilt for comparison. The
 * strings are compared whole and never split: a claim id may itself contain
 * ':', so only exact equality of all three coordinates proves the binding. */
function busClaimReceipt(row: BusWorkClaimView): string {
  return `bus-claim:${row.id}:${row.cursor}:${row.receivedAt}`;
}

/** The bus-work-claims row an item verifies against, or the one exact reason
 * it cannot: a failed or non-'available' inspection, no single row matching
 * the receipt, an owner mismatch, a completed claim, an unreadable verdict
 * clock, or a lease already dead at the captured now. */
function busClaimVerdict(
  claimsRead: { ok: true; value: BusWorkClaimsInspection } | { ok: false },
  item: { owner: string; claimReceipt: string },
  nowMs: number,
): { verified: true; row: BusWorkClaimView } | { verified: false; missing: string } {
  if (!claimsRead.ok) return { verified: false, missing: 'task: bus work claims reader failed' };
  const inspection = claimsRead.value;
  if (inspection.source !== 'available') {
    return { verified: false, missing: `task: bus work claims ${inspection.source}` };
  }
  const matches = inspection.claims.filter(row => busClaimReceipt(row) === item.claimReceipt);
  if (matches.length !== 1) {
    return { verified: false, missing: `task: no bus claim row matches receipt ${item.claimReceipt}` };
  }
  const row = matches[0]!;
  if (row.owner !== item.owner) {
    return { verified: false, missing: 'task: bus claim owner differs from board owner' };
  }
  if (row.completedAt !== null) {
    return { verified: false, missing: `task: bus claim for ${row.id} completed at ${new Date(row.completedAt).toISOString()}` };
  }
  if (!Number.isFinite(nowMs)) {
    return { verified: false, missing: 'task: verdict clock unknown, bus claim lease unverifiable' };
  }
  if (row.leaseUntil <= nowMs) {
    return { verified: false, missing: `task: bus claim lease for ${row.id} expired at ${new Date(row.leaseUntil).toISOString()}` };
  }
  return { verified: true, row };
}

function taskSection(
  read: { ok: true; value: WorkBoardResult } | { ok: false },
  asOf: string,
  ledger: { ok: true; value: FleetBoard } | { ok: false },
  busClaims: { ok: true; value: BusWorkClaimsInspection } | { ok: false },
  nowMs: number,
): FleetRecheckTask {
  const section: FleetRecheckTask = {
    state: 'UNKNOWN', source: 'work-board', asOf,
    task: null, unowned: 0, unclaimed: 0, missing: ['task: reader failed'],
  };
  if (!read.ok) return section;
  const board = read.value;
  if (board.inbox !== 'ok') {
    section.state = 'BLOCKED';
    section.missing = [`task: work board inbox ${board.inbox}`];
    return section;
  }
  const eligible = board.items.filter(item => item.state === 'RUNNING' || item.state === 'ASSIGNED');
  const owned = (item: (typeof eligible)[number]): item is typeof item & { owner: string } =>
    typeof item.owner === 'string' && item.owner.length > 0;
  const claimed = (item: (typeof eligible)[number]): item is typeof item & { claimReceipt: string } =>
    typeof item.claimReceipt === 'string' && item.claimReceipt.length > 0;
  section.unowned = eligible.filter(item => !owned(item)).length;
  section.unclaimed = eligible.filter(item => !claimed(item)).length;
  const qualified = eligible
    .filter((item): item is typeof item & { owner: string; claimReceipt: string } => owned(item) && claimed(item))
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  // The same settled ledger read claimsSection saw: unreadable means the reader
  // failed or the board reported state 'unknown' — never re-read the ledger.
  const ledgerBoard = ledger.ok && ledger.value.state === 'known' ? ledger.value : undefined;
  const liveFor = (owner: string): FleetClaim | undefined =>
    ledgerBoard === undefined ? undefined : liveClaimFor(ledgerBoard, owner, nowMs);
  // A qualified item whose bus claim verifies outranks every weaker signal:
  // the first (newest-first) item that would verify is the pick. Otherwise the
  // prior ordering applies — an owner holding a live coordination claim first
  // (RUNNING before ASSIGNED), then the plain newest-first pick. Ordering never
  // verifies the task; only the bound bus claim row does.
  const matched = qualified.filter(item => liveFor(item.owner) !== undefined);
  const pick = qualified.find(item => busClaimVerdict(busClaims, item, nowMs).verified)
    ?? matched.find(item => item.state === 'RUNNING') ?? matched[0]
    ?? qualified.find(item => item.state === 'RUNNING') ?? qualified[0];
  if (pick !== undefined) {
    const verdict = busClaimVerdict(busClaims, pick, nowMs);
    section.task = {
      id: pick.id,
      state: pick.state as 'RUNNING' | 'ASSIGNED',
      owner: pick.owner,
      claimReceipt: pick.claimReceipt,
      ledgerClaim: null,
      busClaim: verdict.verified
        ? { owner: verdict.row.owner, leaseUntil: new Date(verdict.row.leaseUntil).toISOString(), completedAt: null }
        : null,
      asOf: pick.asOf,
      source: pick.source,
    };
    section.state = verdict.verified ? 'VERIFIED' : 'UNKNOWN';
    section.missing = verdict.verified ? [] : [verdict.missing];
    return section;
  }
  section.state = 'BLOCKED';
  section.missing = eligible.length === 0
    ? ['task: no RUNNING or ASSIGNED board item']
    : ['task: no RUNNING or ASSIGNED item with a named owner and claim receipt'];
  if (section.unowned > 0) section.missing.push(`task: ${section.unowned} candidate(s) lack a named owner`);
  if (section.unclaimed > 0) section.missing.push(`task: ${section.unclaimed} candidate(s) lack a claim receipt`);
  return section;
}

const RANK: Record<FleetRecheckState, number> = { VERIFIED: 0, UNKNOWN: 1, BLOCKED: 2 };

export async function readFleetRecheck(deps: FleetRecheckDeps = {}): Promise<FleetRecheck> {
  const d: Required<FleetRecheckDeps> = { ...defaultFleetRecheckDeps(deps.now), ...deps };
  const now = d.now();
  const nowMs = now.getTime();
  const home = (() => { try { return d.homeDir(); } catch { return ''; } })();
  const asOf = Number.isFinite(nowMs) ? now.toISOString() : UNKNOWN;

  // All five readers run concurrently, each inside its own 5 s bound.
  const [runtime, claims, bridge, board, busClaims] = await Promise.all([
    attempt(d.readRuntimeIdentity),
    attempt(d.readFleetBoard),
    attempt(d.readChannelHealth),
    attempt(d.listWorkBoard),
    attempt(d.inspectBusWorkClaims),
  ]);

  const sections = {
    runtime: runtimeSection(runtime, asOf),
    claims: claimsSection(claims, asOf, nowMs),
    bridge: bridgeSection(bridge, asOf),
    task: taskSection(board, asOf, claims, busClaims, nowMs),
  };
  const states = Object.values(sections).map(section => section.state);
  const verified = states.every(state => state === 'VERIFIED');
  const worst = states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'VERIFIED' as FleetRecheckState);
  const missing = Object.values(sections).flatMap(section => section.missing);

  const result: FleetRecheck = {
    schema: FLEET_RECHECK_SCHEMA,
    asOf,
    sections,
    overall: { state: verified ? 'VERIFIED' : worst, missing },
  };
  // One sanitize pass over the finished verdict: home → ~, IPs → [ip].
  return JSON.parse(sanitizeIdentityText(JSON.stringify(result), home)) as FleetRecheck;
}
