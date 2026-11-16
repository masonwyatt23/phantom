import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetImessageTasks } from '../src/cli/fleet-imessage-tasks.js';
import { cmdFleetTeammateTasks } from '../src/cli/fleet-teammate-tasks.js';
import { defaultConfig } from '../src/core/config.js';
import { enqueueTeammateTask, listTeammateTasks } from '../src/core/comms/imessage-teammate-tasks.js';
import { imessageStateDir } from '../src/core/integrations/imessage.js';

/**
 * RQ-PHX-TEAMTASKCLIUNAVAILABLE472S: a validated `list --job <id> --json` must keep
 * its selection machine-readable when the real ledger read fails, so a coordinating
 * agent can tell unavailable evidence (matched:null) from a missing job (matched:false).
 * Both the imessage-tasks command and the teammate-tasks alias run against a real
 * temp ASHLR_RUNS_DIR; no send config is loaded and no transport is invoked.
 */
let runsDir: string;
let previousRunsDir: string | undefined;
const privateFields = { scope: 'FAKE_PRIVATE_SCOPE_472', format: 'FAKE_PRIVATE_FORMAT_472',
  handle: 'FAKE_PRIVATE_HANDLE_472', path: '/FAKE_PRIVATE_PATH_472' };
const send = vi.fn(() => { throw new Error('No send allowed'); });
const forbidden = (name: string) => vi.fn(() => { throw new Error(`FAKE_PRIVATE_NO_${name}`); });
const ledger = () => join(imessageStateDir(runsDir), 'teammate-tasks.json');
const stateDir = () => imessageStateDir(runsDir);
const UNAVAILABLE = {
  state: 'unavailable', matched: null, tasks: [],
  error: 'Teammate task operation unavailable; check configuration and task state.',
  coverage: 'local-evidence-only-peer-reported-results-unverified',
  claimKeyEvidence: 'label-only-queue-binding-unverified',
};

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'exact-unavailable-472s-'));
  previousRunsDir = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runsDir;
  vi.clearAllMocks();
  for (const [index, jobId] of ['FAKE-472-A', 'FAKE-472-B', 'FAKE-472-B-extra'].entries()) {
    await enqueueTeammateTask({ jobId, peer: index === 1 ? 'instinct' : 'dot', kind: 'research',
      scope: privateFields.scope, repo: 'fixture/example', format: privateFields.format,
      deadline: '2099-01-01T00:00:00Z' },
    defaultConfig(), { runsDir, apply: true, approved: () => privateFields.handle, send });
  }
});
afterEach(() => {
  expect(send).not.toHaveBeenCalled();
  if (previousRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRunsDir;
  rmSync(runsDir, { recursive: true, force: true });
});

const deps = (list: typeof listTeammateTasks = vi.fn(listTeammateTasks)) => ({
  list, config: forbidden('CONFIG'), enqueue: forbidden('ENQUEUE'), cancel: forbidden('CANCEL'),
  dispatch: forbidden('DISPATCH'), peers: forbidden('PEERS'), output: vi.fn(),
});
const diskState = () => readFileSync(ledger(), 'utf8');
const untouched = (d: ReturnType<typeof deps>) => {
  for (const dep of [d.config, d.enqueue, d.cancel, d.dispatch, d.peers]) expect(dep).not.toHaveBeenCalled();
};

describe.each([['imessage-tasks', cmdFleetImessageTasks], ['teammate-tasks', cmdFleetTeammateTasks]] as const)(
  '%s exact selection on ledger failure', (_name, command) => {
    it('keeps a healthy exact match and a healthy miss unchanged', async () => {
      const d = deps();
      const before = diskState();
      expect(await command(['list', '--job', 'FAKE-472-B', '--json'], d)).toBe(0);
      const report = JSON.parse(d.output.mock.calls[0][0]);
      expect(report).toMatchObject({ selection: { jobId: 'FAKE-472-B' }, matched: true, state: 'healthy',
        coverage: 'local-evidence-only-peer-reported-results-unverified',
        claimKeyEvidence: 'label-only-queue-binding-unverified' });
      expect(report.tasks.map((task: { jobId: string }) => task.jobId)).toEqual(['FAKE-472-B']);
      expect(report.tasks[0]).toMatchObject({ peer: 'instinct', state: 'queued' });
      expect(await command(['list', '--job', 'FAKE-472-UNKNOWN', '--json'], d)).toBe(0);
      expect(JSON.parse(d.output.mock.lastCall![0])).toMatchObject({ selection: { jobId: 'FAKE-472-UNKNOWN' },
        matched: false, state: 'healthy', tasks: [] });
      expect(diskState()).toBe(before);
      untouched(d);
      const raw = d.output.mock.calls.flat().join('\n');
      for (const value of ['FAKE_PRIVATE_', runsDir, 'FAKE-472-A"', 'FAKE-472-B-extra']) expect(raw).not.toContain(value);
    });

    it('reports malformed ledger JSON as unavailable evidence for the selected job only', async () => {
      writeFileSync(ledger(), '{invalid');
      const d = deps();
      const before = diskState();
      expect(await command(['list', '--job', 'FAKE-472-A', '--json'], d)).toBe(1);
      const raw = d.output.mock.calls[0][0];
      expect(JSON.parse(raw)).toEqual({ selection: { jobId: 'FAKE-472-A' }, ...UNAVAILABLE });
      expect(raw).not.toContain('FAKE-472-B');
      expect(diskState()).toBe(before);
      expect(d.list).toHaveBeenCalledWith();
      untouched(d);
    });

    it('reports a ledger path replaced by a directory after a successful first read', async () => {
      const d = deps();
      expect(await command(['list', '--job', 'FAKE-472-A', '--json'], d)).toBe(0);
      rmSync(ledger()); mkdirSync(ledger());
      const before = readdirSync(stateDir()).sort();
      expect(await command(['list', '--job', 'FAKE-472-A', '--json'], d)).toBe(1);
      expect(JSON.parse(d.output.mock.lastCall![0])).toEqual({ selection: { jobId: 'FAKE-472-A' }, ...UNAVAILABLE });
      expect(readdirSync(stateDir()).sort()).toEqual(before);
    });

    it('never echoes a throwing reader diagnostic or private paths', async () => {
      const diagnostic = 'FAKE_PRIVATE_DIAGNOSTIC /FAKE/PRIVATE/PATH token FAKE_TOKEN_472';
      const d = deps(() => { throw new Error(diagnostic); });
      expect(await command(['list', '--job', 'FAKE-472-B', '--json'], d)).toBe(1);
      const raw = d.output.mock.calls[0][0];
      expect(JSON.parse(raw)).toEqual({ selection: { jobId: 'FAKE-472-B' }, ...UNAVAILABLE });
      expect(raw).not.toContain('FAKE_PRIVATE'); expect(raw).not.toContain(diagnostic);
    });

    it('keeps non-json and invalid-argument failures on the old contract', async () => {
      writeFileSync(ledger(), '{invalid');
      const d = deps();
      expect(await command(['list', '--job', 'FAKE-472-A'], d)).toBe(1);
      const raw = d.output.mock.lastCall![0];
      expect(raw).toContain('operation unavailable'); expect(raw).not.toContain('selection');
      const calls = vi.mocked(d.list).mock.calls.length;
      for (const args of [['list', '--job', 'bad/job', '--json'], ['list', '--job', 'FAKE-472-A', '--json', '--apply'],
        ['list', '--job', 'FAKE-472-A', '--job', 'FAKE-472-B', '--json']]) {
        expect(await command(args, d)).toBe(2);
      }
      expect(vi.mocked(d.list).mock.calls.length).toBe(calls);
    });
  });
