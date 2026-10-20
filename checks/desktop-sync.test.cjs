'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ensureCodexProject, registerAgent, syncCodexSessions } = require('../standalone/desktop-sync.cjs');
const { CodexThreadPool } = require('../lib/codex-pool.cjs');
test('desktop-registered Codex project wins over a duplicate backend-only project across pages', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-project-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agent = { id: 'a', label: 'one', workspace: path.join(home, 'workspace') };
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { desktop: { rootPaths: [agent.workspace] } },
    'app-server-project-id-by-legacy-project-id-by-host': { ['local:' + home]: { desktop: 'native' } },
  }));
  const pool = { env: { CODEX_HOME: home }, async request(method, params) {
    assert.equal(method, 'project/list');
    return params.cursor ? { data: [{ id: 'native', roots: [{ path: agent.workspace }] }] }
      : { data: [{ id: 'duplicate', metadata: { agentRoomAgentId: 'a' }, roots: [{ path: agent.workspace }] }], nextCursor: 'next' };
  } };
  assert.equal(await ensureCodexProject(pool, agent), 'native');
});
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
  assert.equal((await registerAgent({ backend: 'qoder' })).status, 'pending');
  assert.equal((await registerAgent({ backend: 'dsh' })).status, 'pending');
});
test('Codex sync repairs catalog sessions in the agent directory and reads back the persisted assignment', async () => {
  const agent = { id: 'a', backend: 'codex', workspace: path.resolve('agent-a') };
  const rows = { owned: { cwd: agent.workspace, projectId: 'backend-only' }, moved: { cwd: path.resolve('another-directory'), projectId: 'elsewhere' } };
  const updated = [];
  const pool = { async request(method, params) {
    if (method === 'thread/read') return { thread: { ...rows[params.threadId] } };
    assert.equal(method, 'thread/metadata/update');
    updated.push(params.threadId); rows[params.threadId].projectId = params.projectId;
    return {};
  } };
  const conversations = Object.keys(rows).map(id => ({ nativeSessions: { a: { id, backend: 'codex' }, other: { id: 'unrelated', backend: 'codex' } } }));
  assert.deepEqual(await syncCodexSessions(pool, agent, 'desktop', conversations), ['moved']);
  assert.deepEqual(updated, ['owned']);
  assert.deepEqual(await syncCodexSessions(pool, agent, 'desktop', conversations), ['moved']);
  assert.deepEqual(updated, ['owned']);
});
