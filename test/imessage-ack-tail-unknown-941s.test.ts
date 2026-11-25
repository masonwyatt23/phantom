import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readImessageAckEvidence } from '../src/core/comms/imessage-ack-evidence.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ack-test-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'imessage'));
  return { dir, file: join(dir, 'imessage', 'acks.jsonl') };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('reports an oversized unterminated record as unreadable, including a filtered lookup', async () => {
  const { dir, file } = fixture();
  writeFileSync(file, 'x'.repeat(300_000));
  expect(await readImessageAckEvidence(10, dir)).toEqual({ sourceState: 'unreadable', rows: [], malformedRows: 0, deliveryProof: false });
  expect(await readImessageAckEvidence(10, dir, 42)).toEqual({ sourceState: 'unreadable', rows: [], malformedRows: 0, deliveryProof: false, rowid: 42, match: 'unknown' });
});

it('keeps an empty journal healthy and recovers complete rows after a large prefix', async () => {
  const { dir, file } = fixture();
  writeFileSync(file, '');
  expect(await readImessageAckEvidence(10, dir)).toEqual({ sourceState: 'ok', rows: [], malformedRows: 0, deliveryProof: false });
  writeFileSync(file, `${'x'.repeat(300_000)}\n${JSON.stringify({ at: '2026-01-02T03:04:05.000Z', rowid: 42, status: 'accepted' })}\n`);
  expect(await readImessageAckEvidence(10, dir, 42)).toEqual({ sourceState: 'ok', rows: [{ timestamp: '2026-01-02T03:04:05.000Z', rowid: 42, status: 'accepted', delivery: 'unknown' }], malformedRows: 0, deliveryProof: false, rowid: 42, match: 'matched' });
});
