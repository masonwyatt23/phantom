import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Supply an extracted owner tree explicitly; this test never imports unmerged code.
const source = process.env.BUILD_INVENTORY_OWNER_SOURCE;

describe('build inventory owner qualification', () => {
  it('restores the mask and confines normalization to declared outputs', () => {
    expect(source, 'Set BUILD_INVENTORY_OWNER_SOURCE to the extracted owner tree').toBeTruthy();
    const scratch = mkdtempSync(join(tmpdir(), 'build-owner-527s-'));
    try {
      // A child isolates process-wide umask from the test runner and other tests.
      const script = String.raw`
        import assert from 'node:assert/strict';
        import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const [source, scratch] = process.argv.slice(1);
        const { runBuild } = await import(pathToFileURL(join(source, 'scripts/build.mjs')).href);
        const root = join(scratch, 'tree');
        const outside = join(scratch, 'outside');
        mkdirSync(join(root, 'dist'), { recursive: true });
        mkdirSync(outside);
        const external = join(outside, 'keep');
        writeFileSync(external, 'untouched');
        chmodSync(external, 0o600);
        symlinkSync(outside, join(root, 'dist', 'link'));
        const original = process.umask(0o077);
        try {
          let calls = 0;
          const result = runBuild([{ command: 'fake' }], (command, options) => {
            assert.equal(command, 'fake');
            assert.equal(options.cwd, root);
            assert.equal(process.umask(), 0o022);
            calls++;
            writeFileSync(join(root, 'dist', 'plain'), 'artifact');
            writeFileSync(join(root, 'dist', 'executable'), 'program');
            chmodSync(join(root, 'dist', 'plain'), 0o600);
            chmodSync(join(root, 'dist', 'executable'), 0o700);
            return { status: 0 };
          }, root);
          assert.equal(result, 0);
          assert.equal(calls, 1);
          assert.equal(process.umask(), 0o077);
          const mode = (path) => lstatSync(path).mode & 0o777;
          assert.equal(mode(join(root, 'dist')), 0o755);
          assert.equal(mode(join(root, 'dist', 'plain')), 0o644);
          assert.equal(mode(join(root, 'dist', 'executable')), 0o755);
          assert.equal(mode(external), 0o600);
          assert.equal(readFileSync(external, 'utf8'), 'untouched');
          assert.equal(lstatSync(join(root, 'dist', 'link')).isSymbolicLink(), true);
          assert.equal(runBuild([{ command: 'fake' }], () => ({ status: 17 }), root), 17);
          assert.equal(process.umask(), 0o077);
          assert.throws(() => runBuild([{ command: 'fake' }], () => { throw new Error('injected'); }, root), /injected/);
          assert.equal(process.umask(), 0o077);
        } finally { process.umask(original); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, resolve(source!), scratch], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
