import { describe, expect, it } from 'vitest';
import { readCommsStatus, sendPolicyLine } from '../src/web-ui/routes/verse/fleet-inbox/comms-status-model.js';

describe('recovered comms send policy', () => {
  it('reports a confirmed policy without exposing identity details', () => {
    const status = readCommsStatus({
      version: 1, generatedAt: '2026-11-09T12:00:00.000Z',
      drafts: null, emailOutbox: null, sources: { drafts: 'healthy', emailOutbox: 'healthy' },
      sendPolicy: { confirmed: true, teamIdentities: 2, channels: ['slack'] },
    });
    expect(status?.sendPolicy).toEqual({ confirmed: true, teamIdentities: 2, channels: ['slack'] });
    expect(sendPolicyLine(status!.sendPolicy!)).toContain('2');
  });
});
