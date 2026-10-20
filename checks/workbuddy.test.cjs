'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adapt, BackendDiscovery } = require('../standalone/discovery.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
const http = require('node:http');
const { WorkbuddyConnection, readFrames } = require('../lib/workbuddy-pool.cjs');
const { AgentRoom } = require('../lib/room.cjs');

function installation(root, international) {
  const dir = path.join(root, international ? '国际 安装' : '国内 安装');
  const exe = path.join(dir, international ? 'WorkBuddyAI.exe' : 'WorkBuddy.exe');
  const cli = path.join(dir, 'resources/app.asar.unpacked/cli');
  fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(cli, 'bin/codebuddy'), '');
  fs.writeFileSync(path.join(cli, 'product.json'), JSON.stringify({ productName: international ? 'WorkBuddy AI' : 'WorkBuddy',
    authentication: { id: international ? 'workbuddy-desktop-ai' : 'workbuddy-desktop' }, endpoint: international ? 'https://www.workbuddy.ai' : 'https://www.workbuddy.cn' }));
  return exe;
}
test('WorkBuddy editions resolve installed runtimes and reject the other edition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-test-'));
  const cn = installation(root, false), ai = installation(root, true);
  for (const [id, exe, other] of [['workbuddy', cn, ai], ['workbuddy-ai', ai, cn]]) {
    const row = adapt(id, exe);
    assert.equal(row.kind, '桌面后端');
    assert.equal(row.launch.agentCommand, exe);
    assert.deepEqual(row.launch.agentArgs.slice(1), ['--serve', '--acp']);
    assert.equal(row.launch.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(row.launch.env.ACC_PRODUCT_CONFIG_PATH, path.join(path.dirname(exe), 'resources/app.asar.unpacked/cli/product.json'));
    assert.throws(() => adapt(id, other), /版本/);
  }
  const service = new BackendDiscovery({ dir: root, inventory: async () => ({ rows: [{ name: 'WorkBuddy', exe: cn }, { name: 'WorkBuddy AI', exe: ai }] }),
    roots: { codex: [], dsh: [], qoder: [], workbuddy: [], 'workbuddy-ai': [] }, detect: () => [], lookup: () => null });
  const rows = await service.scan();
  const one = rows.find(r => r.id === 'workbuddy'), two = rows.find(r => r.id === 'workbuddy-ai');
  assert.equal(one.selected.path, cn); assert.equal(two.selected.path, ai);
  assert.equal(one.selected.launch.workbuddySupervisor, true);
  assert.equal(two.selected.launch.workbuddySupervisor, true);
  assert.equal(one.selected.launch.env.WORKBUDDY_CONFIG_DIR, undefined);
  assert.equal(two.selected.launch.workbuddyConfigCandidates[0], path.join(os.homedir(), '.workbuddy-ai'));
  assert.equal(fs.existsSync(path.join(root, 'backend-auth')), false, 'discovery must not create credential folders');
});
test('an empty ACP refusal surfaces as an error and does not consume initial instructions', async () => {
  const pool = new AcpPool({ agentCommand: 'unused' });
  pool.threads.set('a', { id: 'session-a', options: { developerInstructions: 'persona' } });
  pool.request = async () => ({ stopReason: 'refusal' });
  await assert.rejects(pool.runTurn('a', { text: 'hello' }), /拒绝|refus/i);
  assert.notEqual(pool.getThread('a').instructionsSent, true);
});

test('ACP refusal surfaces provider details safely, including after a partial reply', async () => {
  const pool = new AcpPool({ agentCommand: 'unused' });
  pool.threads.set('a', { id: 'session-a', options: { developerInstructions: 'persona' } });
  pool.request = async () => {
    pool._dispatch({ method: 'session/update', params: { sessionId: 'session-a', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' },
    } } });
    return { stopReason: 'refusal', _meta: { 'codebuddy.ai/errorMessage': JSON.stringify({
      code: 429, message: 'Too many pending requests token=PRIVATE_FIXTURE_VALUE',
      data: { authorization: 'MUST_NOT_BE_RENDERED' },
    }) } };
  };
  await assert.rejects(pool.runTurn('a', { text: 'hello' }), error =>
    /429.*Too many pending requests/.test(error.message) && !/PRIVATE_FIXTURE_VALUE|MUST_NOT_BE_RENDERED/.test(error.message));
  assert.notEqual(pool.getThread('a').instructionsSent, true);
});
async function desktopFixture(t, { endpoint: badEndpoint, createError } = {}) {
  const calls = [], frames = [], streams = new Set();
  const passwords = new Set(), connections = new Map(); let sessions = 0;
  const server = http.createServer(async (req, res) => {
    assert.ok(passwords.has(req.headers.authorization));
    assert.equal(req.headers['x-codebuddy-request'], '1');
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url.endsWith('/connect')) {
      const connectionId = 'test-connection-' + connections.size;
      connections.set(req.headers.authorization, connectionId);
      return json({ connectionId, sessionToken: 'private-test-session' });
    }
    assert.equal(req.headers['acp-connection-id'], connections.get(req.headers.authorization));
    assert.equal(req.headers['acp-session-token'], 'private-test-session');
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n');
      res.connectionId = req.headers['acp-connection-id'];
      streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    if (req.method === 'DELETE') { for (const stream of streams) stream.end(); return res.end(); }
    let body = ''; for await (const chunk of req) body += chunk;
    const frame = JSON.parse(body); frames.push(frame);
    const reply = result => json({ jsonrpc: '2.0', id: frame.id, result });
    const configOptions = [{ id: 'model', category: 'model', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }] }];
    switch (frame.method) {
      case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: {} });
      case 'session/new': return reply({ sessionId: 'session-' + ++sessions, configOptions });
      case 'session/set_config_option': configOptions[0].currentValue = frame.params.value; return reply({ configOptions });
      case 'session/prompt': {
        const update = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: frame.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好 ' + frame.params.sessionId } } } };
        if (frame.params.prompt.some(p => p.text === 'wait')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return; }
        if (frame.params.sessionId === 'session-1') {
          for (const stream of streams) if (stream.connectionId === req.headers['acp-connection-id']) stream.write('data: ' + JSON.stringify(update) + '\n\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } }) + '\n\n');
          res.writeHead(202); return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify(update) + '\r');
        return setImmediate(() => res.end('\n\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } }) + '\r\n\r\n'));
      }
      default: return reply({});
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pool = new WorkbuddyConnection({ agentCommand: 'WorkBuddyAI.exe', agentArgs: ['cli', '--serve', '--acp'],
    workbuddyConnect: async () => ({ configDir: 'desktop-config', control: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === 'session.create') {
          if (createError) throw new Error('launch failed');
          passwords.add('Bearer ' + params.env.CODEBUDDY_GATEWAY_PASSWORD);
          return { runtimeId: 'own-runtime', pid: 123, acpEndpoint: badEndpoint || 'http://127.0.0.1:' + server.address().port + '/acp' };
        }
        return {};
      }, destroy() {},
    } }),
  });
  t.after(async () => { await pool.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { pool, calls, frames, streams };
}

test('desktop transport reuses bootstrap, applies models, handles both streams and kills only its own runtime', async t => {
  const { pool, calls, frames } = await desktopFixture(t);
  await pool.start();
  const one = await pool.openThread('one', { model: 'fast', strictModel: true });
  const two = await pool.openThread('two', { model: 'fast', strictModel: true });
  assert.notEqual(one.id, two.id);
  const results = await Promise.all(['one', 'two'].map(key => pool.runTurn(key, { text: 'hello' })));
  assert.deepEqual(results.map(r => r.text), ['你好 session-1', '你好 session-2']);
  await pool._answerServerRequest({ id: 'permission', method: 'session/request_permission', params: { options: [{ kind: 'allow_once', optionId: 'yes' }] } });
  for (let i = 0; i < 50 && !frames.some(f => f.id === 'permission'); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(frames.find(f => f.id === 'permission').result.outcome.outcome, 'cancelled');
  assert.equal(frames.some(f => f.method === 'authenticate'), false);
  assert.equal(calls[0].params.env.CODEBUDDY_CONFIG_DIR, 'desktop-config');
  assert.equal(calls[0].params.env.CODEBUDDY_GATEWAY_AUTH, 'password');
  assert.ok(calls[0].params.args.includes('--strict-mcp-config'));
  await pool.stop();
  assert.equal(pool.pid, null); assert.equal(pool.running, false); assert.equal(pool.threads.size, 0);
  assert.deepEqual(calls.map(c => c.method), ['session.create', 'session.kill']);
  assert.deepEqual(calls[1].params, { sessionId: calls[0].params.sessionId, expectedRuntimeId: 'own-runtime' });
});

test('desktop online catalogue replaces static presets and applies exact model IDs', async t => {
  const { pool, frames } = await desktopFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const connect = pool.commandOptions.workbuddyConnect;
  pool.commandOptions.workbuddyConnect = async () => ({ ...await connect(), configDir: root });
  fs.mkdirSync(path.join(root, 'local_storage'));
  const file = path.join(root, 'local_storage', 'wb_entry_d43e96994f944cfb77961c2ea7d04605.info');
  const save = id => fs.writeFileSync(file, JSON.stringify([{ userId: 'test', ts: Date.now(), data: {
    agents: [{ name: 'cli', models: [id] }], models: [{ id, name: 'Online model', supportsToolCall: true }],
  } }]));
  save('concrete-model');
  const thread = await pool.openThread('concrete', { model: 'concrete-model', strictModel: true });
  assert.equal(thread.appliedModel, true);
  assert.ok(frames.some(f => f.method === 'session/set_config_option' && f.params.value === 'concrete-model'));
  assert.deepEqual((await pool.listModels()).map(m => m.id), ['concrete-model']);
  save('updated-model');
  const other = await pool.request('session/new', { cwd: root, mcpServers: [] });
  assert.deepEqual(other.configOptions[0].options.map(o => o.value), ['updated-model']);
  assert.equal(pool.desktopCatalogStatus.source, 'desktop-cache');
  fs.writeFileSync(file, 'bad json');
  const fallback = await pool.request('session/new', { cwd: root, mcpServers: [] });
  assert.deepEqual(fallback.configOptions[0].options.map(o => o.value), ['fast']);
  assert.ok(pool.desktopCatalogStatus.warning);
  save('updated-model');
  const { queryModels } = require('../standalone/models.cjs');
  const query = await queryModels('workbuddy-ai', { ...pool.commandOptions, workbuddySupervisor: true }, root);
  assert.equal(query.selected, 'updated-model');
  assert.ok(frames.some(f => f.method === 'session/set_config_option' && f.params.value === 'updated-model'));
});

test('a failed desktop launch or invalid endpoint still cleans only the requested runtime', async t => {
  for (const options of [{ endpoint: 'https://elsewhere.invalid/acp' }, { createError: true }]) {
    const { pool, calls } = await desktopFixture(t, options);
    await assert.rejects(pool.start());
    assert.equal(pool.running, false);
    assert.equal(calls[1].method, 'session.kill');
    assert.equal(calls[1].params.sessionId, calls[0].params.sessionId);
  }
});

test('a new WorkBuddy room starts without a legacy backend folder and preserves member workspaces', async t => {
  const { pool, calls, frames } = await desktopFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-room-'));
  const members = ['one', 'two'].map(id => {
    const workspace = path.join(root, id); fs.mkdirSync(workspace);
    return { id, backend: 'workbuddy-ai', workspace, model: 'fast', modelLocked: true };
  });
  const room = new AgentRoom({ id: 'workbuddy-real-engine', cwd: root, prewarm: false, members,
    workspaceDirs: { 'workbuddy-ai': path.join(root, 'missing-legacy-directory') },
    backends: { 'workbuddy-ai': { ...pool.commandOptions, workbuddySupervisor: true } },
  });
  t.after(() => room.dispose());
  for (const member of room.members) await room.ensureThread(member);
  const actualPool = room.pools.get('workbuddy-ai');
  const results = await Promise.all(room.members.map(member => actualPool.runTurn(member.id, { text: 'hello' })));
  assert.deepEqual(results.map(r => r.text), ['你好 session-1', '你好 session-2']);
  assert.equal(calls.filter(c => c.method === 'session.create').length, 2);
  assert.deepEqual(calls.filter(c => c.method === 'session.create').map(c => c.params.cwd), members.map(m => m.workspace));
  assert.equal(fs.statSync(calls[0].params.cwd).isDirectory(), true);
  assert.deepEqual(frames.filter(f => f.method === 'session/new').map(f => f.params.cwd), members.map(m => m.workspace));
});

test('desktop disconnect rejects active requests, clears stale sessions and can reconnect', async t => {
  const { pool, streams, calls, frames } = await desktopFixture(t);
  await pool.openThread('one', { model: 'fast', strictModel: true });
  const pending = pool.request('session/prompt', { sessionId: 'session-1', prompt: [{ type: 'text', text: 'wait' }] });
  const rejected = assert.rejects(pending, /关闭|断开/);
  while (!frames.some(f => f.method === 'session/prompt')) await new Promise(r => setTimeout(r, 10));
  for (const stream of streams) stream.end();
  await rejected;
  if (pool.closing) await pool.closing;
  assert.equal(pool.getThread('one'), undefined);
  await pool.start();
  assert.equal(pool.running, true);
  assert.equal(calls.filter(c => c.method === 'session.create').length, 2);
});

test('SSE decoder preserves split UTF-8 and CRLF boundaries', async () => {
  const encoded = new TextEncoder().encode('data: {"text":"你好"}\r\n\r\n');
  const body = new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const frames = [];
  await readFrames(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), frame => frames.push(frame));
  assert.deepEqual(frames, [{ text: '你好' }]);
});
