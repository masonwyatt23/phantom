import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdResource } from '../src/cli/resource.js';

it('returns provider cards with unknown capacity through the resource command', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'provider-cards-'));
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    expect(await cmdResource(['--cards', '--json', '--directory', directory])).toBe(0);
    const cards = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(cards.schema).toBe('provider-cards.v1');
    expect(cards.providers.find((card: { provider: string }) => card.provider === 'xai'))
      .toMatchObject({ status: 'unknown', maxPctUsed: null, nextResetAt: null });
  } finally {
    output.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
