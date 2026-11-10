/**
 * lane-capacity-read.test.ts — readLaneCapacity over a temp runs dir with a
 * fake dispatchd status/slots pair shaped like contrib/mac/dispatchd.py
 * writes: fresh, stale, missing and partial reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLaneCapacity } from '../src/core/fleet/lane-capacity-read.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const MIN = 60_000;
const tick = (ageMs: number) => new Date(NOW - ageMs).toISOString();

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lane-capacity-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'queue', name), text);
  return dir;
}

const status = (lanes: unknown, lastTick: unknown = tick(2 * MIN)) =>
  JSON.stringify({ schema: 'dispatchd.status.v1', last_tick: lastTick, paused: null, mem_free_pct: 42, lanes });
const unobserved = { lanes: [], observedAt: null, stale: true };

describe('readLaneCapacity', () => {
  it('returns running/target/queued per lane with the tick as the observation instant', async () => {
    const dir = await fixture({
      'status.json': status({
        devin: { running: 7, target: 10, floor: 1, ceiling: 12, hard_cap: 12, held: false, queued: 712 },
        claude: { running: 0, target: 8, floor: 0, ceiling: 8, hard_cap: 8, held: false, queued: 0 },
      }),
    });
    const read = await readLaneCapacity(dir, NOW);
    expect(read.stale).toBe(false);
    expect(read.observedAt).toBe(tick(2 * MIN));
    expect(read.lanes).toEqual([
      { lane: 'claude', running: 0, target: 8, queued: 0, held: false, heldReason: null },
      { lane: 'devin', running: 7, target: 10, queued: 712, held: false, heldReason: null },
    ]);
  });

  it('joins the held flag and reason from slots.json when the status lane lacks held_reason', async () => {
    const dir = await fixture({
      'status.json': status({ devin: { running: 1, target: 6, held: true, queued: 3 } }),
      'slots.json': JSON.stringify({
        devin: { target: 6, floor: 1, ceiling: 12, held: true, held_reason: 'credits exhausted (anthropic)' },
      }),
    });
    const read = await readLaneCapacity(dir, NOW);
    expect(read.lanes).toEqual([
      { lane: 'devin', running: 1, target: 6, queued: 3, held: true, heldReason: 'credits exhausted (anthropic)' },
    ]);
  });

  it('prefers a held_reason written on the status lane itself and scrubs paths', async () => {
    const dir = await fixture({
      'status.json': status({ devin: { running: 0, target: 6, held: true, queued: 0, held_reason: 'autobackoff /Users/mason/private job=RQ-1' } }),
      'slots.json': JSON.stringify({ devin: { held: false, held_reason: 'stale reason' } }),
    });
    const [lane] = (await readLaneCapacity(dir, NOW)).lanes;
    expect(lane.held).toBe(true);
    expect(lane.heldReason).toContain('autobackoff');
    expect(lane.heldReason).toContain('job=RQ-1');
    expect(lane.heldReason).not.toContain('/Users/mason');
    expect(lane.heldReason).not.toBe('stale reason');
  });

  it('is stale only past 10 minutes, but still returns the lanes it read', async () => {
    const lanes = { devin: { running: 2, target: 6, held: false, queued: 1 } };
    expect(await readLaneCapacity(await fixture({ 'status.json': status(lanes, tick(10 * MIN)) }), NOW)).toMatchObject({ stale: false });
    const old = await readLaneCapacity(await fixture({ 'status.json': status(lanes, tick(11 * MIN)) }), NOW);
    expect(old).toMatchObject({ stale: true, observedAt: tick(11 * MIN) });
    expect(old.lanes).toHaveLength(1);
    const noTick = await readLaneCapacity(await fixture({ 'status.json': status(lanes, null) }), NOW);
    expect(noTick).toMatchObject({ stale: true, observedAt: null });
    expect(noTick.lanes).toHaveLength(1);
  });

  it('reads as unobserved when the status file is missing or malformed', async () => {
    expect(await readLaneCapacity(await fixture(), NOW)).toEqual(unobserved);
    expect(await readLaneCapacity(join(await fixture(), 'absent'), NOW)).toEqual(unobserved);
    expect(await readLaneCapacity(await fixture({ 'status.json': '{' }), NOW)).toEqual(unobserved);
    const wrongShape = await fixture({ 'status.json': JSON.stringify({ last_tick: tick(MIN), lanes: [1, 2] }) });
    expect(await readLaneCapacity(wrongShape, NOW)).toEqual({ lanes: [], observedAt: tick(MIN), stale: false });
  });

  it('drops lanes that cannot answer "N of M" and nulls unreported optionals', async () => {
    const dir = await fixture({
      'status.json': status({
        devin: { running: 3, target: 6, held: false },
        claude: { running: 1 },
        'codex-cmp': { running: 0.5, target: 2, held: false },
        grok: 'not an object',
        BAD_LANE: { running: 0, target: 1, held: false },
        hard_cap: { running: 0, target: 18, held: false },
      }),
    });
    expect((await readLaneCapacity(dir, NOW)).lanes).toEqual([
      { lane: 'devin', running: 3, target: 6, queued: null, held: false, heldReason: null },
    ]);
  });
});
