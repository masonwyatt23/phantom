import { createInterface } from 'node:readline';

const mode = process.argv[2];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const config = (currentValue) => [{ id: 'model', category: 'model', currentValue,
  options: [{ value: mode === 'missing' ? 'other' : 'free-model' }] }];
let promptId;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  const reply = (result) => send({ id: m.id, result });
  if (m.method === 'initialize') {
    if (m.params.protocolVersion !== 1 || m.params.clientCapabilities.fs.readTextFile !== false) process.exit(2);
    reply({ protocolVersion: 1 });
  } else if (m.method === 'session/new') reply({ sessionId: 'seat', configOptions: config('other') });
  else if (m.method === 'session/set_config_option') {
    if (m.params.value !== 'free-model') process.exit(3);
    reply({ configOptions: config(mode === 'ignored' ? 'other' : 'free-model') });
  } else if (m.method === 'session/prompt') {
    promptId = m.id;
    if (mode === 'invalid') { process.stdout.write('not json\n'); return; }
    if (mode === 'overflow') { process.stdout.write('x'.repeat(1024 * 1024 + 1)); return; }
    process.stderr.write('never forward this\n');
    if (mode === 'hang') return;
    if (mode === 'error') { send({ id: m.id, error: { code: -1, message: 'failure' } }); return; }
    if (mode === 'permission' || mode === 'allow' || mode === 'read') {
      send({ id: 100, method: 'session/request_permission', params: { toolCall: { kind: mode === 'read' ? 'read' : 'edit' },
        options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });
    } else if (mode === 'fs') send({ id: 100, method: 'fs/read_text_file', params: {} });
    else {
      for (const text of mode === 'empty' ? [] : ['hello ', 'world']) send({ method: 'session/update', params: {
        sessionId: 'seat', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      reply({ stopReason: 'end_turn' });
    }
  } else if (m.id === 100) {
    const good = mode === 'fs' ? m.error?.code === -32601
      : m.result?.outcome?.optionId === (mode === 'permission' ? 'no' : 'yes');
    send({ id: promptId, ...(good ? { result: { stopReason: 'end_turn' } } : { error: { code: -2 } }) });
  }
});
