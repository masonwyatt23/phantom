import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { callNativeTool, nativeToolSafety } from '../src/core/mcp-native.js';

it('exposes read-only intent tools and rejects invalid requests through the native dispatcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recut-intent-'));
  const previous = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = root;
  try {
    expect(nativeToolSafety('intent_list')).toBe('read');
    expect(nativeToolSafety('intent_get')).toBe('read');
    const result = await callNativeTool('intent_list', {});
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, sourceQuality: 'missing', records: [] });
    expect((await callNativeTool('intent_get', { id: '../invalid' })).isError).toBe(true);
  } finally {
    if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
    else process.env['ASHLR_RUNS_DIR'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
