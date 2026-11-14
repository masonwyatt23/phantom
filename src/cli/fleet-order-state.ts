/** `ashlr fleet order-state [--since <hours>] [--json]` — classify each of
 * Mason's inbox orders under the Nov12 22:29 ET reporting contract from the
 * real order trace (readOrderTrace): RECEIVED / ASSIGNED / RUNNING / BLOCKED /
 * VERIFIED with as-of, evidence source and missing evidence. RUNNING comes
 * from the live process table (listLiveWorkers): a launched or published job
 * with a live worker proves it. BLOCKED comes from the parked queue
 * (readFleetQueue): a queued job the queue lists as parked names its unmerged
 * dependency ids or parked reason. Read-only: reads local files and the host
 * process table, no network, no writes; never prints order text bodies,
 * command lines or pids. */
import { queueBlockers, type QueueBlockers } from '../core/fleet/order-queue-blockers.js';
import { classifyOrder, mostAdvancedJob, type LiveJobIds } from '../core/fleet/order-work-state.js';
import { readOrderTrace, type OrderTraceV1 } from '../core/fleet/order-trace.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';
import { readFleetQueue, type FleetQueueV1 } from '../core/fleet/runs-parked-queue.js';
import { parseOrderAt } from './fleet-orders.js';

const usage = 'Usage: ashlr fleet order-state [--since <hours 1-720>] [--json]';
const LIMIT = 20;

export async function cmdFleetOrderState(
  args: string[],
  deps: {
    read?: typeof readOrderTrace; now?: () => number;
    live?: () => Promise<LiveWorkersSnapshot>; queue?: () => Promise<FleetQueueV1>;
  } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false;
  let since: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--since' && since === undefined) {
      const raw = args[++i];
      const hours = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(hours >= 1 && hours <= 720)) { console.error(`fleet order-state: --since needs 1-720 hours\n${usage}`); return 2; }
      since = hours;
    } else { console.error(`fleet order-state: bad argument: ${arg}\n${usage}`); return 2; }
  }
  let trace: OrderTraceV1;
  try {
    trace = await (deps.read ?? readOrderTrace)({ now: deps.now });
  } catch {
    console.error('fleet order-state: unable to read the order trace');
    return 1;
  }
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  let live: LiveJobIds | undefined;
  let liveState: 'healthy' | 'unavailable';
  try {
    const snapshot = await (deps.live ?? listLiveWorkers)();
    liveState = snapshot.sourceState;
    if (liveState === 'healthy') live = { jobIds: new Set(snapshot.workers.map((w) => w.job)), at: snapshot.generatedAt };
  } catch {
    liveState = 'unavailable';
  }
  // A missing ready.tsv (no fleet queue on this host) is reported as
  // unavailable in JSON but does not warrant a text warning; a throw, a null
  // result or a degraded queue does.
  let queue: QueueBlockers | undefined;
  let queueWarn = false;
  try {
    const snapshot = await (deps.queue ?? readFleetQueue)() as FleetQueueV1 | null;
    if (snapshot == null) queueWarn = true;
    else {
      queue = queueBlockers(snapshot) ?? undefined;
      queueWarn = queue === undefined && snapshot.sources?.ready !== 'missing';
    }
  } catch {
    queueWarn = true;
  }
  const queueState: 'healthy' | 'unavailable' = queue === undefined ? 'unavailable' : 'healthy';
  let orders = [...trace.orders].sort((a, b) => b.at.localeCompare(a.at));
  if (since !== undefined) {
    orders = orders.filter((o) => { const t = parseOrderAt(o.at); return t !== null && t >= nowMs - since! * 3600_000; });
  }
  orders = orders.slice(0, LIMIT);
  // The blocker text comes only from queueBlockers (job ids or a parked
  // reason/lane token), never from prompt prose.
  const blockerText = (o: OrderTraceV1['orders'][number], state: string): string | null => {
    const id = mostAdvancedJob(o)?.id;
    return state === 'BLOCKED' && id !== undefined ? queue?.byJob.get(id) ?? null : null;
  };
  if (json) {
    console.log(JSON.stringify({
      v: 1, generatedAt: trace.generatedAt, sources: trace.sources, live: liveState, queue: queueState,
      orders: orders.map((o) => {
        const c = classifyOrder(o, trace.generatedAt, nowIso, live, queue);
        return {
          at: o.at, source: o.source, key: o.key,
          state: c.state, asOf: c.asOf, evidenceSource: c.source,
          missing: c.missing, pr: mostAdvancedJob(o)?.url ?? null, blocker: blockerText(o, c.state),
        };
      }),
    }));
    return 0;
  }
  const bad = Object.entries(trace.sources).filter(([, s]) => s !== 'healthy');
  if (bad.length) console.log(`warning: order sources not healthy: ${bad.map(([k, s]) => `${k}=${s}`).join(' ')}`);
  if (liveState === 'unavailable') console.log('warning: live workers unavailable; RUNNING not checked');
  if (queueWarn) console.log('warning: queue unavailable; BLOCKED not checked');
  for (const o of orders) {
    const c = classifyOrder(o, trace.generatedAt, nowIso, live, queue);
    const url = mostAdvancedJob(o)?.url;
    const blocker = blockerText(o, c.state);
    console.log(`${o.at} ${o.source} ${c.state} as-of=${c.asOf} source=${c.source} missing=${c.missing.length ? c.missing.join(',') : 'none'}${url ? ` pr=${url}` : ''}${blocker ? ` blocked-by=${blocker}` : ''}`);
  }
  return 0;
}
