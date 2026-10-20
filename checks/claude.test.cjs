'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AcpPool } = require('../lib/acp-backend.cjs');
const { claudeCodeLaunch, harnessById } = require('../lib/harnesses.cjs');
const { adapt, BackendDiscovery } = require('../standalone/discovery.cjs');
const { queryModels } = require('../standalone/models.cjs');
const { AgentRoom } = require('../lib/room.cjs');
const { createApplication } = require('../standalone/server.cjs');
const { resolveDesktopCode, desktopEnvironment } = require('../standalone/claude-desktop.cjs');
const fixture = path.join(__dirname, 'fixtures/claude-stream-fixture.cjs');
function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-room-'));
  const launch = claudeCodeLaunch(fixture);
  const pool = new AcpPool({ ...launch, cwd });
  t.after(() => pool.stop());
  return { cwd, launch, pool };
}
test('Claude Code discovery accepts native/npm CLI and rejects Claude desktop as a runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-detect-'));
  const native = path.join(root, 'bin/claude.exe'); fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, '');
  const cli = adapt('claude', native);
  assert.equal(cli.launch.claudeCode, true);
  assert.equal(JSON.parse(cli.launch.agentArgs[1]).binary, native);
  assert.equal(harnessById('claude').short, 'Claude Code');
  const desktop = path.join(root, 'desktop/Claude.exe'); fs.mkdirSync(path.join(root, 'desktop/resources'), { recursive: true });
  fs.writeFileSync(desktop, ''); fs.writeFileSync(path.join(root, 'desktop/resources/app.asar'), '');
  assert.throws(() => adapt('claude', desktop), /桌面应用/);
  const js = path.join(root, 'bin/cli.js'); fs.writeFileSync(js, '');
  const cmd = path.join(root, 'bin/claude.cmd'); fs.writeFileSync(cmd, '@"%_prog%" "%dp0%\\cli.js" %*');
  assert.equal(JSON.parse(adapt('claude', cmd).launch.agentArgs[1]).args[0], js);
  const service = new BackendDiscovery({ dir: root, inventory: async () => ({ rows: [{ name: 'Claude', exe: desktop }] }), roots: { claude: [path.join(root, 'bin')] }, detect: () => [], lookup: () => null });
  assert.equal((await service.scan()).find(row => row.id === 'claude').selected.path, native);
});
test('Claude model query reads actual initialization catalogue and accepts only returned choices', async t => {
  const { cwd, launch } = setup(t);
  const catalogue = await queryModels('claude', launch, cwd, 'opus-test');
  assert.equal(catalogue.selected, 'opus-test');
  assert.deepEqual(catalogue.models.map(model => model.id), ['sonnet-test', 'opus-test', 'rejected-test', 'rate-limited-test']);
  assert.deepEqual(catalogue.models[1].efforts, []);
  await assert.rejects(queryModels('claude', launch, cwd, 'made-up'), /可用|模型/);
  assert.equal((await queryModels('claude', launch, cwd, 'rejected-test')).selected, 'rejected-test');
});
test('Claude bridge streams without duplicates and isolates per-member model, history and workspace', async t => {
  const { cwd, pool } = setup(t);
  const other = path.join(cwd, 'other'); fs.mkdirSync(other);
  await pool.openThread('a', { cwd, model: 'sonnet-test', strictModel: true, developerInstructions: 'PERSONA_FIXTURE' });
  await pool.openThread('b', { cwd: other, model: 'opus-test', strictModel: true });
  const replies = await Promise.all([pool.runTurn('a', { text: 'REMEMBER_A' }), pool.runTurn('b', { text: 'hello' })]);
  const [a, b] = replies.map(reply => JSON.parse(reply.text));
  assert.notEqual(a.sessionId, b.sessionId); assert.equal(a.cwd, cwd); assert.equal(b.cwd, other);
  assert.equal(a.model, 'sonnet-test'); assert.equal(b.model, 'opus-test'); assert.equal(a.hasPersona, true);
  const next = JSON.parse((await pool.runTurn('a', { text: 'continue' })).text);
  assert.equal(next.previousMarker, true); assert.equal(next.turns, 2); assert.equal(next.hasPersona, false);
  assert.equal(JSON.parse((await pool.runTurn('b', { text: 'continue' })).text).previousMarker, false);
});

test('Claude catalogue selection does not send model validation requests that can hit 429', async t => {
  const { cwd, launch, pool } = setup(t);
  const catalog = await queryModels('claude', launch, cwd, 'rate-limited-test');
  assert.equal(catalog.selected, 'rate-limited-test');
  // Discovery is not proof of access: actual session selection must still fail.
  await assert.rejects(pool.openThread('limited', { cwd, model: catalog.selected, strictModel: true }), /429.*Too many pending requests/);
  assert.equal(pool.getThread('limited'), undefined);
});
test('Claude errors are not successful replies, secrets are redacted and tool requests are denied', async t => {
  const { cwd, pool } = setup(t);
  await pool.openThread('a', { cwd, model: 'sonnet-test', strictModel: true });
  await assert.rejects(pool.runTurn('a', { text: 'TEST_API_FAILURE' }), error => /API Error/.test(error.message) && !error.message.includes('PRIVATE_FIXTURE_VALUE'));
  assert.equal((await pool.runTurn('a', { text: 'TEST_PERMISSION' })).text, 'permission_denied');
  assert.equal((await pool.runTurn('a', { text: 'TEST_RESULT_ONLY' })).text, 'fallback reply');
});
test('Claude cancellation completes the active prompt and the session accepts the next turn', async t => {
  const { cwd, pool } = setup(t);
  await pool.openThread('a', { cwd });
  const task = pool.runTurn('a', { text: 'TEST_SLOW' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await pool.interrupt('a'), true);
  assert.equal((await task).status, 'cancelled');
  assert.equal(JSON.parse((await pool.runTurn('a', { text: 'next' })).text).turns, 1);
});
test('Claude joins the current room engine with independent direct and group instructions', async t => {
  const { cwd, launch } = setup(t);
  for (const kind of ['direct', 'group']) {
    const room = new AgentRoom({ id: 'claude-' + kind, kind, cwd, prewarm: false, conversationKind: kind,
      members: [{ id: 'a', backend: 'claude', label: 'Claude teammate', workspace: cwd, model: 'sonnet-test', modelLocked: true, effort: null, persona: 'PERSONA_FIXTURE' }],
      backends: { claude: launch }, replyPolicy: kind === 'direct' ? 'everyone' : 'addressed',
    });
    t.after(() => room.dispose());
    await room.connect();
    await room.say('@Claude teammate hello');
    for (let i = 0; i < 100 && (room.snapshot().busy.length || !room.log.some(row => row.authorId === 'a')); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const reply = room.log.find(row => row.authorId === 'a'); assert.ok(reply, JSON.stringify({ members: room.snapshot().members, log: room.log }));
    const value = JSON.parse(reply.text);
    assert.equal(value.hasPersona, true);
    assert.equal(value.hasGroupRules, kind === 'group');
  }
});

test('Claude process death clears stale sessions and permits a fresh connection', async t => {
  const { cwd, pool } = setup(t);
  const before = await pool.openThread('a', { cwd });
  await assert.rejects(pool.runTurn('a', { text: 'TEST_CRASH' }), /退出|closed|exited|关闭/i);
  for (let i = 0; i < 100 && pool.getThread('a'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pool.getThread('a'), undefined);
  const after = await pool.openThread('a', { cwd });
  assert.notEqual(before.id, after.id);
  assert.equal(JSON.parse((await pool.runTurn('a', { text: 'fresh' })).text).turns, 1);
});

test('Claude contacts use the real HTTP and bridge path and retain latest group controls across restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-http-'));
  const cli = path.join(root, 'cli.cjs'); fs.copyFileSync(fixture, cli);
  let app;
  t.after(async () => { await app?.close(); });
  const boot = async () => {
    app = createApplication({ dataDir: root, workspaceRoot: path.join(root, 'agents') });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    return async (route, body) => {
      const response = await fetch(base + '/api' + route, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    };
  };
  let call = await boot();
  await call('/discovery-consent', { choice: 'manual' });
  await call('/backends', { id: 'claude', path: cli });
  const one = await call('/agents', { label: 'Claude甲', backend: 'claude', model: 'sonnet-test', persona: 'PERSONA_FIXTURE' });
  const two = await call('/agents', { label: 'Claude乙', backend: 'claude', model: 'opus-test' });
  assert.equal(one.agent.desktopSync.status, 'cli-only');
  assert.notEqual(one.agent.workspace, two.agent.workspace);
  assert.equal(one.agent.effort, null); assert.equal(one.agent.modelLocked, true);
  const group = (await call('/groups', { title: 'Claude协议验收', agentIds: [one.agent.id, two.agent.id] })).conversation;
  await call('/conversation/pin', { id: group.id, pinned: true });
  await call('/say', { room: group.id, text: '@所有人 hello' });
  let snapshot;
  for (let i = 0; i < 200; i++) {
    snapshot = (await call('/conversation?id=' + group.id)).snapshot;
    if (!snapshot.busy.length && snapshot.log.filter(row => row.authorId === one.agent.id || row.authorId === two.agent.id).length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  for (const agent of [one.agent, two.agent]) {
    const row = snapshot.log.find(row => row.authorId === agent.id); assert.ok(row, JSON.stringify(snapshot.log));
    const reply = JSON.parse(row.text); assert.equal(reply.model, agent.model);
    assert.equal(reply.cwd, agent.workspace); assert.equal(reply.hasGroupRules, true);
  }
  await app.close(); call = await boot();
  const restored = await call('/catalog');
  assert.equal(restored.conversations.find(row => row.id === group.id).pinned, true);
  assert.equal(restored.agents.find(row => row.id === one.agent.id).model, 'sonnet-test');
  assert.equal((await call('/conversation?id=' + group.id)).snapshot.log.filter(row => row.authorId === one.agent.id || row.authorId === two.agent.id).length, 2);
});

test('Claude desktop API discovery references the selected profile and never serializes credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'));
  const desktop = path.join(root, 'app/Claude.exe'), archive = path.join(root, 'app/resources/app.asar');
  fs.mkdirSync(path.dirname(archive), { recursive: true }); fs.writeFileSync(desktop, '');
  const header = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files: { 'index.pre.js': {} } } } } } }));
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length, 12); fs.writeFileSync(archive, Buffer.concat([prefix, header]));
  const profile = path.join(root, 'profile'), lib = path.join(profile, 'configLibrary'); fs.mkdirSync(lib, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(lib, '_meta.json'), JSON.stringify({ appliedId: id }));
  fs.writeFileSync(path.join(lib, id + '.json'), JSON.stringify({ inferenceGatewayApiKey: 'LOCAL_FAKE_CREDENTIAL' }));
  const binary = path.join(profile, 'claude-code/2.1.299/012345abcdef/claude.exe'); fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, '');
  const launch = resolveDesktopCode(desktop, [profile]);
  assert.equal(launch.binary, binary); assert.equal(launch.desktopDataDir, profile);
  assert.ok(!JSON.stringify(launch).includes('LOCAL_FAKE_CREDENTIAL'));
  fs.writeFileSync(path.join(lib, '_meta.json'), JSON.stringify({ appliedId: '../outside' }));
  assert.throws(() => resolveDesktopCode(desktop, [profile]), /API 配置/);
});

test('Claude desktop Gateway config selects the right auth header without leaking secrets in errors', async t => {
  const { cwd, launch } = setup(t), lib = path.join(cwd, 'configLibrary'); fs.mkdirSync(lib);
  const id = '00000000-0000-4000-8000-000000000001', file = path.join(lib, id + '.json');
  fs.writeFileSync(path.join(lib, '_meta.json'), JSON.stringify({ appliedId: id }));
  const config = { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'http://127.0.0.1:12345', inferenceGatewayAuthScheme: 'bearer', inferenceGatewayApiKey: 'LOCAL_FAKE_CREDENTIAL' };
  const cacheDir = path.join(cwd, 'model-catalog'); fs.mkdirSync(cacheDir);
  const document = { surfaces: { ccd: { model_selector_config: [{ models: [
    { id: 'exact-opus', name: 'Exact Opus', offered_on: ['gateway'] },
    { id: 'vertex-only', offered_on: ['vertex'] },
    { id: 'hidden-model', offered_on: ['gateway'], hidden: true },
  ], provider_alias_targets: { haiku: { default: 'claude-haiku-4-5-20251001' }, sonnet: { default: 'new-sonnet', per_provider: { gateway: 'gateway-sonnet' } } } }] } } };
  fs.writeFileSync(path.join(cacheDir, 'published.json'), JSON.stringify({ documentBytes: Buffer.from(JSON.stringify(document)).toString('base64') }));
  fs.writeFileSync(file, JSON.stringify(config));
  const inherited = { ANTHROPIC_API_KEY: 'OTHER_PROVIDER', CLAUDE_CODE_USE_VERTEX: '1', HTTPS_PROXY: 'http://127.0.0.1:8888' };
  const env = desktopEnvironment(cwd, inherited);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, config.inferenceGatewayApiKey); assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, undefined); assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4-5-20251001'); assert.equal(env.ANTHROPIC_MODEL, 'gateway-sonnet');
  const native = JSON.parse(launch.agentArgs[1]); native.desktopDataDir = cwd; launch.agentArgs[1] = JSON.stringify(native);
  const pool = new AcpPool({ ...launch, cwd }); t.after(() => pool.stop());
  await pool.openThread('gateway', { cwd, model: 'exact-opus', strictModel: true });
  assert.equal(JSON.parse((await pool.runTurn('gateway', { text: 'verify model selection' })).text).model, 'exact-opus');
  assert.ok((await pool.listModels()).some(m => m.id === 'sonnet-test'), 'legacy aliases remain usable');
  assert.ok(!(await pool.listModels()).some(m => ['vertex-only', 'hidden-model'].includes(m.id)));
  assert.equal((await pool.runTurn('gateway', { text: 'TEST_GATEWAY_STATE' })).text, 'gateway_configured');
  await assert.rejects(pool.runTurn('gateway', { text: 'TEST_GATEWAY_LEAK' }), e => e.message.includes('[redacted]') && !e.message.includes(config.inferenceGatewayApiKey));
  fs.writeFileSync(file, JSON.stringify({ ...config, inferenceGatewayAuthScheme: 'x-api-key' }));
  assert.equal(desktopEnvironment(cwd, inherited).ANTHROPIC_API_KEY, config.inferenceGatewayApiKey);
  fs.writeFileSync(file, JSON.stringify({ ...config, inferenceGatewayAuthScheme: 'invalid' }));
  assert.throws(() => desktopEnvironment(cwd), /认证方式/);
});
