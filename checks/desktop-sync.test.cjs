'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ensureCodexProject, registerAgent } = require('../standalone/desktop-sync.cjs');
const { CodexThreadPool } = require('../lib/codex-pool.cjs');
test('native projects are reused by Agent identity and workspace, never merely by name', async () => {
  const rows = []; const methods = [];
  const pool = { async request(method, params) {
    methods.push(method);
    if (method === 'project/list') return { data: rows };
    assert.equal(method, 'project/create');
    const project = { id: 'p' + rows.length, ...params }; rows.push(project); return { project };
  } };
  const agent = { id: 'a', label: '同名', workspace: path.resolve('agents/a') };
  const one = await ensureCodexProject(pool, agent);
  assert.equal(await ensureCodexProject(pool, agent), one);
  assert.notEqual(await ensureCodexProject(pool, { ...agent, id: 'b' }), one);
  assert.equal(rows.length, 2);
  assert.ok(!methods.includes('project/delete'));
});
test('native project assignment is forwarded to thread/start', async () => {
  const pool = new CodexThreadPool();
  pool.request = async (method, params) => { assert.equal(method, 'thread/start'); assert.equal(params.projectId, 'project-a'); return { thread: { id: 't' } }; };
  await pool.openThread('a', { projectId: 'project-a' });
  assert.equal((await registerAgent({ backend: 'qoder' })).status, 'unsupported');
  assert.equal((await registerAgent({ backend: 'dsh' })).status, 'unsupported');
});
