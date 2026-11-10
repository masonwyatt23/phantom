import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listLeaderFiles } from '../src/core/fleet/library-files.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('inbound leader library files', () => {
  it('lists direct bounded files with scrubbed previews and skips links and nested files', async () => {
    root = await mkdtemp(join(tmpdir(), 'library-inbound-'));
    const inbound = join(root, 'leader', 'inbound');
    await mkdir(join(inbound, 'nested'), { recursive: true });
    const secret = 'ghp_' + 'abc123'.repeat(7);
    await writeFile(join(inbound, 'context.md'), `Context\n${secret}`);
    await writeFile(join(inbound, 'large.md'), 'x'.repeat(256 * 1024 + 1));
    await writeFile(join(inbound, 'nested', 'hidden.md'), 'nested');
    await symlink(join(inbound, 'context.md'), join(inbound, 'link.md'));
    const rows = await listLeaderFiles(root);
    expect(rows.map(row => row.name)).toEqual(['inbound/context.md']);
    expect(rows[0].preview).toContain('[REDACTED]');
    expect(rows[0].preview).not.toContain(secret);
  });

  it('skips a symlinked inbound directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'library-inbound-'));
    await mkdir(join(root, 'leader'));
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside', 'context.md'), 'context');
    await symlink(join(root, 'outside'), join(root, 'leader', 'inbound'));
    expect(await listLeaderFiles(root)).toEqual([]);
  });

  it('still lists top-level files and drafts when inbound is absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'library-inbound-'));
    await mkdir(join(root, 'leader', 'drafts'), { recursive: true });
    await writeFile(join(root, 'leader', 'VISION.md'), 'vision');
    await writeFile(join(root, 'leader', 'drafts', 'idea.md'), 'draft');
    expect((await listLeaderFiles(root)).map(row => row.name).sort()).toEqual(['VISION.md', 'drafts/idea.md']);
  });
});
