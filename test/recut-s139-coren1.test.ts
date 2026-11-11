import { describe, expect, it } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

describe('recut intent evidence tools', () => {
  it('advertises both append tools and rejects invalid evidence before execution', async () => {
    for (const name of ['intent_link', 'intent_ship']) {
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({
        type: 'object', additionalProperties: false,
      });
      expect(nativeToolSafety(name)).toBe('append');
      expect((await callNativeTool(name, { unexpected: true })).isError).toBe(true);
    }
  });
});
