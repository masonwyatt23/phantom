import { describe, expect, it } from 'vitest';
import { classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';

const path = '/api/verse/agent-bus/needs-mason';
const resolve = `${path}/resolve`;
describe('remote Needs Mason policy', () => {
  it('admits only the exact read and write', () => {
    expect(classifyRemoteRoute('GET', path)).toEqual({ kind: 'read', path });
    expect(classifyRemoteRoute('POST', resolve)).toEqual({ kind: 'write', path: resolve, stepUp: false });
    for (const [method, target] of [['GET', `${path}?x=1`], ['POST', `${resolve}?`], ['GET', resolve], ['POST', path], ['GET', `${path}/other`], ['POST', '/api/verse/agent-bus/other']]) {
      expect(classifyRemoteRoute(method, target)).toEqual({ kind: 'deny' });
    }
  });
  it('validates the exact resolution body', () => {
    const decision = classifyRemoteRoute('POST', resolve);
    expect(validateRemoteMutation(decision, { itemId: 'nm-012345abcdef', reply: ' yes ' })).toBe(true);
    expect(validateRemoteMutation(decision, { itemId: 'nm-012345abcdef' })).toBe(true);
    for (const body of [{ itemId: 'nm-012345abcdeF' }, { itemId: 'nm-012345abcdef\n' }, { itemId: 'nm-012345abcdef', extra: true }, { itemId: 'nm-012345abcdef', reply: 'x'.repeat(501) }, { itemId: 'nm-012345abcdef', reply: 'a\nb' }, { itemId: 'nm-012345abcdef', reply: '  ' }, { itemId: 'nm-012345abcdef', reply: 'a\u007fb' }]) {
      expect(validateRemoteMutation(decision, body)).toBe(false);
    }
  });
});
