'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { PollStore, pollText } = require('../lib/polls.cjs');
const { PollBroker } = require('../lib/poll-mcp.cjs');
const { AgentRoom } = require('../lib/room.cjs');
const { createApplication } = require('../standalone/server.cjs');
const members = [{ id: 'a', label: '设计师' }, { id: 'b', label: '审查员' }, { id: 'c', label: '研究员' }];
const create = (visibility = 'anonymous', request_id = 'one') => ({ question: '优先做什么？', options: ['界面', '测试'], visibility, duration_seconds: 600, request_id });
function store(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-polls-'));
  // All deletions target the exact directory returned by mkdtemp.
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let now = 1000;
  const polls = new PollStore(path.join(home, 'polls.json'), { now: () => now });
  return { home, polls, advance: n => { now += n; } };
}
test('anonymous votes stay private across read views, restart, changes, abstention and final tally', t => {
  const { polls, home } = store(t);
  const p = polls.call('room', 'a', 'poll_create', create(), members);
  polls.call('room', 'a', 'poll_vote', { poll_id: p.id, option_id: 'o1' }, members);
  polls.call('room', 'a', 'poll_vote', { poll_id: p.id, option_id: 'o2' }, members);
  const restored = new PollStore(path.join(home, 'polls.json'), { now: () => 1000 });
  assert.equal(restored.call('room', 'a', 'poll_get', { poll_id: p.id }, members).myVote.optionId, 'o2');
  for (const actor of ['user', 'b']) {
    const view = restored.call('room', actor, 'poll_get', { poll_id: p.id }, members);
    assert.equal(view.completed, 1);
    for (const key of ['ballots', 'history', 'attempts', 'participants', 'unavailable']) assert.equal(view[key], undefined);
    assert.ok(view.options.every(o => o.count === undefined));
    assert.ok(!view.myVote);
  }
  restored.call('room', 'b', 'poll_abstain', { poll_id: p.id }, members);
  const final = restored.call('room', 'c', 'poll_vote', { poll_id: p.id, option_id: 'o1' }, members);
  assert.equal(final.status, 'closed'); assert.deepEqual(final.winners, ['o1', 'o2']);
  assert.equal(final.abstained, 1); assert.equal(final.participants, undefined);
  const text = pollText(restored.list('room')[0]);
  assert.doesNotMatch(text, /审查员|研究员|设计师：/);
  assert.match(text, /并列/);
});
test('public voting, immutable definitions, identity restrictions and idempotent retries', t => {
  const { polls } = store(t);
  const p = polls.call('room', 'a', 'poll_create', create('public'), members);
  assert.equal(polls.call('room', 'a', 'poll_create', create('public'), members).id, p.id);
  assert.throws(() => polls.call('room', 'a', 'poll_create', { ...create(), question: 'changed' }, members), /标识/);
  assert.throws(() => polls.call('room', 'b', 'poll_close', { poll_id: p.id }, members), /发起者/);
  assert.throws(() => polls.call('other', 'a', 'poll_get', { poll_id: p.id }, members), /不存在/);
  assert.throws(() => polls.call('room', 'user', 'poll_vote', { poll_id: p.id, option_id: 'o1' }, members), /参与者/);
  assert.throws(() => polls.call('room', 'a', 'poll_vote', { poll_id: p.id, option_id: 'o1', memberId: 'b' }, members), /不允许/);
  const v = polls.call('room', 'a', 'poll_vote', { poll_id: p.id, option_id: 'o1' }, members);
  assert.equal(v.participants[0].optionId, 'o1'); assert.equal(v.options[0].count, 1);
  assert.equal(polls.call('room', 'a', 'poll_vote', { poll_id: p.id, option_id: 'o1' }, members).revision, v.revision);
  polls.call('room', 'user', 'poll_close', { poll_id: p.id }, members);
  assert.equal(polls.call('room', 'a', 'poll_vote', { poll_id: p.id, option_id: 'o1' }, members).status, 'closed');
  assert.throws(() => polls.call('room', 'a', 'poll_vote', { poll_id: p.id, option_id: 'o2' }, members), /结束/);
});
test('expired votes cannot commit, persistence failure does not change memory, deleted members and bounded retry', t => {
  const { polls, advance } = store(t);
  const p = polls.call('room', 'a', 'poll_create', create(), members);
  const original = polls.save;
  polls.save = () => { throw new Error('disk-full'); };
  assert.throws(() => polls.call('room', 'a', 'poll_vote', { poll_id: p.id, option_id: 'o2' }, members), /disk-full/);
  assert.equal(polls.find('room', p.id).ballots.a, undefined);
  polls.save = original;
  assert.equal(polls.claim(p.id, 'a'), true); assert.equal(polls.claim(p.id, 'a'), false);
  advance(30000); assert.equal(polls.claim(p.id, 'a'), true);
  advance(30000); assert.equal(polls.claim(p.id, 'a'), false);
  polls.syncMembers('room', ['a', 'b']); assert.equal(polls.claim(p.id, 'c'), false);
  polls.retry('room', p.id); assert.equal(polls.claim(p.id, 'a'), true);
  polls.pauseRoom('room'); advance(30000);
  assert.equal(polls.claim(p.id, 'b'), false);
  polls.retry('room', p.id); assert.equal(polls.claim(p.id, 'b'), true);
  advance(600000);
  assert.throws(() => polls.call('room', 'b', 'poll_vote', { poll_id: p.id, option_id: 'o1' }, members), /结束/);
  assert.equal(polls.find('room', p.id).closeReason, 'deadline');
});

function stdioClient(config) {
  const child = spawn(config.command, config.args, { env: { ...process.env, ...Object.fromEntries(config.env.map(e => [e.name, e.value])) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let seq = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => { const f = JSON.parse(line); const entry = pending.get(f.id); if (entry) { pending.delete(f.id); clearTimeout(entry.timer); f.error ? entry.reject(new Error(f.error.message)) : entry.resolve(f.result); } });
  return {
    child,
    request(method, params = {}) { return new Promise((resolve, reject) => {
      const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')); }, 10000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }); },
    async close() {
      lines.close(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); } pending.clear();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end(); child.kill(); await exited;
    },
  };
}
test('real stdio MCP handshake, tool discovery, identity binding and token revocation', async t => {
  const { polls } = store(t);
  const broker = new PollBroker(({ roomId, memberId }, name, args) => polls.call(roomId, memberId, name, args, members));
  t.after(() => broker.close());
  const client = stdioClient(await broker.bind('room', 'a')); t.after(() => client.close());
  const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal((await client.request('tools/list')).tools.length, 7);
  const created = await client.request('tools/call', { name: 'poll_create', arguments: create() });
  assert.equal(created.isError, false);
  const id = created.structuredContent.id;
  const voted = await client.request('tools/call', { name: 'poll_vote', arguments: { poll_id: id, option_id: 'o2' } });
  assert.equal(voted.structuredContent.myVote.optionId, 'o2');
  assert.equal(polls.find('room', id).ballots.a.optionId, 'o2');
  broker.revokeRoom('room');
  assert.equal((await client.request('tools/call', { name: 'poll_list', arguments: {} })).isError, true);
});

test('desktop Electron runtime can run the stdio bridge from an asar package without opening a window', async t => {
  const electron = path.resolve(__dirname, '../node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(electron)) return t.skip('Windows Electron binary not installed');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'room-polls-package-'));
  const polls = new PollStore(path.join(home, 'polls.json'));
  const broker = new PollBroker(({ roomId, memberId }, name, args) => polls.call(roomId, memberId, name, args, members));
  let client;
  t.after(async () => {
    await client?.close(); await broker.close();
    // Exact isolated directory returned by mkdtemp; release Electron's archive handle first.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const config = await broker.bind('room', 'a');
  const source = path.join(home, 'package');
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  for (const file of ['poll-mcp-stdio.cjs', 'polls.cjs']) fs.copyFileSync(path.resolve(__dirname, '../lib', file), path.join(source, 'lib', file));
  const archive = path.join(home, 'app.asar');
  await require('@electron/asar').createPackage(source, archive);
  client = stdioClient({ ...config, command: electron, args: [path.join(archive, 'lib/poll-mcp-stdio.cjs')] });
  const init = await client.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.serverInfo.name, 'agent-room-polls');
  assert.equal((await client.request('tools/call', { name: 'poll_list', arguments: {} })).isError, false);
});

test('group scheduler invites creator and busy members, suppresses ballot streams, exports only safe history', async t => {
  const { home } = store(t); const bindings = new Map(), rooms = new Map(), turns = [], streams = [];
  const catalog = { version: 1, agents: members.map(m => ({ ...m, backend: m.id === 'b' ? 'dsh' : 'codex', workspace: path.join(home, 'agents', m.id) })),
    conversations: [{ id: 'group', title: '投票测试', kind: 'group', agentIds: members.map(m => m.id), updatedAt: new Date().toISOString() }] };
  for (const agent of catalog.agents) fs.mkdirSync(agent.workspace, { recursive: true });
  fs.writeFileSync(path.join(home, 'catalog.json'), JSON.stringify(catalog));
  const app = createApplication({ dataDir: home, workspaceRoot: path.join(home, 'agents'), registerAgent: async () => ({}),
    discoveryInventory: async () => ({ rows: [], warning: '' }), prepareNativeSession: async () => ({}), afterNativeTurn: async () => {},
    roomFactory: settings => {
      const room = new AgentRoom(settings); rooms.set(settings.id, room); room.on('stream', e => streams.push(e));
      for (const backend of new Set(settings.members.map(m => m.backend))) {
        const threads = new Map();
        room.pools.set(backend, { running: true, modelCapabilities: async () => new Map(), stop: async () => {},
          getThread: id => threads.get(id), closeThread: id => threads.delete(id),
          openThread: async (id, config) => { bindings.set(id, config.mcpServers[0]); const thread = { id, ...config }; threads.set(id, thread); return thread; },
          runTurn: async (id, input) => {
            if (!input.text.includes('这是平台安排的投票轮次')) return { text: '(无补充)' };
            turns.push(id);
            const config = bindings.get(id), env = Object.fromEntries(config.env.map(e => [e.name, e.value]));
            const call = async (name, args) => (await (await fetch(env.AGENT_ROOM_POLL_URL, { method: 'POST',
              headers: { Authorization: 'Bearer ' + env.AGENT_ROOM_POLL_TOKEN }, body: JSON.stringify({ name, arguments: args }) })).json()).structuredContent;
            const list = await call('poll_list', {});
            await call('poll_vote', { poll_id: list.polls[0].id, option_id: id === 'b' ? 'o2' : 'o1' });
            input.onDelta('SECRET_BALLOT'); input.onItem({ type: 'reasoning', text: 'SECRET_BALLOT' });
            return { text: 'SECRET_BALLOT' };
          },
        });
      }
      return room;
    } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = async (route, body) => {
    const r = await fetch(base + '/api' + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await r.json(); assert.equal(r.ok, true, JSON.stringify(data)); return data;
  };
  await api('/conversation?id=group');
  const room = rooms.get('group'); room.members[1].running = { id: 'busy' };
  // Create through an agent identity, not the human HTTP API.
  const cfg = await room.pollTools(room.members[0]), env = Object.fromEntries(cfg.env.map(e => [e.name, e.value]));
  const response = await fetch(env.AGENT_ROOM_POLL_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + env.AGENT_ROOM_POLL_TOKEN }, body: JSON.stringify({ name: 'poll_create', arguments: create() }) });
  const p = (await response.json()).structuredContent;
  const until = async predicate => { for (let i = 0; i < 80; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout'); };
  await until(() => turns.length === 2);
  await until(async () => (await api('/polls?room=group')).polls[0].completed === 2);
  assert.ok(turns.includes('a')); assert.ok(!turns.includes('b'));
  const before = (await api('/polls?room=group')).polls[0];
  assert.equal(before.completed, 2); assert.equal(before.options[0].count, undefined);
  room.members[1].running = null;
  await until(async () => (await api('/polls?room=group')).polls[0].status === 'closed');
  await until(() => room.log.some(r => r.pollPhase === 'closed'));
  assert.deepEqual(new Set(turns), new Set(['a', 'b', 'c']));
  assert.doesNotMatch(JSON.stringify(streams), /SECRET_BALLOT/);
  assert.doesNotMatch(JSON.stringify(room.snapshot()), /SECRET_BALLOT|myVote|ballots|attempts/);
  const exported = await (await fetch(base + '/api/history/export?room=group&format=json')).text();
  assert.match(exported, /投票测试/); assert.match(exported, /已结束/);
  assert.doesNotMatch(exported, /SECRET_BALLOT|myVote|ballots|attempts/);
  for (const member of members) assert.doesNotMatch(JSON.stringify(await api('/agents/memory?id=' + member.id)), /SECRET_BALLOT|myVote|ballots|attempts/);
  assert.equal(room.log.filter(r => r.pollId === p.id && r.pollPhase === 'closed').length, 1);
  const recovered = new AgentRoom({ members, segmentMs: 0, queueStallMs: 0, logFile: path.join(home, 'rooms/group.log.jsonl') });
  t.after(() => recovered.dispose());
  assert.equal(recovered.log.filter(r => r.pollId === p.id && r.pollPhase === 'closed').length, 1);
  assert.match(recovered._replayLines(recovered.members[0]).join('\n'), /已结束/);
});

test('Codex and ACP receive session MCP settings; preflight failures leave no usable thread', async () => {
  const { CodexThreadPool } = require('../lib/codex-pool.cjs');
  const { AcpPool } = require('../lib/acp-backend.cjs');
  const config = { name: 'agent_room', command: process.execPath, args: ['bridge.cjs'], env: [{ name: 'IDENTITY', value: 'a' }] };
  const codex = new CodexThreadPool({ codexPath: process.execPath, projectName: null });
  const calls = [];
  codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'native-a' }, sandbox: 'read-only' };
    return { isError: false };
  };
  await codex.openThread('a', { mcpServers: [config] });
  const server = calls[0].params.config['mcp_servers.agent_room'];
  assert.equal(calls[0].params.approvalPolicy, 'never');
  assert.equal(server.env.IDENTITY, 'a');
  assert.deepEqual(Object.keys(server.tools).sort(), require('../lib/polls.cjs').toolNames.slice().sort());
  assert.ok(Object.values(server.tools).every(t => t.approval_mode === 'approve'));
  assert.equal(calls[1].params.tool, 'poll_list');
  codex.request = async method => method === 'thread/start' ? { thread: { id: 'failed' } } : Promise.reject(new Error('private details'));
  await assert.rejects(codex.openThread('b', { mcpServers: [config] }), /未就绪/);
  assert.equal(codex.getThread('b'), undefined);
  const acp = new AcpPool({ agentCommand: 'unused' });
  acp.start = async () => {};
  acp.request = async (method, params) => { assert.deepEqual(params.mcpServers, [config]); return { sessionId: 'acp-a' }; };
  await acp.openThread('a', { mcpServers: [config] });
});

test('Claude only permits the seven bound room tools and keeps shell denied', () => {
  const { ClaudeSession } = require('../standalone/claude-acp.cjs');
  const session = new ClaudeSession({}, '', () => {}, () => {}, [{ name: 'agent_room' }]);
  let response;
  session.write = f => { response = f.response.response; };
  session.frame({ type: 'control_request', request_id: '1', request: { subtype: 'can_use_tool', tool_name: 'mcp__agent_room__poll_vote', input: { poll_id: 'p', option_id: 'o1' } } });
  assert.equal(response.behavior, 'allow');
  session.frame({ type: 'control_request', request_id: '2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'whoami' } } });
  assert.equal(response.behavior, 'deny');
  session.mcpServers = [];
  session.frame({ type: 'control_request', request_id: '3', request: { subtype: 'can_use_tool', tool_name: 'mcp__agent_room__poll_vote', input: {} } });
  assert.equal(response.behavior, 'deny');
});

test('WorkBuddy permits room tools only by backend tool identity, never by user-controlled arguments', async () => {
  const { WorkbuddyConnection } = require('../lib/workbuddy-pool.cjs');
  const connection = new WorkbuddyConnection({});
  connection.pollServers = [{ name: 'agent_room' }];
  let response;
  connection.write = frame => { response = frame.result.outcome; };
  const request = toolCall => connection._answerServerRequest({ id: 1, method: 'session/request_permission',
    params: { toolCall, options: [{ kind: 'allow_once', optionId: 'allow' }] } });
  await request({ _meta: { 'codebuddy.ai/toolName': 'mcp__agent_room__poll_vote' } });
  assert.deepEqual(response, { outcome: 'selected', optionId: 'allow' });
  await request({ _meta: { 'codebuddy.ai/toolName': 'Bash' }, title: 'mcp__agent_room__poll_vote',
    rawInput: { tool_name: 'mcp__agent_room__poll_vote' } });
  assert.equal(response.outcome, 'cancelled');
  connection.pollServers = [];
  await request({ _meta: { 'codebuddy.ai/toolName': 'mcp__agent_room__poll_vote' } });
  assert.equal(response.outcome, 'cancelled');
});

test('messages arriving during a ballot stay queued instead of being steered into a hidden reply', async t => {
  const room = new AgentRoom({ members, segmentMs: 0, queueStallMs: 0 });
  t.after(() => room.dispose());
  const m = room.members[0];
  m.running = { id: 'poll-turn', pollId: 'p' };
  room.append({ authorId: 'user', text: '@设计师 请保留这个问题', mentions: ['a'] });
  const before = m.segments.length;
  assert.equal((await room._preempt(m)).queued, true);
  assert.equal(m.segments.length, before);
  assert.match(m.segments[0].lines.join('\n'), /请保留这个问题/);
  m.running = null;
});
