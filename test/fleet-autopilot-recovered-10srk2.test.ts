import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainFleetAdmission } from '../src/cli/fleet-admission.js';
import { planFleetAutopilot, readFleetAutopilotState, type FleetAutopilotState, type AutopilotQueue } from '../src/core/fleet/autopilot.js';

const queue = (ready = 0): AutopilotQueue => ({ v: 1, generatedAt: '', sources: { ready: 'healthy', skips: 'missing' }, total: ready, ready, parked: 0, malformed: 0, byLane: [{ lane: 'work', ready, parked: 0 }], groups: [], skips: [], skipsLast24h: null });
const state = (ready = 0): FleetAutopilotState => ({
  generatedAt: '', sources: { status: 'healthy', queue: 'healthy', slots: 'healthy', rebase: 'unconfigured' },
  admission: explainFleetAdmission({ admission: { cap: 10, running: 1, load1: 0 }, lanes: { work: { running: 1, target: 3, queued: ready, held: false } } }),
  queue: queue(ready), slots: { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] }, rebase: null,
});

describe('recovered fleet planner', () => {
  it('prioritizes conflicts over a starved lane and reports utilization', () => {
    const s = state(20);
    s.rebase = [{ repo: 'fake/repo', source: 'ok', conflicting: 1, uncovered: 1, staleHeadOnly: 0 }];
    const report = planFleetAutopilot(s);
    expect(report.action).toMatchObject({ kind: 'enqueue', type: 'rebase', count: 1 });
    expect(report.lanes[0]?.utilization).toBeCloseTo(1 / 3);
    expect(report.gaps.map(g => g.kind)).toEqual(['uncovered-conflicts', 'starved-lane']);
  });
  it('handles holds, exhaustion, unknown targets, and absent supply', () => {
    const s = state();
    expect(planFleetAutopilot(s).action).toMatchObject({ kind: 'enqueue', type: 'restock', count: 2 });
    s.admission!.lanes[0]!.held = true;
    expect(planFleetAutopilot(s).gaps).toEqual([]);
    s.admission = null;
    expect(planFleetAutopilot(s).lanes[0]).toMatchObject({ target: null, freeSlots: null, depWaiting: null });
    expect(planFleetAutopilot(s).gaps).toEqual([]);
    const capped = state(1);
    capped.admission!.global.at_cap = true;
    expect(planFleetAutopilot(capped).action).toMatchObject({ kind: 'no-op', reason: 'capacity-bound' });
    capped.admission!.lanes[0]!.target = 1;
    expect(planFleetAutopilot(capped).gaps).toEqual([]);
  });
  it('distinguishes unmet and measured met dependencies', () => {
    const s = state();
    s.queue!.unmetDeps = [{ job: 'FAKE-1', lane: 'work', unmet: ['FAKE-2'] }];
    expect(planFleetAutopilot(s).lanes[0]?.depWaiting).toBe(1);
    expect(planFleetAutopilot(s).gaps.some(g => g.kind === 'stale-parked-deps')).toBe(false);
    s.queue!.metDeps = [{ job: 'FAKE-3', lane: 'work' }];
    expect(planFleetAutopilot(s).action).toMatchObject({ kind: 'enqueue', type: 'unpark' });
  });
  it('reads partial evidence without writing to the runs root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autopilot-test-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({ admission: { cap: 4, running: 0, load1: 0 }, lanes: {} }));
      const before = await readdir(join(root, 'queue'));
      const view = await readFleetAutopilotState({ runsDir: root, repos: ['fake/one', 'fake/two'], rebase: async () => ({ v: 1, generatedAt: '', queueSource: 'healthy', repos: [
        { repo: 'fake/one', source: 'ok', summary: { conflicting: 1, ageSeconds: { oldest: null, median: null, unknown: 0 }, coverage: { currentHead: 0, staleHeadOnly: 0, unknownHead: 0, uncovered: 1 } } },
        { repo: 'fake/two', source: 'unavailable', summary: null },
      ] }) });
      expect(view.sources).toMatchObject({ status: 'healthy', queue: 'missing', rebase: 'partial' });
      expect(planFleetAutopilot(view)).toMatchObject({ status: 'degraded', action: { kind: 'enqueue', type: 'rebase' } });
      expect(await readdir(join(root, 'queue'))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
