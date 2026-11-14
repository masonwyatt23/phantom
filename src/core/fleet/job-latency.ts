const phases = [
  ['queue_wait', 'queued', 'launch', 'Measure admission delays and remove the largest queue bottleneck.'],
  ['checkout', 'launch', 'checkout_complete', 'Profile checkout and reuse safe local worktree preparation.'],
  ['model', 'checkout_complete', 'finish', 'Profile model execution and reduce repeated context and tool work.'],
  ['ci', 'ci_start', 'ci_complete', 'Profile CI critical path and eliminate duplicate work.'],
  ['merge', 'ci_complete', 'merged', 'Profile post-CI merge delays and unblock the merge queue.'],
] as const;

const boundaries = new Set<string>(phases.flatMap(([, start, end]) => [start, end]));

// Missing key = unseen, number = one unique timestamp, null = permanently ambiguous.
type Events = Map<string, number | null>;

/** A job ID must identify one attempt; ambiguous repeated boundaries are never paired. */
export function jobLatency(text: string) {
  const jobs = new Map<string, Events>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      row = value as Record<string, unknown>;
    } catch { ignored++; continue; }
    const id = row.job ?? row.job_id ?? row.jobId;
    let event = row.event ?? row.type;
    if (event === 'outcome' && String(row.outcome ?? row.state).toLowerCase() === 'merged') event = 'merged';
    const time = row.ts ?? row.timestamp ?? row.at;
    const at = typeof time === 'string' ? Date.parse(time) : NaN;
    if (typeof id !== 'string' || !id || typeof event !== 'string' || !Number.isFinite(at)) { ignored++; continue; }
    const events = jobs.get(id) ?? new Map<string, number | null>();
    jobs.set(id, events);
    // Unknown events still identify a job, but cannot contribute a phase boundary.
    if (!boundaries.has(event)) continue;
    const previous = events.get(event);
    events.set(event, previous === undefined || previous === at ? at : null);
  }
  const results = phases.map(([phase, start, end, fix]) => {
    let measured = 0, totalSeconds = 0;
    for (const events of jobs.values()) {
      const a = events.get(start), b = events.get(end);
      if (typeof a === 'number' && typeof b === 'number' && b >= a) {
        measured++;
        totalSeconds += (b - a) / 1000;
      }
    }
    return { phase, measured_jobs: measured, missing_jobs: jobs.size - measured,
      total_seconds: measured ? totalSeconds : null, fix_line: fix };
  });
  return { schema: 'fleet.job-latency.v1', jobs: jobs.size, ignored_events: ignored, phases: results,
    top_wastes: results.filter(r => r.total_seconds !== null).sort((a, b) => b.total_seconds! - a.total_seconds!) };
}
