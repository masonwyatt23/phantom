/**
 * Preserves the loopback-endpoint slice of original PR #4944
 * (c5ada4286d:test/local-tool-calls.test.ts) against CURRENT provider-client
 * contracts. The old src/core/run/tool-calls.ts adapter is absent on master, so
 * only behaviour the real client supports today is asserted: JSON content
 * fallback (M118), structured-wins, undeclared-name refusal, tool replay wire
 * shape and SSE streaming. Loopback 127.0.0.1 only; no real providers.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import type { ChatMessage } from '../src/core/types.js';

const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'write_file', description: 'Write', parameters: { type: 'object' } } },
];

type Seen = { url: string; body: Record<string, any>; headers: Record<string, unknown> };

function completion(message: Record<string, unknown>) {
  return {
    id: 'mock', object: 'chat.completion', model: 'mock-local',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}
const sse = (chunks: unknown[]) =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

describe('local OpenAI-compatible tool parity (loopback)', () => {
  let server: Server;
  let baseUrl: string;
  const seen: Seen[] = [];
  let replies: unknown[] = [];
  let streamMode = false;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : {}, headers: req.headers });
        const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
        res.setHeader('Content-Type', streamMode ? 'text/event-stream' : 'application/json');
        res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => { seen.length = 0; streamMode = false; });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  const client = (supportsTools = true) => buildOpenAICompatibleClient(baseUrl, '', 'mock-local', supportsTools);

  it('executes an advertised content-embedded call, then a tool result yields the final turn', async () => {
    replies = [
      completion({ role: 'assistant', content: 'Reading.\n{"name":"read_file","arguments":{"path":"/repo/a.ts"}}' }),
      completion({ role: 'assistant', content: 'done — file was empty' }),
    ];
    const c = client();
    const r1 = await c.chat([{ role: 'user', content: 'read it' }], TOOLS);
    expect(r1.toolCalls).toHaveLength(1);
    expect(r1.toolCalls![0]).toMatchObject({ name: 'read_file', arguments: { path: '/repo/a.ts' } });
    expect(r1.content).toBe('Reading.');
    expect(seen[0]!.url).toBe('/v1/chat/completions');
    expect(seen[0]!.body['tools']).toEqual(TOOLS);
    expect(seen[0]!.body['tool_choice']).toBe('auto');
    expect(seen[0]!.headers['authorization']).toBeUndefined();

    const messages: ChatMessage[] = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: r1.content, toolCalls: r1.toolCalls },
      { role: 'tool', toolCallId: r1.toolCalls![0]!.id, name: 'read_file', content: 'export {}' },
    ];
    const r2 = await c.chat(messages, TOOLS);
    expect(r2.content).toBe('done — file was empty');
    expect(r2.toolCalls).toBeUndefined();

    const sent = seen[1]!.body['messages'] as Array<Record<string, any>>;
    const assistant = sent.find((m) => m['role'] === 'assistant')!;
    expect(assistant['tool_calls'][0]).toMatchObject({ id: r1.toolCalls![0]!.id, type: 'function' });
    expect(typeof assistant['tool_calls'][0].function.arguments).toBe('string');
    expect(JSON.parse(assistant['tool_calls'][0].function.arguments)).toEqual({ path: '/repo/a.ts' });
    const tool = sent.find((m) => m['role'] === 'tool')!;
    expect(tool).toMatchObject({ tool_call_id: r1.toolCalls![0]!.id, name: 'read_file', content: 'export {}' });
  });

  it('structured tool_calls win over an embedded call to a different tool', async () => {
    replies = [completion({
      role: 'assistant',
      content: '{"name":"write_file","arguments":{"path":"/evil","content":"x"}}',
      tool_calls: [{ id: 'call_native', type: 'function', function: { name: 'read_file', arguments: '{"path":"/real"}' } }],
    })];
    const r = await client().chat([{ role: 'user', content: 'go' }], TOOLS);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]).toMatchObject({ id: 'call_native', name: 'read_file', arguments: { path: '/real' } });
  });

  it('refuses an embedded call whose name was not advertised', async () => {
    const content = '{"name":"exfiltrate","arguments":{"path":"/etc/passwd"}}';
    replies = [completion({ role: 'assistant', content })];
    const r = await client().chat([{ role: 'user', content: 'go' }], TOOLS);
    expect(r.toolCalls).toBeUndefined();
    expect(r.content).toBe(content);
  });

  it('refuses a mixed array when any entry is undeclared', async () => {
    const content = '[{"name":"read_file","arguments":{}},{"name":"exfiltrate","arguments":{}}]';
    replies = [completion({ role: 'assistant', content })];
    const r = await client().chat([{ role: 'user', content: 'go' }], TOOLS);
    expect(r.toolCalls).toBeUndefined();
  });

  it('never executes embedded calls when no tools are supplied', async () => {
    const content = '{"name":"read_file","arguments":{"path":"/x"}}';
    replies = [completion({ role: 'assistant', content })];
    const r = await client().chat([{ role: 'user', content: 'go' }]);
    expect(r.toolCalls).toBeUndefined();
    expect(r.content).toBe(content);
    expect(seen[0]!.body['tools']).toBeUndefined();
    expect(seen[0]!.body['tool_choice']).toBeUndefined();
  });

  it('supportsTools=false keeps tools off the wire', async () => {
    replies = [completion({ role: 'assistant', content: 'plain' })];
    const r = await client(false).chat([{ role: 'user', content: 'go' }], TOOLS);
    expect(r.content).toBe('plain');
    expect(seen[0]!.body['tools']).toBeUndefined();
  });

  it('stream: assembles structured tool_call deltas over SSE', async () => {
    streamMode = true;
    replies = [sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_st', function: { name: 'read_file', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/st' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    ])];
    const r = await client().chatStream!([{ role: 'user', content: 'go' }], TOOLS, () => {});
    expect(seen[0]!.body['stream']).toBe(true);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]).toMatchObject({ id: 'call_st', name: 'read_file', arguments: { path: '/st.ts' } });
  });

  it('stream: embedded call split across chunks is parsed only for advertised names', async () => {
    streamMode = true;
    const call = '{"name":"read_file","arguments":{"path":"/m.ts"}}';
    const bad = '{"name":"exfiltrate","arguments":{}}';
    const half = (s: string) => [s.slice(0, 20), s.slice(20)];
    replies = [call, bad].map((s) => sse(half(s).map((t) => ({ choices: [{ delta: { content: t } }] }))));
    const ok = await client().chatStream!([{ role: 'user', content: 'go' }], TOOLS, () => {});
    expect(ok.toolCalls).toHaveLength(1);
    expect(ok.toolCalls![0]).toMatchObject({ name: 'read_file', arguments: { path: '/m.ts' } });
    expect(ok.content).toBe('');
    const refused = await client().chatStream!([{ role: 'user', content: 'go' }], TOOLS, () => {});
    expect(refused.toolCalls).toBeUndefined();
    expect(refused.content).toBe(bad);
  });
});
