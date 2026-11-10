import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { addIntent, updateIntent } from '../src/core/intent/edit.js';
import { intentLedgerPath, readLedger } from '../src/core/intent/store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });

it('preserves concurrent process adds and additive updates, and releases after refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-race-')); roots.push(root);
  const script = join(root, 'worker.mjs');
  await writeFile(script, `import { addIntent, updateIntent } from ${JSON.stringify(resolve('src/core/intent/edit.ts'))};
process.on('message', async ({kind, index, round}) => {
  try {
    if (kind === 'add') await addIntent({id: 'item-' + index + '-' + round, title: 'Directive ' + index + ' ' + round, source: 'test'}, process.env.TEST_ROOT);
    else await updateIntent('shared', {rq: ['RQ-TEST-' + index]}, process.env.TEST_ROOT);
    process.send({ok: true});
  } catch (error) { process.send({ok: false, message: String(error)}); }
});
process.send({ready: true});`);
  const children: ChildProcess[] = [];
  const receive = (child: ChildProcess) => new Promise<unknown>((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timed out')), 15000);
    const onExit = (code: number | null) => { clearTimeout(timer); reject(new Error(`worker exited ${code}`)); };
    child.once('message', message => { clearTimeout(timer); child.off('exit', onExit); resolveMessage(message); });
    child.once('exit', onExit);
  });
  try {
    for (let i = 0; i < 2; i++) children.push(fork(script, [], { execArgv: ['--import', 'tsx'], env: { ...process.env, HOME: root, TEST_ROOT: root }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
    await Promise.all(children.map(receive));
    for (let round = 0; round < 12; round++) {
      const replies = children.map(receive);
      children.forEach((child, index) => child.send!({ kind: 'add', index, round }));
      expect(await Promise.all(replies)).toEqual([{ ok: true }, { ok: true }]);
    }
    expect((await readLedger(root)).items).toHaveLength(24);
    await addIntent({ id: 'shared', title: 'Shared directive', source: 'test' }, root);
    const replies = children.map(receive);
    children.forEach((child, index) => child.send!({ kind: 'update', index }));
    expect(await Promise.all(replies)).toEqual([{ ok: true }, { ok: true }]);
    expect((await readLedger(root)).items.find(item => item.id === 'shared')?.rq.sort()).toEqual(['RQ-TEST-0', 'RQ-TEST-1']);
    const before = await readFile(intentLedgerPath(root));
    await expect(updateIntent('shared', { title: '' }, root)).rejects.toThrow();
    expect(await readFile(intentLedgerPath(root))).toEqual(before);
    await updateIntent('shared', { evidence: { ref: 'checked' } }, root);
  } finally { children.forEach(child => child.kill()); }
}, 60000);
