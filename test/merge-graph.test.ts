import { describe, expect, it } from 'vitest';
import { mergeGraph } from '../src/core/fleet/merge-graph.js';

const now = Date.parse('2026-11-09T12:30:00Z');
const rows = [
  { event: 'launch', job: 'a', lane: 'work', ts: '2026-11-08T09:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'a', ts: '2026-11-09T11:05:00Z', ttm_s: 60 },
  { event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:30:00Z', ttm_s: 180 },
  { event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:30:00Z', ttm_s: 180 },
  { event: 'outcome', state: 'MERGED', job: 'c', lane: 'fast', ts: '2026-11-09T12:10:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'old', lane: 'work', ts: '2026-11-08T12:59:00Z' },
  '{malformed',
  { event: 'outcome', state: 'MERGED', job: 'future', lane: 'work', ts: '2026-11-09T13:30:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'edge', lane: 'work', ts: '2026-11-09T13:00:00Z' },
];
const text = (values: unknown[]) => values.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');

describe('merge graph', () => {
  it('buckets unique merges by lane and computes medians from known times', () => {
    const report = mergeGraph(text(rows), now);
    const work = report.lanes!.find(lane => lane.lane === 'work')!;
    expect(work.buckets).toHaveLength(24);
    expect(work.buckets[22]).toMatchObject({ start: '2026-11-09T11:00:00.000Z', merges: 2, medianSeconds: 120 });
    expect(work.buckets[0]).toMatchObject({ merges: 0, medianSeconds: null });
    expect(report.lanes![0]!.buckets[23]).toMatchObject({ merges: 1, medianSeconds: null });
    expect(work.buckets.reduce((sum, bucket) => sum + bucket.merges, 0)).toBe(2);
  });

  it('distinguishes an unreadable ledger from an empty one', () => {
    expect(mergeGraph(null, now)).toMatchObject({ known: false, lanes: null });
    expect(mergeGraph('', now)).toMatchObject({ known: true, lanes: [] });
  });

  it('reads current job aliases and reconciler outcome rows without inventing merges', () => {
    const report = mergeGraph(text([
      { event: 'launch', job: 'RQ-REC', lane: 'devin', ts: '2026-11-09T09:00:00Z' },
      { event: 'publish', jobId: 'RQ-REC', prUrl: 'https://github.com/ashlrai/phantom/pull/4387', outcome: 'MERGED', source: 'metrics-outcomes-reconciler', ts: '2026-11-09T11:00:00Z', mergedAt: '2026-11-09T11:00:00Z' },
      { event: 'publish', jobId: 'RQ-OPEN', prUrl: 'https://github.com/ashlrai/phantom/pull/1', outcome: 'PUBLISHED', source: 'metrics-outcomes-reconciler', ts: '2026-11-09T11:10:00Z' },
      { event: 'outcome', job_id: 'RQ-DIRECT', state: 'MERGED', ts: '2026-11-09T11:30:00Z', ttm_s: 30 },
      { event: 'merged', job: 'RQ-MERGED-EVENT', ts: '2026-11-09T11:45:00Z' },
      { event: 'finish', job: 'RQ-FINISH', outcome: 'MERGED', ts: '2026-11-09T11:40:00Z' },
    ]), now);
    const devin = report.lanes!.find(lane => lane.lane === 'devin')!;
    const unknown = report.lanes!.find(lane => lane.lane === 'unknown')!;
    expect(devin.buckets[22]).toMatchObject({ merges: 1, medianSeconds: null });
    expect(unknown.buckets[22]).toMatchObject({ merges: 2, medianSeconds: 30 });
    expect(report.lanes!.reduce((sum, lane) => sum + lane.buckets.reduce((n, bucket) => n + bucket.merges, 0), 0)).toBe(3);
  });

  it('attributes a merge to the latest launch at or before the merge', () => {
    const report = mergeGraph(text([
      { event: 'launch', job: 'RQ-RELAUNCH', lane: 'old-lane', ts: '2026-11-09T10:00:00Z' },
      { event: 'outcome', job: 'RQ-RELAUNCH', state: 'MERGED', ts: '2026-11-09T11:00:00Z' },
      { event: 'launch', job: 'RQ-RELAUNCH', lane: 'new-lane', ts: '2026-11-09T12:00:00Z' },
    ]), now);
    expect(report.lanes).toEqual([expect.objectContaining({ lane: 'old-lane' })]);
    expect(report.lanes![0]!.buckets[22]!.merges).toBe(1);
  });
});
