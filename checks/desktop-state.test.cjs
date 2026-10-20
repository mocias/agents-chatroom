'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectDesktop } = require('../standalone/desktop-state.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('DSH receipt must match directory and cover the latest native sessions', t => {
  const dataDir = fixture(t), workspace = path.join(dataDir, 'agent');
  const agent = { id: 'a', backend: 'dsh', workspace };
  fs.mkdirSync(path.join(dataDir, 'desktop-sync'));
  fs.writeFileSync(path.join(dataDir, 'desktop-sync/dsh.json'), JSON.stringify({ agents: [{ agentId: 'a', workspace, workspaceId: 'w', status: 'registered', sessions: ['one'] }] }));
  const options = { dataDir, conversations: [{ nativeSessions: { a: { backend: 'dsh', id: 'one' } } }] };
  assert.equal(inspectDesktop(agent, options).status, 'registered');
  options.conversations.push({ nativeSessions: { a: { backend: 'dsh', id: 'new' } } });
  assert.equal(inspectDesktop(agent, options).status, 'workspace-registered');
  assert.equal(inspectDesktop({ ...agent, workspace: path.join(dataDir, 'moved') }, options).workspaceRegistered, false);
});
test('Qoder reads the native workspace catalog without changing it or claiming ACP history import', t => {
  const { DatabaseSync } = require('node:sqlite');
  const root = fixture(t), file = path.join(root, 'main.sqlite');
  const workspace = path.join(root, 'agent');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE workspaces (workspace_id TEXT, root_paths_json TEXT, archived INTEGER, deleted_at INTEGER)');
  db.prepare('INSERT INTO workspaces VALUES (?, ?, 0, NULL)').run('w', JSON.stringify([workspace])); db.close();
  const before = fs.readFileSync(file);
  const agent = { backend: 'qoder', workspace };
  const options = { bindings: { qoder: { databaseFile: file } } };
  const result = inspectDesktop(agent, options);
  assert.equal(result.status, 'workspace-registered'); assert.equal(result.workspaceId, 'w');
  assert.match(result.detail, /尚未导入/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(inspectDesktop({ ...agent, workspace: root }, options).status, 'pending');
});
test('WorkBuddy only reports the explicitly bound account snapshot and matching task directory', t => {
  const root = fixture(t), file = path.join(root, 'sidebar-list-snapshot.json'), workspace = path.join(root, 'agent');
  const agent = { backend: 'workbuddy-ai', workspace };
  const options = { bindings: { 'workbuddy-ai': { snapshotFile: file } } };
  const write = items => fs.writeFileSync(file, JSON.stringify({ version: 3, savedAt: Date.now(), items }));
  write([{ id: 't', kind: 'task', space: { type: 'local', name: workspace } }]);
  assert.equal(inspectDesktop(agent, options).status, 'workspace-registered');
  assert.equal(inspectDesktop({ ...agent, backend: 'workbuddy' }, options).status, 'pending');
  write([{ id: 't', kind: 'task', space: { type: 'local', name: root } }]);
  assert.equal(inspectDesktop(agent, options).workspaceRegistered, false);
  write([{ id: 't', kind: 'task', isPinned: true, space: { type: 'local', name: workspace } }]);
  assert.equal(inspectDesktop(agent, options).workspaceRegistered, false);
});
