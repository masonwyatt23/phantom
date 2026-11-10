import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importIntentFiles } from '../src/core/intent/import.js';
import { INTENT_LEDGER_SCHEMA, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const intercepted = vi.hoisted(() => ({ path: '', reads: 0, replace: '' }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const result = await fs.readFile(...args);
      if (args[0] === intercepted.path) {
        intercepted.reads++;
        if (intercepted.replace) {
          await fs.rename(intercepted.replace, intercepted.path);
          intercepted.replace = '';
        }
      }
      return result;
    },
  };
});

const at = '2026-10-01T00:00:00.000Z';
const item: IntentItem = {
  id: 'native-one', title: 'Native directive', source: 'saved', owner: 'owner', rq: ['RQ-NATIVE-1'],
  prs: [{ repo: 'example/project', number: 7, url: 'https://example.test/pr/7', state: 'merged' }],
  status: 'verified', evidence: [{ at, kind: 'release', ref: 'v1.2.3', note: 'release evidence' }],
  provenance: [{ source: 'original directive', date: at, verbatim: true, partial: false }],
  partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 12345678, createdAt: at, updatedAt: at,
};
const native = { schema: INTENT_LEDGER_SCHEMA, items: [item] };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'intent-snapshot-')); });
afterEach(async () => {
  intercepted.path = ''; intercepted.reads = 0; intercepted.replace = '';
  await rm(root, { recursive: true, force: true });
});

describe('intent import snapshots', () => {
  it('uses the original raw snapshot if the file is replaced immediately after reading', async () => {
    const input = join(root, 'input.json');
    const replacement = join(root, 'replacement.json');
    await writeFile(input, JSON.stringify({ title: 'Raw directive', rq: 'RQ-RAW-1' }));
    await writeFile(replacement, JSON.stringify(native));
    intercepted.path = input; intercepted.replace = replacement;
    await importIntentFiles([input], { root, now: at });
    expect(intercepted.reads).toBe(1);
    expect((await readLedger(root)).items.map((entry) => entry.title)).toEqual(['Raw directive']);
    expect(JSON.parse(await readFile(input, 'utf8'))).toEqual(native);
  });

  it('reads each explicit occurrence once and retains native evidence on repeated import', async () => {
    const input = join(root, 'native.json');
    await writeFile(input, JSON.stringify(native));
    intercepted.path = input;
    expect(await importIntentFiles([input, input], { root, now: at })).toEqual({ imported: 1, deduped: 1, items: 1 });
    expect(intercepted.reads).toBe(2);
    expect((await readLedger(root)).items).toEqual([item]);
  });

  it('leaves destination bytes untouched when a later input is malformed', async () => {
    await writeLedger(native, root);
    const before = await readFile(intentLedgerPath(root), 'utf8');
    const first = join(root, 'first.json');
    const second = join(root, 'second.json');
    await writeFile(first, JSON.stringify({ title: 'New directive' }));
    await writeFile(second, '{invalid');
    await expect(importIntentFiles([first, second], { root, now: at })).rejects.toThrow();
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
  });
});
