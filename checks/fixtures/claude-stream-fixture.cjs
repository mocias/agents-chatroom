'use strict';
// Protocol-only fixture. Never calls a model or reads a user's Claude config.
const assert = require('node:assert/strict');
const readline = require('node:readline');
assert.ok(process.argv.includes('--print'));
assert.equal(process.argv[process.argv.indexOf('--tools') + 1], '');
assert.equal(process.argv[process.argv.indexOf('--permission-mode') + 1], 'default');
assert.deepEqual(JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]), { disableAllHooks: true });
let model = 'sonnet-test', turns = 0, history = '', slow;
const sessionId = process.argv.find(arg => arg.startsWith('--session-id=')).split('=')[1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const answer = (requestId, value, error) => send({ type: 'control_response', response: {
  subtype: error ? 'error' : 'success', request_id: requestId, ...(error ? { error } : { response: value }),
} });
const finish = text => {
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  send({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  send({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 3, output_tokens: 4 } });
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const { subtype } = frame.request;
    if (subtype === 'initialize') return answer(frame.request_id, { models: [
      { value: 'sonnet-test', displayName: 'Sonnet fixture' }, { value: 'opus-test', displayName: 'Opus fixture' },
      { value: 'rejected-test', displayName: 'Rejected fixture' },
      { value: 'rate-limited-test', displayName: 'Rate limited fixture' },
    ] });
    if (subtype === 'set_model') {
      if (frame.request.model === 'rate-limited-test') return answer(frame.request_id, null, 'API error: 429 Too many pending requests, please retry later · model not changed');
      if (frame.request.model === 'rejected-test') return answer(frame.request_id, null, 'model rejected');
      model = frame.request.model; return answer(frame.request_id, {});
    }
    if (subtype === 'interrupt') {
      clearTimeout(slow); answer(frame.request_id, {});
      return send({ type: 'result', subtype: 'success', is_error: false, result: '' });
    }
    return answer(frame.request_id, null, 'unknown control');
  }
  if (frame.type === 'control_response' && frame.response.request_id === 'tool-permission') {
    return finish(frame.response.response.behavior === 'deny' ? 'permission_denied' : 'UNSAFE');
  }
  if (frame.type !== 'user') return;
  assert.equal(frame.client_composed, true);
  const text = frame.message.content.map(block => block.text).join('\n');
  if (text.includes('TEST_GATEWAY_STATE')) return finish(process.env.ANTHROPIC_AUTH_TOKEN === 'LOCAL_FAKE_CREDENTIAL' && !process.env.ANTHROPIC_API_KEY ? 'gateway_configured' : 'incorrect_environment');
  if (text.includes('TEST_GATEWAY_LEAK')) return send({ type: 'result', subtype: 'success', is_error: true, result: 'upstream echoed ' + process.env.ANTHROPIC_AUTH_TOKEN });
  if (text.includes('TEST_API_FAILURE')) return send({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: token=PRIVATE_FIXTURE_VALUE' });
  if (text.includes('TEST_PERMISSION')) return send({ type: 'control_request', request_id: 'tool-permission', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
  if (text.includes('TEST_SLOW')) { slow = setTimeout(() => finish('late reply'), 5000); return; }
  if (text.includes('TEST_CRASH')) return process.exit(3);
  if (text.includes('TEST_RESULT_ONLY')) return send({ type: 'result', subtype: 'success', is_error: false, result: 'fallback reply' });
  if (turns && history.includes('群聊规则')) return finish('(无补充)');
  turns++;
  const result = { sessionId, cwd: process.cwd(), model, turns, previousMarker: history.includes('REMEMBER_A'),
    hasPersona: text.includes('PERSONA_FIXTURE'), hasGroupRules: text.includes('群聊规则'), text: '你好' };
  history += text;
  finish(JSON.stringify(result));
});
lines.on('close', () => { clearTimeout(slow); });
