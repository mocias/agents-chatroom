'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BackendDiscovery, adapt, archiveHas } = require('../standalone/discovery.cjs');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-发现 '));
  const file = (name, text = '') => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  return { root, file };
}
function archive(file) {
  let tree = { size: 1, offset: '0' };
  for (const part of 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'.split('/').reverse()) tree = { files: { [part]: tree } };
  const json = Buffer.from(JSON.stringify(tree));
  const header = Buffer.alloc(16); header.writeUInt32LE(json.length, 12);
  fs.writeFileSync(file, Buffer.concat([header, json]));
}
function manager(root, rows = [], roots = {}) {
  return new BackendDiscovery({ dir: root, inventory: async () => ({ rows, warning: '' }), roots: { codex: [], dsh: [], qoder: [], ...roots }, detect: () => [], lookup: () => null });
}
test('Codex desktop window is excluded while its bundled CLI is discovered', async () => {
  const f = fixture();
  const gui = f.file('app/Codex.exe');
  f.file('app/resources/app.asar');
  const cli = f.file('app/resources/codex.exe');
  assert.throws(() => adapt('codex', gui), /桌面窗口/);
  assert.equal(adapt('codex', path.join(f.root, 'app')).path, cli);
  const row = (await manager(f.root, [{ name: 'Codex', exe: gui }]).scan()).find((r) => r.id === 'codex');
  assert.equal(row.selected.path, cli);
  assert.equal(row.candidates.length, 1);
});
test('custom DSH desktop path is discovered from installation records with verified ASAR entry', async () => {
  const f = fixture();
  const exe = f.file('自定义 安装/DeepSeek Harness.exe');
  const asar = f.file('自定义 安装/resources/app.asar'); archive(asar);
  assert.equal(archiveHas(asar, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), true);
  const row = (await manager(f.root, [{ name: 'DeepSeek Harness', exe, source: '系统安装记录' }]).scan()).find((r) => r.id === 'dsh');
  assert.equal(row.status, 'detected');
  assert.equal(row.selected.launch.agentCommand, exe);
  assert.equal(row.selected.launch.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(row.selected.launch.agentArgs.includes('--profile'));
});
test('desktop presence without ACP does not claim a callable Qoder or DSH', async () => {
  const f = fixture();
  const qoder = f.file('Qoder CN/Qoder CN.exe');
  const dsh = f.file('DSH/DeepSeek Harness.exe');
  const rows = await manager(f.root, [{ name: 'Qoder CN', exe: qoder }, { name: 'DeepSeek Harness', exe: dsh }]).scan();
  for (const id of ['dsh', 'qoder']) { const row = rows.find((r) => r.id === id); assert.equal(row.status, 'installed'); assert.equal(row.found, false); }
});
test('Qoder desktop requires both bundled SDK and worker before advertising ACP', () => {
  const f = fixture();
  const exe = f.file('Qoder CN/Qoder CN.exe');
  assert.throws(() => adapt('qoder', exe));
  const entry = 'node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/index.js';
  let tree = { size: 1, offset: '0' };
  for (const part of entry.split('/').reverse()) tree = { files: { [part]: tree } };
  const data = Buffer.from(JSON.stringify(tree)); const header = Buffer.alloc(16); header.writeUInt32LE(data.length, 12);
  f.file('Qoder CN/resources/app.asar', Buffer.concat([header, data]));
  assert.throws(() => adapt('qoder', exe));
  const worker = f.file('Qoder CN/resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs');
  const candidate = adapt('qoder', exe);
  assert.equal(candidate.kind, '桌面后端');
  assert.equal(candidate.launch.agentCommand, exe);
  assert.equal(candidate.launch.agentArgs[1], worker);
  assert.equal(candidate.launch.env.ELECTRON_RUN_AS_NODE, '1');
});
test('managed Codex versions work without CLI on PATH; refresh notices an upgrade', async () => {
  const f = fixture();
  f.file('releases/0.9/bin/codex.exe');
  const latest = f.file('releases/0.10/bin/codex.exe');
  const service = manager(f.root, [], { codex: [path.join(f.root, 'releases')] });
  assert.equal((await service.scan()).find((r) => r.id === 'codex').selected.path, latest);
  const upgrade = f.file('releases/0.11/bin/codex.exe');
  assert.equal((await service.scan(true)).find((r) => r.id === 'codex').selected.path, upgrade);
});
test('manual settings persist, invalid paths are rejected, missing saved paths do not silently fall back', async () => {
  const f = fixture();
  const a = f.file('first/codex.exe');
  const b = f.file('second/codex.exe');
  const service = manager(f.root, [], { codex: [path.dirname(b)] });
  await service.save('codex', { path: a });
  const restored = manager(f.root, [], { codex: [path.dirname(b)] });
  assert.equal((await restored.scan()).find((r) => r.id === 'codex').selected.path, a);
  await assert.rejects(restored.save('codex', { path: '../relative' }), /绝对路径/);
  await assert.rejects(restored.save('codex', { path: a, args: '--flag' }), /JSON/);
  fs.renameSync(a, a + '.old');
  const invalid = (await restored.scan(true)).find((r) => r.id === 'codex');
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.selected, null);
  assert.equal((await restored.save('codex', null)).find((r) => r.id === 'codex').selected.path, b);
});
test('Codex prefers running desktop backend over newer inactive versions and npm; manual override wins', async () => {
  const f = fixture();
  const npm = f.file('npm/codex.exe');
  const active = f.file('.codex/packages/app-server-daemon/releases/0.9/bin/codex.exe');
  const newer = f.file('.codex/packages/app-server-daemon/releases/0.10/bin/codex.exe');
  const service = new BackendDiscovery({ dir: f.root, inventory: async () => ({ rows: [{ name: 'Codex', exe: active, source: '运行中的进程' }], warning: '' }), roots: { codex: [f.root], dsh: [], qoder: [] }, detect: () => [{ id: 'codex', binary: npm }], lookup: () => null });
  assert.equal((await service.scan()).find(r => r.id === 'codex').selected.path, active);
  service.inventory = async () => ({ rows: [], warning: '' });
  assert.equal((await service.scan(true)).find(r => r.id === 'codex').selected.path, newer);
  assert.equal((await service.save('codex', { path: npm })).find(r => r.id === 'codex').selected.path, npm);
});
test('npm command shims resolve to Node plus JS without shell or argument splitting', () => {
  const f = fixture();
  const js = f.file('工具 目录/node_modules/pkg/cli.js');
  const shim = f.file('工具 目录/qodercli.cmd', '@"%_prog%" "%dp0%\\node_modules\\pkg\\cli.js" %*');
  const found = adapt('qoder', shim);
  assert.deepEqual(found.launch.agentArgs, [js, '--acp']);
  const codexShim = f.file('工具 目录/codex.cmd', '@"%_prog%" "%dp0%\\node_modules\\pkg\\cli.js" %*');
  assert.deepEqual(adapt('codex', codexShim).launch.codexArgs, [js]);
});

test('Codex Node launcher arguments are forwarded before the app-server arguments', async () => {
  const { CodexAppServer } = require('../lib/codex-pool.cjs');
  let captured;
  const pool = new CodexAppServer({ codexPath: process.execPath, codexArgs: ['C:\\custom path\\codex.js'], spawnChild: (binary, args) => { captured = { binary, args }; throw new Error('fixture stop before spawn'); } });
  await assert.rejects(pool.start(), /fixture stop/);
  assert.deepEqual(captured.args, ['C:\\custom path\\codex.js', 'app-server', '--listen', 'stdio://']);
});

test('per-backend proxy settings persist independently and reject invalid or credential-bearing URLs', async () => {
  const f = fixture(), exe = f.file('codex.exe');
  const service = manager(f.root);
  await service.save('codex', { path: exe, proxy: 'http://127.0.0.1:21080' });
  const restored = manager(f.root);
  assert.equal((await restored.scan()).find(r => r.id === 'codex').selected.launch.proxy, 'http://127.0.0.1:21080');
  for (const proxy of ['not a URL', 'file:///C:/proxy', 'http://name:password@127.0.0.1:21080', 'http://127.0.0.1:21080/a']) {
    await assert.rejects(restored.save('codex', { path: exe, proxy }), /代理/);
  }
  assert.equal((await restored.scan()).find(r => r.id === 'codex').selected.launch.proxy, 'http://127.0.0.1:21080');
  const cleared = await restored.save('codex', { path: exe, proxy: '' });
  assert.equal(cleared.find(r => r.id === 'codex').selected.launch.proxy, undefined);
});
