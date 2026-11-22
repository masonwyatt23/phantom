import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { listLeaderFiles } from '../src/core/fleet/library-files.js';

const fault = vi.hoisted(() => ({ operation: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (fault.operation === 'open') throw new Error('synthetic open refusal');
    const file = await actual.open(...args);
    if (fault.operation === 'read') vi.spyOn(file, 'read').mockRejectedValue(new Error('synthetic read refusal'));
    if (fault.operation === 'growth') vi.spyOn(file, 'read').mockImplementation(async buffer => {
      buffer.fill(120);
      return { bytesRead: buffer.length, buffer };
    });
    return file;
  } };
});

let root = '';
afterEach(async () => {
  fault.operation = '';
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'webserver764-'));
  const leader = join(root, 'leader');
  await mkdir(leader);
  return leader;
}

it.each(['open', 'read', 'growth'])('retains only file metadata after %s prevents a bounded complete read', async operation => {
  const leader = await fixture();
  await writeFile(join(leader, 'VISION.md'), 'private fixture body');
  fault.operation = operation;
  const rows = await listLeaderFiles(root);
  expect(rows).toEqual([{ name: 'VISION.md', size: 20, modifiedAt: expect.any(String), preview: '', unavailable: true }]);
  expect(JSON.stringify(rows)).not.toContain('private fixture body');
});

it('reads exactly the byte cap, withholds oversized content, and refuses symlinked roots', async () => {
  const leader = await fixture();
  await writeFile(join(leader, 'VISION.md'), 'x'.repeat(256 * 1024));
  await writeFile(join(leader, 'PLAN-LOG.md'), 'private fixture body'.repeat(14_000));
  await mkdir(join(leader, 'INSPIRATION.md'));
  const rows = await listLeaderFiles(root);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.name === 'VISION.md')).toMatchObject({ preview: 'x'.repeat(240) });
  expect(rows.find(row => row.name === 'VISION.md')?.unavailable).toBeUndefined();
  expect(rows.find(row => row.name === 'PLAN-LOG.md')).toMatchObject({ preview: '', unavailable: true });
  const alias = join(root, 'linked-root');
  await symlink(root, alias);
  expect(await listLeaderFiles(alias)).toEqual([]);
});
