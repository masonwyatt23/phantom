import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetScreens } from '../src/cli/fleet-screens.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('renders JSON and text and rejects invalid arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'screens-cli-')); dirs.push(root);
  const dir = join(root, 'leader', 'inbound', 'screens'); mkdirSync(dir, { recursive: true });
  const path = join(dir, '20261110T120000Z-12345678.png');
  writeFileSync(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const lines: string[] = [];
  const deps = { runsDir: root, output: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  expect(await cmdFleetScreens(['--json'], deps)).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ v: 1, state: 'ok', screens: [{ path, bytes: 8 }] });
  expect(await cmdFleetScreens([], deps)).toBe(0);
  expect(lines.pop()).toContain(path);
  expect(await cmdFleetScreens(['--limit', '201'], deps)).toBe(2);
  expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty('screens');
});
