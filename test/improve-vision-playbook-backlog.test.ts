import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldVisionPlaybookCells,
  parseVisionPlaybookLine,
  visionPlaybookBacklogItems,
  VISION_PLAYBOOK_DEAD_FLOOR,
  VISION_PLAYBOOK_TAIL_BYTES,
  type VisionPlaybookRow,
} from '../src/core/improve/vision-playbook-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let seq = 0;
const entry = (over: Partial<VisionPlaybookRow> = {}): VisionPlaybookRow => ({
  id: `pb-test-${(seq += 1)}`,
  section: 'strategy',
  text: 'a recorded lesson',
  addedAt: '2026-12-01T00:00:00.000Z',
  hits: 0,
  lastUsedAt: '2026-12-01T00:00:00.000Z',
  retired: false,
  ...over,
});

const line = (r: VisionPlaybookRow): string => JSON.stringify(r);

describe('parseVisionPlaybookLine', () => {
  it('accepts the writer-contract shape and reads retired by reader truthiness', () => {
    const parsed = parseVisionPlaybookLine(line(entry({ section: 'judge', hits: 3, retired: true })));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ id: expect.any(String), section: 'judge', hits: 3, retired: true });
    // isValidEntry accepts any section string; only strategy/judge have readers today.
    expect(parseVisionPlaybookLine(line(entry({ section: 'other' })))!.section).toBe('other');
    // Readers test `!e.retired` — any truthy value retires the row for them.
    expect(parseVisionPlaybookLine(JSON.stringify({ ...entry(), retired: 'yes' }))!.retired).toBe(true);
    expect(parseVisionPlaybookLine(JSON.stringify({ ...entry(), retired: 0 }))!.retired).toBe(false);
    expect(parseVisionPlaybookLine(line(entry()))!.retired).toBe(false);
  });

  it('rejects malformed, non-object and missing-field lines the readers skip', () => {
    expect(parseVisionPlaybookLine('not json')).toBeNull();
    expect(parseVisionPlaybookLine('[1,2]')).toBeNull();
    expect(parseVisionPlaybookLine('null')).toBeNull();
    expect(parseVisionPlaybookLine('   ')).toBeNull();
    expect(parseVisionPlaybookLine(JSON.stringify({ id: 'a' }))).toBeNull();
    expect(parseVisionPlaybookLine(JSON.stringify({ ...entry(), hits: '3' }))).toBeNull();
    expect(parseVisionPlaybookLine(JSON.stringify({ ...entry(), addedAt: 5 }))).toBeNull();
  });
});

describe('foldVisionPlaybookCells', () => {
  const base = { skipped: 0, truncated: false, fileBytes: 1024, acePlaybook: true };

  it('emits judge-starved only when the flag is on, the read is whole, and no active judge row exists', () => {
    const cells = foldVisionPlaybookCells({
      ...base,
      rows: [entry({ section: 'strategy' }), entry({ section: 'strategy' })],
    });
    expect(cells.map((c) => c.key)).toEqual(['judge-starved']);
    expect(cells[0]).toMatchObject({ judgeActive: 0, strategyActive: 2, lowerBound: false });

    // An active judge row ends the starvation — even one retired judge row still starves.
    expect(foldVisionPlaybookCells({
      ...base,
      rows: [entry({ section: 'judge' })],
    })).toEqual([]);
    expect(foldVisionPlaybookCells({
      ...base,
      rows: [entry({ section: 'judge', retired: true })],
    }).map((c) => c.key)).toEqual(['judge-starved']);

    // A truncated tail cannot prove the judge count is globally zero.
    expect(foldVisionPlaybookCells({
      ...base, truncated: true,
      rows: [entry({ section: 'strategy' })],
    })).toEqual([]);

    // Flag off: no rendered channel, so no starvation — the store cell owns the verdict instead.
    expect(foldVisionPlaybookCells({
      ...base, acePlaybook: false,
      rows: [entry({ section: 'strategy' })],
    }).map((c) => c.key)).toEqual(['unread-store']);
  });

  it('emits unread-store whenever the flag is off and any valid row exists, truncated or not', () => {
    const cells = foldVisionPlaybookCells({
      ...base, acePlaybook: false, truncated: true,
      rows: [entry(), entry({ retired: true })],
    });
    expect(cells.map((c) => c.key)).toEqual(['unread-store']);
    expect(cells[0]).toMatchObject({ validRows: 2, lowerBound: true });

    // Flag off but an empty store is the correct state — nothing was ever written.
    expect(foldVisionPlaybookCells({ ...base, acePlaybook: false, rows: [] })).toEqual([]);
    // Only malformed lines: no valid row proves nothing.
    expect(foldVisionPlaybookCells({ ...base, acePlaybook: false, skipped: 3, rows: [] })).toEqual([]);
  });

  it('emits dead-majority only past the floor with retired rows outweighing the live set', () => {
    expect(VISION_PLAYBOOK_DEAD_FLOOR).toBe(100);
    const dead = Array.from({ length: VISION_PLAYBOOK_DEAD_FLOOR }, () => entry({ retired: true }));
    const cells = foldVisionPlaybookCells({
      ...base,
      rows: [...dead, entry({ section: 'strategy' })],
    });
    expect(cells.map((c) => c.key)).toEqual(['judge-starved', 'dead-majority']);
    expect(cells[1]).toMatchObject({ strategyRetired: VISION_PLAYBOOK_DEAD_FLOOR, strategyActive: 1 });

    // Below the floor never emits, however lopsided.
    expect(foldVisionPlaybookCells({
      ...base,
      rows: [...dead.slice(0, VISION_PLAYBOOK_DEAD_FLOOR - 1), entry({ section: 'strategy' })],
    }).map((c) => c.key)).toEqual(['judge-starved']);

    // A live set that still outweighs the audit trail stays quiet.
    expect(foldVisionPlaybookCells({
      ...base, acePlaybook: false,
      rows: [...dead, ...Array.from({ length: VISION_PLAYBOOK_DEAD_FLOOR + 1 }, () => entry({ section: 'judge' }))],
    }).map((c) => c.key)).toEqual(['unread-store']);

    // Other-section rows have no reader — they are dead weight, not live capacity.
    expect(foldVisionPlaybookCells({
      ...base, acePlaybook: false,
      rows: [...dead, ...Array.from({ length: 120 }, () => entry({ section: 'bogus' }))],
    }).map((c) => c.key)).toEqual(['unread-store', 'dead-majority']);

    // A truncated tail cannot prove the ratio.
    expect(foldVisionPlaybookCells({
      ...base, acePlaybook: false, truncated: true,
      rows: [...dead, entry({ section: 'strategy' })],
    }).map((c) => c.key)).toEqual(['unread-store']);
  });

  it('emits oversized only past the byte bound and proves it under any truncation', () => {
    expect(VISION_PLAYBOOK_TAIL_BYTES).toBe(4 * 1024 * 1024);
    const rows = [entry({ section: 'strategy' })];
    expect(foldVisionPlaybookCells({ ...base, rows, fileBytes: VISION_PLAYBOOK_TAIL_BYTES })).toEqual([
      expect.objectContaining({ key: 'judge-starved' }),
    ]);
    const cells = foldVisionPlaybookCells({
      ...base, truncated: true, rows, fileBytes: VISION_PLAYBOOK_TAIL_BYTES + 1,
    });
    expect(cells.map((c) => c.key)).toEqual(['oversized']);
    expect(cells[0]).toMatchObject({ lowerBound: true });
    // An unknown size never claims the bound was crossed.
    expect(foldVisionPlaybookCells({ ...base, rows, fileBytes: null })).toHaveLength(1);
  });
});

describe('visionPlaybookBacklogItems', () => {
  let home: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'vision-playbook-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  const playbookPath = (): string => join(home, '.ashlr', 'vision', 'playbook.jsonl');
  const configPath = (): string => join(home, '.ashlr', 'config.json');

  const enableAce = async (): Promise<void> => {
    await mkdir(join(home, '.ashlr'), { recursive: true });
    await writeFile(configPath(), `${JSON.stringify({ foundry: { acePlaybook: true } })}\n`);
  };

  const writePlaybook = async (rows: readonly (VisionPlaybookRow | string)[]): Promise<void> => {
    await mkdir(join(home, '.ashlr', 'vision'), { recursive: true });
    const lines = rows.map((r) => (typeof r === 'string' ? r : line(r)));
    await writeFile(playbookPath(), `${lines.join('\n')}\n`);
  };

  it('emits judge-starved for a flag-on store with no active judge rows', async () => {
    await enableAce();
    await writePlaybook([
      entry({ section: 'strategy', text: 'Mason vetoed the Leader merge proposal' }),
      entry({ section: 'strategy', text: 'Prefer narrow diffs' }),
      'not json at all',
      JSON.stringify({ id: 'partial' }),
    ]);
    const items = await visionPlaybookBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^vision-playbook-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.title).toContain('judge playbook');
    expect(item.area).toBe('vision-playbook');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe('ashlrai/phantom');
    expect(item.prompt).toContain('playbook.jsonl');
    expect(item.prompt).toContain('judgeProposal');
    expect(item.prompt).toContain('addDelta');
    expect(item.prompt).toContain('vetoPlaybook');
    expect(item.prompt).toContain('acePlaybook');
    expect(item.prompt).toContain('2 valid row(s)');
    expect(item.prompt).toContain('2 malformed line(s) skipped');
    expect(item.prompt).toContain('no-change');
  });

  it('emits unread-store for a flag-off store holding entries, and nothing for a missing journal', async () => {
    // No config at all: flag off, entries present → write-only.
    await writePlaybook([entry({ text: 'Mason vetoed the Leader merge proposal' })]);
    const items = await visionPlaybookBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('write-only');
    expect(items[0]!.prompt).toContain('vetoPlaybook');
    expect(items[0]!.prompt).toContain('1 valid row(s)');

    // Flag off and no journal: the store was never written — clean empty.
    await rm(playbookPath(), { force: true });
    expect(await visionPlaybookBacklogItems({ repo: 'ashlrai/phantom' })).toEqual([]);

    // Flag on and no journal: judge-starved still fires — the rendered
    // channel has no producer whether or not the file exists yet.
    await enableAce();
    const starved = await visionPlaybookBacklogItems({ repo: 'ashlrai/phantom' });
    expect(starved.map((i) => i.id)).toHaveLength(1);
    expect(starved[0]!.prompt).toContain('0 active judge-section');
  });

  it('stays quiet when an active judge row exists under the flag', async () => {
    await enableAce();
    await writePlaybook([
      entry({ section: 'judge', text: 'Prefer correctness over speed' }),
      entry({ section: 'strategy' }),
    ]);
    expect(await visionPlaybookBacklogItems({ repo: 'ashlrai/phantom' })).toEqual([]);
  });

  it('emits dead-majority once retired rows pass the floor and outweigh the live set', async () => {
    await enableAce();
    const rows = [
      ...Array.from({ length: VISION_PLAYBOOK_DEAD_FLOOR }, () => entry({ retired: true })),
      entry({ section: 'strategy' }),
    ];
    await writePlaybook(rows);
    const items = await visionPlaybookBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(2);
    const dead = items.find((i) => i.prompt.includes('mostly dead rows'))!;
    const starved = items.find((i) => i.prompt.includes('no producer'))!;
    expect(dead).toBeDefined();
    expect(starved).toBeDefined();
    expect(dead.prompt).toContain(`${VISION_PLAYBOOK_DEAD_FLOOR} retired`);
    expect(dead.prompt).toContain('audit trail');
    expect(validBacklogItem(dead)).not.toBeNull();
    expect(validBacklogItem(starved)).not.toBeNull();
  });

  it('gates on the fleet repository and flips verdicts with the flag', async () => {
    await enableAce();
    await writePlaybook([entry({ section: 'strategy' })]);
    // Another repository inherits nothing — the playbook carries no repo coordinate.
    expect(await visionPlaybookBacklogItems({ repo: 'ashlrai/other' })).toEqual([]);
    expect(await visionPlaybookBacklogItems({ repo: 'AshlrAI/Phantom' })).toHaveLength(1);

    // Flag off, same file: the starvation verdict clears and the honest
    // write-only verdict takes its place — the cells track recorded state.
    await rm(configPath(), { force: true });
    const off = await visionPlaybookBacklogItems({ repo: 'ashlrai/phantom' });
    expect(off).toHaveLength(1);
    expect(off[0]!.prompt).toContain('write-only');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    await enableAce();
    await writePlaybook([
      entry({ section: 'strategy' }),
      entry({ section: 'judge', retired: true }),
    ]);
    const opts = { repo: 'ashlrai/phantom' };
    const first = await visionPlaybookBacklogItems(opts);
    const second = await visionPlaybookBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first.length).toBeGreaterThan(0);
    expect(await visionPlaybookBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends the vision-playbook items through discovery and dedupes on refresh', async () => {
    await enableAce();
    await writePlaybook([entry({ section: 'strategy', text: 'Mason vetoed the Leader merge proposal' })]);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const playbookItems = first.items.filter((i) => i.id.startsWith('vision-playbook-'));
    expect(playbookItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(playbookItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('vision-playbook-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('vision-playbook-'))).toHaveLength(1);
  });
});
