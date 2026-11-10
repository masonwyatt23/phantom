import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readFleetSessions } from '../src/core/fleet/runs-sessions.js';

it('projects dispatcher claims without exposing the prompt path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recut-sessions-'));
  try {
    const run = join(root, 'queue', 'run');
    await mkdir(run, { recursive: true });
    await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({ schema: 'dispatchd.status.v1', paused: null, queue_depth: 1 }));
    await writeFile(join(run, 'JOB-1.line'), 'JOB-1\tphantom\tcodex-personal\twork\t/private/prompt.md\n');
    const view = await readFleetSessions({ runsDir: root });
    expect(view.sourceState).toBe('healthy');
    expect(view.sessions).toMatchObject([{ job: 'JOB-1', repo: 'phantom', lane: 'codex-personal', status: 'unknown' }]);
    expect(JSON.stringify(view)).not.toContain('/private/prompt.md');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
