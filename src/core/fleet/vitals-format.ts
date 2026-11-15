import { FLEET_VITALS_STALE_MS, type FleetVitals, type VitalsAttribution } from './vitals.js';

const number = (value: number | null): string => value === null ? '?' : String(Math.round(value * 10) / 10);
const attr = (value: VitalsAttribution): string => `${value.source}: state: ${value.state}; observed ${value.observedAt ?? 'unknown'}`;

/** Presentation only: every figure comes from the canonical projection. */
export function formatFleetVitals(v: FleetVitals): string {
  const lines: string[] = [];
  for (const [path, source] of Object.entries(v.sources)) {
    const present = source.state === 'fresh' || source.state === 'stale';
    const state = source.kind === 'durable' && present ? 'present' : source.state;
    lines.push(`## ${path}: state: ${state}; file observed ${source.observedAt ?? 'unknown'}; ${source.kind === 'durable'
      ? 'durable context, not live status' : `status record (stale after ${FLEET_VITALS_STALE_MS / 60_000}m)`}${source.recordedAt ? `; recorded ${source.recordedAt}` : ''}${source.truncated ? '; truncated' : ''}`);
    if (source.summary) lines.push(source.summary);
  }
  lines.push('## fleet vitals (derived digest of live queue/dispatch/job records):');
  lines.push(`[${attr(v.admission)}] admission: admit=${v.admission.admit ?? '?'} reasons=${v.admission.reasons.join('; ') || 'none'} warnings=${v.admission.warnings.join('; ') || 'none'}`);
  lines.push(`[${attr(v.host)}] load1=${number(v.host.load1)}/${number(v.host.load_max)} procs=${number(v.host.procs)} worktrees=${number(v.host.worktrees)}`);
  for (const lane of v.lanes) {
    lines.push(`[${attr(lane)}] lane ${lane.lane}: running=${number(lane.running)} target=${number(lane.target)} floor=${number(lane.floor)} cap=${number(lane.cap)} queued=${number(lane.queued)}${lane.held ? ' HELD' : ''}`);
  }
  for (const b of v.budget) {
    lines.push(`[${attr(b)}] budget: ${b.lane}:used=${number(b.used_pct)}%${b.reset_at ? ` reset=${b.reset_at.slice(0, 16)}` : ''}${b.state === 'stale' ? ' STALE' : ''}`);
  }
  lines.push(`[${attr(v.host.status)}] disk: free_gb=${number(v.host.free_gb)} lane_gate=${v.host.lane_disk_gate ?? '?'} mem_free=${number(v.host.mem_free_pct)}% swap_gb=${number(v.host.swap_gb)}`);
  for (const event of v.recent) {
    const label = event.source === 'metrics/jobs.jsonl' ? 'jobs.jsonl tail' : event.source === 'dispatch-events.log' ? 'dispatch-events tail' : event.source;
    lines.push(`[${attr(event)}] ${label}: ${event.at ?? 'unknown time'} ${event.event.toUpperCase()} ${[event.job, event.repo, event.lane, event.tier, event.url].filter(Boolean).join(' ')}`);
  }
  for (const finding of v.findings) lines.push(`[${attr(finding)}] open finding: ${finding.id} ${finding.code ?? ''} ${finding.lane ?? ''} ${finding.severity ?? ''}`);
  if (v.truncated) lines.push('Evidence truncated to bounded source/payload limits; absence is not proof of no activity.');
  return lines.join('\n');
}
