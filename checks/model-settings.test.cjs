const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AcpPool } = require('../lib/acp-backend.cjs');
const { AgentRoom } = require('../lib/room.cjs');
test('ACP keeps provider identifiers distinct and does not invent reasoning options', async () => {
  const pool = new AcpPool({ agentCommand: 'unused' });
  pool.learnConfigOptions([{ category: 'model', id: 'model', currentValue: '["a","m"]', options: [
    { value: '["a","m"]', name: 'Same' }, { value: '["b","m"]', name: 'Same' }] }]);
  const caps = await pool.modelCapabilities();
  assert.equal(caps.size, 2);
  assert.deepEqual(caps.get('["a","m"]').efforts, []);
});
test('explicit reasoning overrides CHAT policy and locked models are never replaced', async () => {
  const room = new AgentRoom({ id: 'settings-test', members: [{ id: 'a', backend: 'codex', model: 'missing', modelLocked: true, effort: 'high' }], prewarm: false });
  room.pools.set('codex', { modelCapabilities: async () => new Map([['available', { efforts: ['low'] }]]) });
  await room._refreshCapabilities();
  assert.equal(room.members[0].model, 'missing');
  assert.equal(room.effortFor(room.members[0]), 'high');
});
test('ACP sends the selected persona on the first prompt, retries after failure, and isolates sessions', async () => {
  const pool = new AcpPool({ agentCommand: 'unused' });
  pool.threads.set('a', { id: 'session-a', options: { developerInstructions: '你是设计师甲' } });
  pool.threads.set('b', { id: 'session-b', options: { developerInstructions: '你是审查员乙' } });
  const prompts = []; let fail = true;
  pool.request = async (method, params) => { assert.equal(method, 'session/prompt'); prompts.push(params); if (fail) { fail = false; throw new Error('retry'); } return { stopReason: 'end_turn' }; };
  await assert.rejects(pool.runTurn('a', { text: '你好' }), /retry/);
  await pool.runTurn('a', { text: '你好' });
  await pool.runTurn('a', { text: '继续' });
  await pool.runTurn('b', { text: '你好' });
  assert.match(prompts[0].prompt[0].text, /设计师甲/);
  assert.match(prompts[1].prompt[0].text, /设计师甲/);
  assert.equal(prompts[2].prompt[0].text, '继续');
  assert.match(prompts[3].prompt[0].text, /审查员乙/);
  assert.doesNotMatch(prompts[3].prompt[0].text, /设计师甲/);
});
