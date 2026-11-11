import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLeaderScreens } from '../src/core/fleet/leader-screens.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('leader screenshots', () => {
  it('lists valid regular files, joins the newest inbox entry and filters by date and limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'screens-')); dirs.push(root);
    const dir = join(root, 'leader', 'inbound', 'screens'); mkdirSync(dir, { recursive: true });
    const older = '20261109T120000Z-12345678.jpg';
    const newer = '20261110T120000Z-abcdef12.png';
    writeFileSync(join(dir, older), Buffer.from([255, 216, 255, 224, 0, 0, 0, 0]));
    writeFileSync(join(dir, newer), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    writeFileSync(join(dir, '.atomic.tmp'), 'fake');
    writeFileSync(join(dir, 'odd.png'), 'fake');
    mkdirSync(join(dir, '20261111T120000Z-abcdef12.png'));
    symlinkSync(join(dir, newer), join(dir, '20261112T120000Z-abcdef12.png'));
    const suffix = ` [image: ${join(dir, newer)}]`;
    writeFileSync(join(root, 'leader', 'MASON-INBOX.md'), `2026-11-10T12:00:00Z [src:desktop id:old] Earlier${suffix}\n2026-11-10T13:00:00Z [src:desktop id:new] The screen is wrong${suffix}\n`);
    const result = listLeaderScreens({ runsDir: root });
    expect(result.state).toBe('ok');
    expect(result.screens.map(s => s.name)).toEqual([newer, older]);
    expect(result.screens[0]).toMatchObject({ takenAt: '2026-11-10T12:00:00.000Z', bytes: 8, ext: 'png', inboxId: 'new', caption: 'The screen is wrong' });
    expect(result.screens[0]!.inboxAt).toBeTruthy();
    expect(result.screens[1]).toMatchObject({ inboxId: null, inboxAt: null, caption: null, ext: 'jpg' });
    expect(listLeaderScreens({ runsDir: root, limit: 1 }).screens).toHaveLength(1);
    expect(listLeaderScreens({ runsDir: root, since: new Date('2026-11-10T00:00:00Z') }).screens.map(s => s.name)).toEqual([newer]);
  });
  it('reports a missing directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'screens-')); dirs.push(root);
    expect(listLeaderScreens({ runsDir: root })).toMatchObject({ v: 1, state: 'absent', screens: [] });
  });
});
