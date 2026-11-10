import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdResource } from '../src/cli/resource.js';

describe('resource provider cards CLI', () => {
  it('reports unknown provider capacity as JSON through the resource command', async () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'recut-cards-'));
    let output = '';
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
    try {
      expect(await cmdResource(['--cards', '--json', '--directory', directory])).toBe(0);
      const result = JSON.parse(output);
      expect(result.schema).toBe('provider-cards.v1');
      expect(result.providers.find((card: { provider: string }) => card.provider === 'xai')).toMatchObject({ status: 'unknown', maxPctUsed: null });
    } finally {
      stdout.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
