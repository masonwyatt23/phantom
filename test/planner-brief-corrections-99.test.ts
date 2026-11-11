import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlannerBrief, type PlannerBriefGit } from '../src/core/fleet/planner-brief.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git: PlannerBriefGit = (_program, _args, _options, done) => done(null, '');

async function brief(inbox: string) {
  const root = await mkdtemp(join(tmpdir(), 'brief-corrections-99-'));
  roots.push(root);
  await mkdir(join(root, 'leader'), { recursive: true });
  await writeFile(join(root, 'leader/MASON-INBOX.md'), inbox);
  const result = await buildPlannerBrief({ runsRoot: root, git });
  return result.text.slice(result.text.indexOf('## MASON INBOX'));
}

it('marks a corrected channel entry and its id-form correction in place', async () => {
  const original = '2026-11-04T23:05:00.000Z [src:desktop id:desk-0123456789abcdef] Fake order: ship the teal badge';
  const correction = '2026-11-04T23:08:00.000Z [src:desktop id:desk-fedcba9876543210] CORRECTION to desk-0123456789abcdef: fake use the amber badge';
  const section = await brief(`${original}\n${correction}`);
  expect(section).toContain(`${original}\n[CORRECTED by 2026-11-04T23:08:00.000Z, read the correction below]\n${correction}\n[corrects desk-0123456789abcdef]`);
});

it('marks a bare correction against the nearest earlier same-channel entry', async () => {
  const original = '2026-11-04T23:05:00.000Z [src:desktop id:desk-0123456789abcdef] Fake order: ship the teal badge';
  const other = '2026-11-04T23:06:00.000Z [src:telegram id:telegram-0123456789abcd] Fake telegram note';
  const correction = '2026-11-04T23:08:00.000Z [src:desktop id:desk-fedcba9876543210] CORRECTION to the fake note: ship the amber badge';
  const section = await brief(`${original}\n${other}\n${correction}`);
  expect(section).toContain(`${original}\n[CORRECTED by 2026-11-04T23:08:00.000Z, read the correction below]`);
  expect(section).toContain(`${correction}\n[corrects desk-0123456789abcdef]`);
  expect(section).toContain(`${other}\n${correction}`);
});

it('renders an unresolved correction unchanged with no marker', async () => {
  const original = '2026-11-04T23:05:00.000Z [src:desktop id:desk-0123456789abcdef] Fake order: ship the teal badge';
  const orphan = '2026-11-04T23:08:00.000Z [src:desktop id:desk-fedcba9876543210] CORRECTION to desk-aaaaaaaaaaaaaaa1: fake fix';
  const stale = '2026-11-04T23:40:00.000Z [src:desktop id:desk-1111111111111111] CORRECTION: fake too late';
  const section = await brief(`${original}\n${orphan}\n${stale}`);
  expect(section).toContain(`${original}\n${orphan}\n${stale}`);
  expect(section).not.toContain('[CORRECTED by');
  expect(section).not.toContain('[corrects');
});
