const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { folderName, chooseWorkspace, assertWorkspace, assertDeletable } = require('../standalone/workspaces.cjs');
const { AgentRoom } = require('../lib/room.cjs');
test('workspace defaults sanitize names and never reuse colliding existing directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspaces-'));
  assert.equal(folderName('CON'), '_CON');
  const a = chooseWorkspace(root, 'dsh', '开发/助手');
  const b = chooseWorkspace(root, 'dsh', '开发:助手');
  assert.equal(a, path.join(root, 'dsh', '开发_助手'));
  assert.equal(b, a + '-2');
  assert.throws(() => chooseWorkspace(root, 'dsh', 'x', '../x'), /绝对路径/);
  assert.throws(() => chooseWorkspace(root, 'dsh', 'x', path.join(root, 'missing')), /不存在/);
  assert.equal(chooseWorkspace(root, 'codex', 'x', a), fs.realpathSync(a));
});
test('different rooms open independent sessions in the same agent workspace; other agents have separate roots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-workspace-'));
  const calls = [];
  for (const id of ['room-one', 'room-two']) {
    const room = new AgentRoom({ id, prewarm: false, members: [{ id: 'a', backend: 'dsh', workspace: root }, { id: 'b', backend: 'dsh', workspace: other }] });
    room.pools.set('dsh', { running: true, getThread: () => null, openThread: async (key, options) => { calls.push({ room: id, key, cwd: options.cwd }); return { id: id + key, ...options }; }, modelCapabilities: async () => new Map() });
    for (const member of room.members) await room.ensureThread(member);
  }
  assert.deepEqual(calls.map(c => c.cwd), [root, other, root, other]);
  assert.notEqual(calls[0].room, calls[2].room);
});
test('workspace removal refuses roots and ancestors of app or other agent directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-delete-'));
  const child = path.join(root, 'child'); fs.mkdirSync(child);
  assert.throws(() => assertDeletable(path.parse(root).root), /根目录/);
  assert.throws(() => assertDeletable(root, { protectedPaths: [child] }), /不能删除/);
  assert.throws(() => assertDeletable(child, { otherWorkspaces: [root] }), /不能删除/);
  assert.equal(assertDeletable(child, { protectedPaths: [root] }), child);
});

test('workspace assignments reject equal/nested/aliased roots even across harnesses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-isolation-'));
  const first = chooseWorkspace(root, 'claude', 'A');
  const child = path.join(first, 'child'); fs.mkdirSync(child);
  const constraints = { otherWorkspaces: [first] };
  for (const target of [first, child, path.dirname(first)]) {
    assert.throws(() => chooseWorkspace(root, 'dsh', 'B', target, constraints), /其他 Agent/);
  }
  const alias = path.join(root, 'alias');
  fs.symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertWorkspace(alias, constraints), /其他 Agent/);
  if (process.platform === 'win32') assert.throws(() => assertWorkspace(first.toUpperCase(), constraints), /其他 Agent/);
  const second = chooseWorkspace(root, 'claude', 'B', '', constraints);
  assert.notEqual(second, first);
  assert.equal(fs.statSync(child).isDirectory(), true);
});

test('protected memory/data directories cannot become another Agent workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-memory-'));
  const memory = path.join(root, 'memory'); fs.mkdirSync(memory);
  const child = path.join(memory, 'agent'); fs.mkdirSync(child);
  const constraints = { protectedPaths: [root], reservedDirs: [memory] };
  for (const target of [root, memory, child]) assert.throws(() => assertWorkspace(target, constraints), /应用\/聊天数据/);
  assert.equal(chooseWorkspace(root, 'claude', 'A', '', constraints), path.join(root, 'claude', 'A'));
});
