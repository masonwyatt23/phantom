import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

it('observes pause and scrubs a Windows hold path while retaining valid lanes beside malformed rows', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'recut-c482-'));
  try {
    await mkdir(join(runsDir, 'queue'));
    const path = join(runsDir, 'queue/status.json');
    const base = { schema: 'dispatchd.status.v1', last_tick: '2026-11-16T12:00:00Z', mem_free_pct: 60 };
    await writeFile(path, JSON.stringify({ ...base, paused: 'operator hold for quota', lanes: {
      'Bad Lane': { running: 0, target: 1, queued: 0, held: false },
      'no-held': { running: 0, target: 1, queued: 0 },
      'good-lane': { running: 2, target: 3, queued: 1, floor: 0, ceiling: 4, held: true, held_reason: 'see C:\\ops\\quota.txt' },
    } }));
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('degraded');
    expect(state.paused).toBe(true);
    expect(state.lanes.map(l => l.lane)).toEqual(['good-lane']);
    expect(state.lanes[0]!.floor).toBe(0);
    expect(state.lanes[0]!.heldReason).toContain('[path]');
    expect(state.lanes[0]!.heldReason).not.toContain('C:\\ops');

    await writeFile(path, JSON.stringify({ ...base, lanes: {} }));
    const absent = await readFleetRunsDirState({ runsDir });
    expect(absent.sources.status).toBe('degraded');
    expect(absent.paused).toBeNull();
    expect(absent.lastTick).toBeNull();
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});
