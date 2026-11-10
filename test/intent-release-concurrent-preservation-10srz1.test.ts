/**
 * RQ-PHX-INTENTSHIPSERIAL10SRZ1 — noteShippedRelease inside the ledger transaction.
 *
 * noteShippedRelease now runs its read-match-write inside transactIntentLedger,
 * serialized with addIntent/updateIntent/importIntentFiles by the per-ledger
 * file lock and the in-process queue. These tests prove with real child
 * processes released on a shared barrier — plus one deterministically held
 * transaction — that a release receipt cannot drop a concurrent unrelated add
 * or same-directive edit, that a refused or unmatched release leaves edits
 * intact, and that replay does not corrupt receipts.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addIntent, updateIntent } from '../src/core/intent/edit.js';
import { noteShippedRelease } from '../src/core/intent/release.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, transactIntentLedger, writeLedger } from '../src/core/intent/store.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const EDIT_URL = pathToFileURL(resolve('src/core/intent/edit.ts')).href;
const RELEASE_URL = pathToFileURL(resolve('src/core/intent/release.ts')).href;

const CHILD_SCRIPT = `
import { existsSync, writeFileSync } from 'node:fs';
import { addIntent, updateIntent } from ${JSON.stringify(EDIT_URL)};
import { noteShippedRelease } from ${JSON.stringify(RELEASE_URL)};
const job = JSON.parse(process.env.CHILD_JOB ?? '{}');
const root = process.env.ASHLR_RUNS_DIR;
writeFileSync(job.ready, 'ok');
const deadline = Date.now() + 25000;
while (!existsSync(job.go)) {
  if (Date.now() > deadline) { console.error('barrier timeout'); process.exit(3); }
  await new Promise((resolve) => setTimeout(resolve, 2));
}
let out;
try {
  if (job.op === 'add') {
    out = await addIntent({ title: job.title, source: 'concurrent-release', owner: 'fleet', rq: [job.rq] }, root);
  } else if (job.op === 'update') {
    out = await updateIntent(job.id, { owner: job.owner }, root);
  } else if (job.op === 'release') {
    out = await noteShippedRelease({ release: job.release, rq: [job.rq], notes: job.notes }, { root, now: job.now });
  } else {
    throw new Error('unknown op ' + job.op);
  }
  console.log('RESULT ' + JSON.stringify(out));
} catch (error) {
  console.log('RESULT ' + JSON.stringify({ error: String((error && error.message) || error) }));
  process.exitCode = 4;
}
`;

interface ChildJob {
  op: 'add' | 'update' | 'release';
  ready: string;
  go: string;
  title?: string;
  rq?: string;
  id?: string;
  owner?: string;
  release?: string;
  notes?: string;
  now?: string;
}

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function until(predicate: () => boolean, what: string, ms = 25_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

/** Spawn every child, hold them on a shared go-file barrier, then release together. */
async function runChildren(jobs: ChildJob[], root: string): Promise<Record<string, unknown>[]> {
  const children = jobs.map((job) => {
    const child = spawnProcess(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', CHILD_SCRIPT], {
      env: { ...process.env, ASHLR_RUNS_DIR: root, CHILD_JOB: JSON.stringify(job) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveClose, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolveClose({ code, stdout, stderr }));
    });
    return { job, child, closed };
  });
  try {
    await until(() => jobs.every((job) => existsSync(job.ready)), 'all children to start');
    await writeFile(jobs[0]!.go, 'go');
    const outcomes = await Promise.all(children.map((entry) => entry.closed));
    return outcomes.map((outcome, index) => {
      expect(outcome.code, `child ${index} stderr: ${outcome.stderr}`).toBe(0);
      const line = outcome.stdout.split('\n').find((row) => row.startsWith('RESULT '));
      expect(line, `child ${index} produced no result: ${outcome.stdout}`).toBeTruthy();
      return JSON.parse(line!.slice('RESULT '.length)) as Record<string, unknown>;
    });
  } finally {
    for (const entry of children) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
    }
  }
}

const NOW = '2026-11-10T12:00:00.000Z';

function seedItem(over: Partial<IntentItem>): IntentItem {
  return {
    id: 'seed-ship-1', title: 'Seeded shippable directive', source: 'owner', owner: 'owner', rq: ['RQ-SHIP-1'],
    prs: [{ repo: 'fake/repo', number: 42, state: 'merged' }], status: 'merged', evidence: [],
    provenance: [{ source: 'owner', date: null, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: '2026-11-09T00:00:00.000Z', staleAfterMs: 604_800_000,
    createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
    ...over,
  };
}

async function seed(root: string, items: IntentItem[]): Promise<void> {
  const ledger = emptyLedger();
  ledger.items.push(...items);
  await writeLedger(ledger, root);
}

async function ledgerBytes(root: string): Promise<string> {
  return readFile(intentLedgerPath(root), 'utf8');
}

let root: string;
let barrier: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-10srz1-'));
  barrier = await mkdtemp(join(tmpdir(), 'intent-10srz1-barrier-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(barrier, { recursive: true, force: true });
});

function jobsFor(specs: Array<Omit<ChildJob, 'ready' | 'go'>>, prefix: string): ChildJob[] {
  return specs.map((spec, index) => ({
    ...spec,
    ready: join(barrier, `${prefix}-${index}.ready`),
    go: join(barrier, `${prefix}-go`),
  }));
}

describe('noteShippedRelease ledger transaction (RQ-PHX-INTENTSHIPSERIAL10SRZ1)', () => {
  it('keeps a release receipt, unrelated adds and a same-directive edit across real processes', async () => {
    await seed(root, [seedItem({})]);
    const jobs = jobsFor([
      { op: 'release', release: 'fake-v9', rq: 'RQ-SHIP-1', now: NOW },
      { op: 'add', title: 'Concurrent directive A', rq: 'RQ-NEW-10SRZ1-A' },
      { op: 'add', title: 'Concurrent directive B', rq: 'RQ-NEW-10SRZ1-B' },
      { op: 'add', title: 'Concurrent directive C', rq: 'RQ-NEW-10SRZ1-C' },
      { op: 'update', id: 'seed-ship-1', owner: 'edited-owner' },
      // An unmatched release must succeed with zero matches and erase nothing.
      { op: 'release', release: 'fake-v9', rq: 'RQ-NO-SUCH-KEY', now: NOW },
    ], 'mixed');
    const results = await runChildren(jobs, root);
    for (const result of results) expect(result['error']).toBeUndefined();
    expect(results[0]).toMatchObject({ updated: 1, matches: [{ id: 'seed-ship-1', status: 'shipped' }] });
    expect(results[5]).toMatchObject({ updated: 0, matches: [] });

    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(4);
    const shipped = ledger.items.find((item) => item.id === 'seed-ship-1')!;
    expect(shipped.status).toBe('shipped');
    expect(shipped.owner).toBe('edited-owner');
    expect(shipped.prs).toEqual([{ repo: 'fake/repo', number: 42, state: 'merged' }]);
    expect(shipped.evidence).toEqual([{ at: NOW, kind: 'release', ref: 'fake-v9' }]);
    const titles = ledger.items.map((item) => item.title);
    for (const letter of ['A', 'B', 'C']) expect(titles).toContain(`Concurrent directive ${letter}`);
  });

  it('serializes noteShippedRelease against writers held inside a real transaction', async () => {
    await seed(root, [seedItem({ status: 'queued' })]);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolveReady) => { entered = resolveReady; });
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const held = transactIntentLedger(root, async (ledger) => {
      entered();
      await gate;
      ledger.items[0]!.owner = 'held-writer';
    });
    await ready;
    const shipped = noteShippedRelease({ release: 'fake-v9', rq: ['RQ-SHIP-1'] }, { root, now: NOW });
    const added = addIntent({ title: 'During held transaction', source: 'fixture', rq: ['RQ-DURING-10SRZ1'] }, root);
    const edited = updateIntent('seed-ship-1', { owner: 'post-hold-owner' }, root);
    const early = await Promise.race([shipped.then(() => true), new Promise<false>((resolveEarly) => setTimeout(() => resolveEarly(false), 100))]);
    release();
    const result = await shipped;
    await Promise.all([held, added, edited]);
    expect(early).toBe(false);
    expect(result).toEqual({ updated: 1, matches: [{ id: 'seed-ship-1', status: 'shipped' }] });

    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(2);
    const item = ledger.items.find((row) => row.id === 'seed-ship-1')!;
    // The held transaction wrote first; the serialized edit then applied on top.
    expect(item.owner).toBe('post-hold-owner');
    expect(item.status).toBe('shipped');
    expect(item.evidence.map((row) => row.ref)).toEqual(['fake-v9']);
    expect(ledger.items.some((row) => row.title === 'During held transaction')).toBe(true);
  });

  it('a refused or unmatched release cannot erase edits and leaves bytes untouched', async () => {
    await seed(root, [seedItem({ status: 'queued' })]);
    await updateIntent('seed-ship-1', { owner: 'kept-owner' }, root);
    const before = await ledgerBytes(root);
    // Malformed release ref: markShipped throws inside the transaction, no write.
    await expect(noteShippedRelease({ release: '', rq: ['RQ-SHIP-1'] }, { root, now: NOW }))
      .rejects.toThrow(/Release must be/);
    expect(await ledgerBytes(root)).toBe(before);
    // Valid but unmatched: returns zero matches and does not rewrite the file.
    expect(await noteShippedRelease({ release: 'fake-v9', rq: ['RQ-NO-SUCH-KEY'] }, { root, now: NOW }))
      .toEqual({ updated: 0, matches: [] });
    expect(await ledgerBytes(root)).toBe(before);
    const item = (await readLedger(root)).items[0]!;
    expect(item.owner).toBe('kept-owner');
    expect(item.status).toBe('queued');
    expect(item.evidence).toEqual([]);
  });

  it('replays a release receipt once per call without duplicating pulls or promoting status', async () => {
    await seed(root, [seedItem({ status: 'verified' })]);
    const release = { release: 'fake-v9', rq: ['RQ-SHIP-1'], notes: 'fake notes' };
    const expected = { updated: 1, matches: [{ id: 'seed-ship-1', status: 'verified' }] };
    expect(await noteShippedRelease(release, { root, now: NOW })).toEqual(expected);
    expect(await noteShippedRelease(release, { root, now: NOW })).toEqual(expected);
    const item = (await readLedger(root)).items[0]!;
    expect(item.status).toBe('verified');
    expect(item.prs).toEqual([{ repo: 'fake/repo', number: 42, state: 'merged' }]);
    // Exactly one receipt row per call; replay adds no extra or divergent rows.
    expect(item.evidence).toEqual([
      { at: NOW, kind: 'release', ref: 'fake-v9' },
      { at: NOW, kind: 'release', ref: 'fake-v9' },
    ]);
  });
});
