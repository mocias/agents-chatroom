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
