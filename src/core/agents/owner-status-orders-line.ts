/** One-line "your orders" evidence for the owner's "Phantom status" answer:
 * how many of Mason's recent inbox orders reached each work state under the
 * Nov 12 22:29 ET reporting contract. Counts only — no order text, order ids
 * or paths can reach the line, so the reply cannot leak what he asked for.
 *
 * formatOrdersLine is pure; defaultOrdersLine is the live-read seam the Slack
 * socket wiring passes in beside defaultRuntimeLine. The trace readers stay
 * out of the Tier-1 import closure because only non-closure modules
 * (cli wiring + tests) import this file. */
import { parseOrderAt } from '../../cli/fleet-orders.js';
import { readOrderTrace, type OrderTraceV1 } from '../fleet/order-trace.js';
import { classifyOrder } from '../fleet/order-work-state.js';
import type { WorkItemState } from '../comms/work-item-state.js';

/** The reporting contract's look-back for "recent" inbox orders. */
export const ORDERS_WINDOW_HOURS = 72;
export const ORDERS_UNKNOWN_LINE = 'Your orders: unknown (inbox unreadable)';

/** States are named only when their count is above zero, in this order. */
const STATES: readonly WorkItemState[] = ['VERIFIED', 'RUNNING', 'BLOCKED', 'ASSIGNED', 'RECEIVED'];

function clock(now: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

/** "Your orders (72h): 2 VERIFIED, 1 RUNNING; as of 13:40 ET" — counts only.
 * No counted order reads "Your orders (72h): none". */
export function formatOrdersLine(counts: Partial<Record<WorkItemState, number>>, asOf: Date, hours: number): string {
  const parts = STATES.filter(state => (counts[state] ?? 0) > 0).map(state => `${counts[state]} ${state}`);
  if (parts.length === 0) return `Your orders (${hours}h): none`;
  return `Your orders (${hours}h): ${parts.join(', ')}; as of ${clock(asOf)} ET`;
}

/** The live seam: one trace read, orders from the last 72 hours, each
 * classified from structured evidence. A failed trace read or an unhealthy
 * inbox source reads "unknown" rather than dropping the line silently. */
export async function defaultOrdersLine(now: Date, deps: { read?: typeof readOrderTrace } = {}): Promise<string> {
  let trace: OrderTraceV1;
  try {
    trace = await (deps.read ?? readOrderTrace)({ now: () => now.getTime() });
  } catch {
    return ORDERS_UNKNOWN_LINE;
  }
  if (trace.sources.inbox !== 'healthy') return ORDERS_UNKNOWN_LINE;
  const cutoff = now.getTime() - ORDERS_WINDOW_HOURS * 3_600_000;
  const counts: Partial<Record<WorkItemState, number>> = {};
  for (const order of trace.orders) {
    const at = parseOrderAt(order.at);
    if (at === null || at < cutoff) continue;
    const state = classifyOrder(order, trace.generatedAt, now.toISOString()).state;
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return formatOrdersLine(counts, now, ORDERS_WINDOW_HOURS);
}
