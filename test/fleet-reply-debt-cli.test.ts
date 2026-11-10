import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetReplyDebt } from '../src/cli/fleet-reply-debt.js';

it('reads fake journals and prints JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reply-debt-'));
  const previous = process.env.ASHLR_RUNS_DIR;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    process.env.ASHLR_RUNS_DIR = dir;
    await mkdir(join(dir, 'leader'));
    await writeFile(join(dir, 'leader', 'MASON-INBOX.md'), '2020-01-01T12:00:00.000Z [src:desktop id:desk-1] Hello\n');
    await writeFile(join(dir, 'leader', 'MASON-OUTBOX.md'), '## 2019-01-01 12:00\nEarlier\n');
    expect(await cmdFleetReplyDebt(['--json'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.owed[0]).toMatchObject({ entryId: 'desk-1', preview: 'Hello', matchedBy: 'none' });
    expect(result.sourceStates).toEqual({ inbox: 'healthy', outbox: 'healthy' });
  } finally {
    if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
    log.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
