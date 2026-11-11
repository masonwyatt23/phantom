import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdDriveApp } from '../src/cli/drive-app.js';

const BEARER = 'a'.repeat(43);

function stubLoopback() {
  const calls: { url: string; headers: Record<string, string>; tool?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes('/api/verse/bootstrap')) {
      calls.push({ url, headers });
      return new Response(JSON.stringify({ seats: [] }), { status: 200 });
    }
    if (url.includes('/api/verse/agent-tools/mcp')) {
      const tool = (JSON.parse(String(init?.body)) as { params?: { name?: string } }).params?.name;
      calls.push({ url, headers, tool });
      const text = tool === 'computer_list_apps' ? '- Claude (test.claude): running'
        : tool === 'computer_ax_tree' ? 'e1 AXTextArea "Message" value=""\ne2 AXButton "Send"' : '';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }));
  return calls;
}

describe('phm drive DESK bearer wiring (recut #3151 via #4749/#5095)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('passes PHM_DRIVE_DESK_BEARER to the DESK fallback when no seat matches', async () => {
    const calls = stubLoopback();
    vi.stubEnv('PHM_DRIVE_READ_TOKEN', 'read');
    vi.stubEnv('PHM_DRIVE_MUTATION_TOKEN', 'write');
    vi.stubEnv('PHM_DRIVE_DESK_BEARER', BEARER);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rc = await cmdDriveApp(['claude', 'start', '--prompt', 'hello', '--json']);
    expect(rc).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('desk-claude:test.claude'));
    expect(calls[0]?.url).toContain('/api/verse/bootstrap');
    expect(calls[0]?.headers['x-ashlr-token']).toBe('read');
    const mcp = calls.filter((c) => c.url.includes('/api/verse/agent-tools/mcp'));
    expect(mcp.every((c) => c.headers['authorization'] === `Bearer ${BEARER}`)).toBe(true);
    expect(mcp.map((c) => c.tool)).toEqual(['computer_list_apps', 'computer_ax_tree', 'computer_ax_press', 'computer_type', 'computer_ax_press']);
  });

  it('fails closed without the bearer and never calls the DESK endpoint', async () => {
    const calls = stubLoopback();
    vi.stubEnv('PHM_DRIVE_READ_TOKEN', 'read');
    vi.stubEnv('PHM_DRIVE_MUTATION_TOKEN', 'write');
    vi.stubEnv('PHM_DRIVE_DESK_BEARER', undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const rc = await cmdDriveApp(['claude', 'start', '--prompt', 'hello', '--json']);
    expect(rc).toBe(1);
    expect(calls.some((c) => c.url.includes('/api/verse/agent-tools/mcp'))).toBe(false);
  });
});
