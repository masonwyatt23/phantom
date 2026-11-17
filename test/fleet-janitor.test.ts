import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJanitor } from '../src/cli/fleet-janitor.js';

const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it('runs the hermetic Python janitor regression suite', () => {
  const home = mkdtempSync(join(tmpdir(), 'janitor-home-'));
  homes.push(home);
  const result = execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'test/mac', '-p', 'test_fleet_janitor.py'],
    { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  expect(result).toBe('');
});

it('routes help without accessing the fleet', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await cmdFleetJanitor(['--help'])).toBe(0);
  expect(write.mock.calls.flat().join('')).toContain('--allow');
});

it('rejects unknown options', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await cmdFleetJanitor(['--aply'])).toBe(2);
  expect(write.mock.calls.flat().join('')).toContain('janitor-unavailable');
});
