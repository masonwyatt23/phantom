/**
 * self-update bus notice : an `updated` apply posts exactly one
 * `self-update-applied` envelope onto the shared fleet bus — the same way
 * lane releases are announced. Everything else posts nothing, and a
 * failing notice can never change the apply's outcome or its durable file.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { CHANNEL_BUS_TTL_MS } from '../src/core/fleet/channel-bus-publish.js';
import {
  applySelfUpdate,
  type SelfUpdateApplyDeps,
  type SelfUpdateApplyResult,
  type SelfUpdateRunResult,
  type SelfUpdateRunner,
} from '../src/core/verse/self-update-apply.js';
import {
  buildSelfUpdateEnvelope,
  postSelfUpdateNotice,
  SELF_UPDATE_BUS_KIND,
} from '../src/core/verse/self-update-bus-notice.js';

const FROM = 'a'.repeat(40), TO = 'b'.repeat(40);
const finishedAt = '2026-11-04T03:51:00.000Z';

const applyResult = (over: Partial<SelfUpdateApplyResult> = {}): SelfUpdateApplyResult => ({
  v: 1, startedAt: '2026-11-04T03:49:00.000Z', finishedAt,
  outcome: 'updated', reason: null, fromCommit: FROM, toCommit: TO, steps: [],
  restart: { required: true, mode: 'sidecar-supervised' },
  ...over,
});

describe('buildSelfUpdateEnvelope', () => {
  it('builds a valid deterministic broadcast envelope with bounded text', () => {
    const result = applyResult();
    const envelope = buildSelfUpdateEnvelope(result);
    expect(validateBusEnvelope(envelope).ok).toBe(true);
    expect(envelope).toEqual({
      id: expect.stringMatching(/^fleet-self-update-applied-[0-9a-f]{16}$/),
      from: 'fleet', to: 'all', priority: 'P2', ttl: CHANNEL_BUS_TTL_MS,
      body: {
        kind: SELF_UPDATE_BUS_KIND, at: finishedAt,
        fromCommit: FROM, toCommit: TO,
        restartRequired: true, restartMode: 'sidecar-supervised',
        text: 'Phantom updated aaaaaaa -> bbbbbbb; restart sidecar-supervised',
      },
    });
    expect(buildSelfUpdateEnvelope(result).id).toBe(envelope.id);
    expect(buildSelfUpdateEnvelope(applyResult({ toCommit: 'c'.repeat(40) })).id).not.toBe(envelope.id);
    expect(buildSelfUpdateEnvelope(applyResult({ finishedAt: '2026-11-04T03:52:00.000Z' })).id).not.toBe(envelope.id);
  });

  it('renders missing commits as unknown and keeps step notes out of the body', () => {
    const noisy = applyResult({
      fromCommit: null, toCommit: null,
      steps: [{ name: 'update', ok: true, ms: 1, note: 'stderr leaked token=abc' }],
    });
    const envelope = buildSelfUpdateEnvelope(noisy);
    expect(validateBusEnvelope(envelope).ok).toBe(true);
    expect(envelope.body).toEqual({
      kind: SELF_UPDATE_BUS_KIND, at: finishedAt,
      fromCommit: null, toCommit: null,
      restartRequired: true, restartMode: 'sidecar-supervised',
      text: 'Phantom updated unknown -> unknown; restart sidecar-supervised',
    });
  });
});

describe('postSelfUpdateNotice', () => {
  it.each(['already-current', 'refused', 'failed'] as const)('posts nothing for %s', (outcome) => {
    const post = vi.fn();
    expect(postSelfUpdateNotice(applyResult({ outcome }), post)).toEqual({ status: 'skipped' });
    expect(post).not.toHaveBeenCalled();
  });

  it('reports a throwing post as unavailable', () => {
    expect(postSelfUpdateNotice(applyResult(), () => { throw new Error('offline'); }))
      .toEqual({ status: 'unavailable' });
  });

  it('posts once into the real inbox where a fleet bus reader sees it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'selfupdate-bus-'));
    try {
      const now = () => Date.parse(finishedAt);
      expect(postSelfUpdateNotice(applyResult(), appendBusInbox, { root, now })).toEqual({ status: 'posted' });
      expect(postSelfUpdateNotice(applyResult(), appendBusInbox, { root, now })).toEqual({ status: 'duplicate' });
      const page = listBusInboxAfter(0, 50, { root, now });
      if (page.status !== 'ok') throw new Error(`bus read failed: ${page.status}`);
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0]!.envelope).toEqual(buildSelfUpdateEnvelope(applyResult()));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('applySelfUpdate notify', () => {
  const CLI_ENTRY = '/repo/phantom/dist/cli/index.js';
  const UPDATE_ARGS = `${CLI_ENTRY} update --json`;
  const FF = [
    ['status --porcelain', {}],
    ['fetch origin master', {}],
    ['rev-parse HEAD', { stdout: `${FROM}\n` }],
    ['rev-parse origin/master', { stdout: `${TO}\n` }],
    ['merge-base --is-ancestor HEAD origin/master', {}],
  ] as const;
  const UPDATE_OK: ReadonlyArray<readonly [string, Partial<SelfUpdateRunResult>]> = [
    ...FF, [UPDATE_ARGS, { stdout: JSON.stringify({ updated: true, versionAfter: '9.9.9', commitAfter: TO }) }],
  ];

  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'selfupdate-bus-notify-')); });

  /** Ordered playback like verse-self-update-apply.test.ts: argv arrays, never a shell. */
  function depsFor(script: ReadonlyArray<readonly [string, Partial<SelfUpdateRunResult>]>): SelfUpdateApplyDeps {
    const queue = [...script];
    const runner: SelfUpdateRunner = {
      run: async (cmd, args) => {
        const next = queue.shift();
        return next && args.join(' ') === next[0]
          ? { code: 0, stdout: '', stderr: '', timedOut: false, ...next[1] }
          : { code: 42, stdout: '', stderr: `unscripted call ${cmd} ${args.join(' ')}`, timedOut: false };
      },
    };
    let t = Date.parse('2026-11-04T03:49:00Z');
    return { runner, repoRoot: '/repo/phantom', cliEntry: CLI_ENTRY, resultPath: join(home, 'verse', 'self-update-last.json'), now: () => (t += 100) };
  }

  it('calls notify exactly once with the result on updated', async () => {
    const notify = vi.fn();
    const r = await applySelfUpdate({ ...depsFor(UPDATE_OK), notify });
    expect(r.outcome).toBe('updated');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(r);
  });

  it('never calls notify for refused, already-current or failed outcomes', async () => {
    const dirty = vi.fn(), same = vi.fn(), broken = vi.fn();
    const refused = await applySelfUpdate({ ...depsFor([['status --porcelain', { stdout: ' M src/cli/verse.ts\n' }]]), notify: dirty });
    expect(refused.outcome).toBe('refused');
    const current = await applySelfUpdate({ ...depsFor([...FF.slice(0, 3), ['rev-parse origin/master', { stdout: `${FROM}\n` }]]), notify: same });
    expect(current.outcome).toBe('already-current');
    const failed = await applySelfUpdate({ ...depsFor([...FF, [UPDATE_ARGS, { code: 1, stderr: 'npm exploded' }]]), notify: broken });
    expect(failed.outcome).toBe('failed');
    for (const notify of [dirty, same, broken]) expect(notify).not.toHaveBeenCalled();
  });

  it('a throwing notify leaves the result and the persisted file identical', async () => {
    const quiet = depsFor(UPDATE_OK), loud = depsFor(UPDATE_OK);
    const clean = await applySelfUpdate(quiet);
    const dirty = await applySelfUpdate({ ...loud, notify: () => { throw new Error('bus down'); } });
    expect(dirty).toEqual(clean);
    expect(await readFile(loud.resultPath!, 'utf8')).toBe(await readFile(quiet.resultPath!, 'utf8'));
  });
});
