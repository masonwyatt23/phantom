import { describe, expect, it } from 'vitest';
import { leaderFileLabel, narrowLeaderFiles } from './library-leader-files-model.js';

const body = (name: string) => ({
  v: 1, observedAt: '2026-11-09T10:00:00.000Z',
  files: [{ name, size: 1, modifiedAt: '2026-11-09T10:00:00.000Z', preview: 'context' }],
});

describe('inbound leader files', () => {
  it('accepts and labels a direct inbound file', () => {
    expect(narrowLeaderFiles(body('inbound/a.md'))).not.toBeNull();
    expect(leaderFileLabel('inbound/a.md')).toBe('Inbound: a');
  });

  it.each(['inbound/../x', 'other/a.md', 'inbound/a/b.md'])('rejects %s', name => {
    expect(narrowLeaderFiles(body(name))).toBeNull();
  });
});
