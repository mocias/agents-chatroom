'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApplication } = require('../standalone/server.cjs');
const { AgentRoom } = require('../lib/room.cjs');

function fakeFactory(captured) {
  return (settings) => {
    const room = new AgentRoom(settings);
    for (const backend of new Set(settings.members.map((m) => m.backend))) {
      const threads = new Map();
      const pool = { running: false, pid: null, supportsInject: false,
        async start() { this.running = true; }, async stop() { this.running = false; },
        async modelCapabilities() { return new Map(); },
        getThread(id) { return threads.get(id); },
        async openThread(id, config) { const thread = { id, ...config }; threads.set(id, thread); return thread; },
        closeThread(id) { threads.delete(id); },
        async runTurn(id, input) { captured.push({ id, input, room: settings.id, backend }); input.onDelta('测试回复'); return { text: '测试回复', usage: {} }; },
        async interrupt() { return true; },
      };
      room.pools.set(backend, pool);
    }
    return room;
  };
}
async function start(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-test-'));
  const app = createApplication({ dataDir, workspaceRoot: path.join(dataDir, 'agents'), registerAgent: async () => ({ status: 'registered' }), prepareNativeSession: async () => ({}), afterNativeTurn: async () => {}, discoveryInventory: async () => ({ rows: [], warning: '' }), ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (route, body) => {
    const response = await fetch(url + '/api' + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => { await app.close(); });
  return { app, call, url, dataDir };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Timed out');
}
test('both WorkBuddy editions can share a group with independent backend and workspace routing', async t => {
  const captured = [];
  const env = await start(t, { roomFactory: fakeFactory(captured), queryModels: async id => ({ selected: id + '-model', models: [{ id: id + '-model', name: id, efforts: [] }] }) });
  const cnResult = await env.call('/agents', { label: '国内伙伴', backend: 'workbuddy', model: 'workbuddy-model' });
  const aiResult = await env.call('/agents', { label: '国际伙伴', backend: 'workbuddy-ai', model: 'workbuddy-ai-model' });
  assert.equal(cnResult.status, 201); assert.equal(aiResult.status, 201);
  const cn = cnResult.data.agent, ai = aiResult.data.agent;
  assert.notEqual(cn.workspace, ai.workspace);
  assert.equal(cn.modelLocked, true); assert.equal(ai.modelLocked, true);
  const group = (await env.call('/groups', { agentIds: [cn.id, ai.id] })).data.conversation;
  assert.equal((await env.call('/say', { room: group.id, text: '@所有人 你好' })).status, 202);
  await until(() => captured.length === 2);
  assert.deepEqual(new Set(captured.map(c => c.backend)), new Set(['workbuddy', 'workbuddy-ai']));
  assert.equal((await env.call('/backend-login', { id: 'codex' })).status, 400);
});
test('deleting an Agent requires an explicit workspace choice, keeps group history and protects shared folders', async t => {
  const env = await start(t, { roomFactory: fakeFactory([]) });
  const a = (await env.call('/agents', { label: '删除测试', backend: 'dsh' })).data.agent;
  const b = (await env.call('/agents', { label: '保留测试', backend: 'dsh', workspace: a.workspace })).data.agent;
  const group = (await env.call('/groups', { agentIds: [a.id, b.id] })).data.conversation;
  fs.writeFileSync(path.join(a.workspace, 'keep.txt'), 'keep');
  assert.equal((await env.call('/agents/delete', { id: a.id })).status, 400);
  assert.equal((await env.call('/agents/delete', { id: a.id, deleteWorkspace: true, confirmWorkspace: a.workspace })).status, 400);
  assert.equal((await env.call('/agents/delete', { id: a.id, deleteWorkspace: false })).status, 200);
  assert.equal(fs.readFileSync(path.join(a.workspace, 'keep.txt'), 'utf8'), 'keep');
  const catalog = (await env.call('/catalog')).data;
  assert.deepEqual(catalog.conversations.find(c => c.id === group.id).agentIds, [b.id]);
  assert.equal((await env.call('/agents/delete', { id: b.id, deleteWorkspace: true, confirmWorkspace: b.workspace })).status, 200);
  assert.equal(fs.existsSync(b.workspace), false);
  assert.equal((await env.call('/conversation?id=' + group.id)).status, 200);
  assert.equal((await env.call('/say', { room: group.id, text: 'hi' })).status, 400);
});
test('no discovery runs before consent or in manual mode; consent persists across restart', async t => {
  let scans = 0;
  const inventory = async () => { scans++; return { rows: [], warning: '' }; };
  const env = await start(t, { discoveryInventory: inventory });
  assert.equal((await env.call('/catalog')).data.discoveryChoice, null);
  await env.call('/backends?refresh=1');
  assert.equal(scans, 0);
  await env.call('/discovery-consent', { choice: 'manual' });
  await env.call('/backends?refresh=1');
  assert.equal(scans, 0);
  assert.equal((await env.call('/backends', { id: 'codex', path: env.dataDir })).status, 400);
  await env.app.close();
  const restored = await start(t, { dataDir: env.dataDir, discoveryInventory: inventory });
  assert.equal((await restored.call('/catalog')).data.discoveryChoice, 'manual');
  assert.equal(scans, 0);
  await restored.call('/discovery-consent', { choice: 'automatic' });
  await restored.call('/backends');
  assert.equal(scans, 1);
});
test('fixed model validation and per-conversation reasoning survive restart without leaking across groups', async t => {
  const queryModels = async () => ({ selected: 'fixed', models: [{ id: 'fixed', name: 'Fixed', efforts: ['low', 'high'], defaultEffort: 'low' }] });
  const env = await start(t, { queryModels, roomFactory: fakeFactory([]) });
  assert.equal((await env.call('/agents', { label: '错误模型', backend: 'codex', model: 'unknown' })).status, 400);
  const a = (await env.call('/agents', { label: '固定助手', backend: 'codex', model: 'fixed' })).data.agent;
  const b = (await env.call('/agents', { label: 'DSH助手', backend: 'dsh', model: 'fixed' })).data.agent;
  assert.equal(a.modelLocked, true);
  assert.equal(a.workspace, path.join(env.dataDir, 'agents', 'codex', '固定助手'));
  assert.equal(fs.statSync(a.workspace).isDirectory(), true);
  const group = (await env.call('/groups', { agentIds: [a.id, b.id] })).data.conversation;
  const group2 = (await env.call('/groups', { agentIds: [a.id, b.id] })).data.conversation;
  assert.equal((await env.call('/member-effort', { room: group.id, agent: a.id, effort: 'high', model: 'other' })).status, 400);
  assert.equal((await env.call('/member-effort', { room: group.id, agent: a.id, effort: 'ultra' })).status, 400);
  assert.equal((await env.call('/member-effort', { room: group.id, agent: a.id, effort: 'high' })).status, 200);
  await env.app.close();
  const restored = await start(t, { dataDir: env.dataDir, queryModels, roomFactory: fakeFactory([]) });
  const catalog = (await restored.call('/catalog')).data;
  assert.equal(catalog.conversations.find(r => r.id === group.id).efforts[a.id], 'high');
  assert.equal(catalog.conversations.find(r => r.id === group2.id).efforts, undefined);
  assert.equal(catalog.agents.find(r => r.id === a.id).model, 'fixed');
  assert.equal(catalog.agents.find(r => r.id === a.id).workspace, a.workspace);
});
test('contacts and groups persist; browsing never starts a harness; invalid groups and WORK are rejected', async (t) => {
  let starts = 0;
  const env = await start(t, { roomFactory: (settings) => { starts++; return new AgentRoom(settings); } });
  const a = (await env.call('/agents', { label: '设计师', backend: 'codex' })).data;
  const b = (await env.call('/agents', { label: '研究员', backend: 'dsh' })).data;
  assert.equal(starts, 0);
  assert.equal((await env.call('/agents', { label: '设计师', backend: 'qoder' })).status, 400);
  assert.equal((await env.call('/groups', { agentIds: [a.agent.id, a.agent.id] })).status, 400);
  assert.equal((await env.call('/groups', { agentIds: [a.agent.id, 'missing'] })).status, 400);
  const group = (await env.call('/groups', { title: '讨论组', agentIds: [a.agent.id, b.agent.id] })).data.conversation;
  const view = (await env.call('/conversation?id=' + group.id)).data;
  assert.equal(view.snapshot.mode, 'chat');
  assert.equal(view.snapshot.connected, false);
  assert.equal(view.snapshot.members.length, 2);
  assert.equal((await env.call('/mode', { mode: 'work' })).status, 404);
  assert.equal((await env.call('/conversation?id=../../outside')).status, 404);
  await env.app.close();
  const restored = await start(t, { dataDir: env.dataDir });
  const catalog = (await restored.call('/catalog')).data;
  assert.equal(catalog.agents.length, 2);
  assert.equal(catalog.conversations.length, 3);
  assert.equal(catalog.conversations.find((c) => c.id === group.id).title, '讨论组');
});
test('real engine sends attachment paths with CHAT policy, isolates sessions and restores history', async (t) => {
  const captured = [];
  const env = await start(t, { roomFactory: fakeFactory(captured) });
  const a = (await env.call('/agents', { label: 'Ada', backend: 'codex' })).data;
  const b = (await env.call('/agents', { label: 'Bob', backend: 'qoder' })).data;
  const upload = await fetch(env.url + '/api/attach?name=notes.txt&type=text/plain', { method: 'POST', body: 'reference content' });
  assert.equal(upload.status, 200);
  const file = (await upload.json()).attachment;
  assert.equal(file.path, undefined);
  assert.equal((await env.call('/say', { room: a.conversation.id, attachments: ['not-real'] })).status, 400);
  assert.equal((await env.call('/say', { room: a.conversation.id, text: 'read this', attachments: [file.id] })).status, 202);
  await until(() => captured.length > 0);
  assert.equal(captured[0].input.sandboxPolicy.type, 'readOnly');
  assert.equal(fs.readFileSync(captured[0].input.attachments[0].path, 'utf8'), 'reference content');
  const untouched = (await env.call('/conversation?id=' + b.conversation.id)).data.snapshot;
  assert.equal(untouched.log.length, 0);
  await until(async () => !(await env.call('/conversation?id=' + a.conversation.id)).data.pending);
  await env.app.close();
  const restored = await start(t, { dataDir: env.dataDir, roomFactory: fakeFactory(captured) });
  const snapshot = (await restored.call('/conversation?id=' + a.conversation.id)).data.snapshot;
  assert.equal(snapshot.log.filter((r) => r.kind === 'user').length, 1);
  assert.equal(snapshot.log.find((r) => r.kind === 'agent').text, '测试回复');
  assert.equal(snapshot.log[0].attachments[0].path, undefined);
  const download = await fetch(restored.url + '/api/attachment/' + file.id);
  assert.equal(await download.text(), 'reference content');
});
test('appearance persists, backgrounds serve correctly, active content and cross-site requests are restricted', async (t) => {
  const env = await start(t);
  await env.call('/theme', { preset: 'forest' });
  const before = (await env.call('/theme')).data.theme;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9uoAAAAASUVORK5CYII=', 'base64');
  const bg = await fetch(env.url + '/api/theme/background?type=image/png', { method: 'POST', body: png });
  assert.equal(bg.status, 200);
  assert.equal((await fetch(env.url + '/api/background')).status, 200);
  const uploaded = await fetch(env.url + '/api/attach?name=unsafe.html&type=text/html', { method: 'POST', body: '<script>alert(1)</script>' });
  const attachment = (await uploaded.json()).attachment;
  const downloaded = await fetch(env.url + '/api/attachment/' + attachment.id);
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  const cross = await fetch(env.url + '/api/agents', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(cross.status, 403);
  await env.app.close();
  const restored = await start(t, { dataDir: env.dataDir });
  const theme = (await restored.call('/theme')).data.theme;
  assert.deepEqual(theme.colors, before.colors);
  assert.equal(theme.background.kind, 'file');
});

test('a missing harness does not block healthy group members; streamed failures stay in history', async (t) => {
  const captured = [];
  let room;
  const env = await start(t, { roomFactory: (settings) => {
    room = fakeFactory(captured)(settings);
    const failing = room.pools.get('dsh');
    failing.start = async () => { throw new Error('fixture: harness missing'); };
    return room;
  } });
  const a = (await env.call('/agents', { label: 'Ada', backend: 'codex' })).data.agent;
  const b = (await env.call('/agents', { label: 'Bob', backend: 'dsh' })).data.agent;
  const group = (await env.call('/groups', { agentIds: [a.id, b.id] })).data.conversation;
  assert.equal((await env.call('/say', { room: group.id, text: 'hello everyone' })).status, 202);
  const snapshot = await until(async () => {
    const view = (await env.call('/conversation?id=' + group.id)).data;
    return !view.pending && view.snapshot.log.some((r) => r.kind === 'system') && view.snapshot;
  });
  assert.ok(snapshot.log.some((r) => r.authorId === a.id && r.kind === 'agent'));
  assert.ok(snapshot.log.some((r) => r.kind === 'system' && r.text.includes('Bob 回复失败')));
  assert.ok(captured.every((turn) => turn.backend === 'codex'));
  const ticker = room.tickTimer;
  assert.ok(ticker);
  await env.app.close();
  assert.equal(room.tickTimer, null);
  assert.ok(room.members.every((member) => member.segments.length === 0));
});

test('desktop service requires its launch credential while browser mode remains usable', async (t) => {
  const env = await start(t, { accessToken: 'isolated-test-credential' });
  assert.equal((await fetch(env.url + '/')).status, 403);
  assert.equal((await env.call('/catalog')).status, 403);
  const response = await fetch(env.url + '/api/catalog', { headers: { 'X-Agent-Room-Token': 'isolated-test-credential' } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).agents, []);
});

test('backend management validates and persists paths, supports desktop picker, and restores automatic selection', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-'));
  const executable = path.join(dir, 'qodercli.exe');
  fs.writeFileSync(executable, 'fixture only, never executed');
  const env = await start(t, { dataDir: dir, chooseBackendFile: async () => executable });
  assert.equal((await env.call('/backends')).data.canBrowse, true);
  assert.equal((await env.call('/backends/browse', {})).data.path, executable);
  assert.equal((await env.call('/backends', { id: 'qoder', path: 'missing' })).status, 400);
  const saved = await env.call('/backends', { id: 'qoder', path: executable });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.harnesses.find((h) => h.id === 'qoder').selected.path, executable);
  assert.equal(saved.data.harnesses.find((h) => h.id === 'qoder').selected.launch, undefined);
  await env.app.close();
  const restored = await start(t, { dataDir: dir });
  assert.equal((await restored.call('/backends')).data.harnesses.find((h) => h.id === 'qoder').configured, true);
  assert.equal((await restored.call('/backends', { id: 'qoder', automatic: true })).data.harnesses.find((h) => h.id === 'qoder').configured, false);
  assert.equal((await restored.call('/backends/browse', {})).status, 400);
});

test('agent settings preserve files, persist pins and reject invalid edits', async t => {
  const queryModels = async () => ({ models: [{ id: 'fixed', name: 'Fixed', efforts: ['low', 'high'], defaultEffort: 'low' }] });
  let latestSettings;
  const factory = fakeFactory([]);
  const env = await start(t, { queryModels, roomFactory: settings => { latestSettings = settings; return factory(settings); } });
  const added = (await env.call('/agents', { label: '设置测试', backend: 'dsh', model: 'fixed' })).data;
  const {agent, conversation: room} = added;
  const next = path.join(env.dataDir, 'new-workspace'); fs.mkdirSync(next);
  fs.writeFileSync(path.join(agent.workspace, 'keep.txt'), 'original');
  await env.call('/conversation?id=' + room.id);
  assert.equal((await env.call('/agents/settings', { id: agent.id, room: room.id, workspace: next, effort: 'invalid' })).status, 400);
  assert.equal((await env.call('/agents/settings', { id: agent.id, room: room.id, workspace: next, model: 'other' })).status, 400);
  assert.equal((await env.call('/agents/settings', { id: agent.id, room: room.id, workspace: next, effort: 'high' })).status, 200);
  assert.equal((await env.call('/conversation/pin', { id: room.id, pinned: true })).status, 200);
  const data = (await env.call('/catalog')).data;
  assert.equal(data.agents[0].workspace, fs.realpathSync(next));
  assert.equal(data.agents[0].model, 'fixed');
  assert.equal(data.conversations[0].efforts[agent.id], 'high');
  assert.equal(data.conversations[0].pinned, true);
  assert.equal(fs.readFileSync(path.join(agent.workspace, 'keep.txt'), 'utf8'), 'original');
  const snap = (await env.call('/conversation?id=' + room.id)).data.snapshot;
  assert.equal(latestSettings.members[0].workspace, fs.realpathSync(next));
  await env.app.close();
  const reopened = await start(t, { dataDir: env.dataDir, queryModels, roomFactory: fakeFactory([]) });
  assert.equal((await reopened.call('/catalog')).data.conversations[0].pinned, true);
  assert.equal((await reopened.call('/conversation/pin', { id: room.id, pinned: false })).status, 200);
  assert.equal((await reopened.call('/catalog')).data.conversations[0].pinned, false);
});

test('renaming agents and groups persists names without moving workspace or changing history', async t => {
  const env = await start(t, { roomFactory: fakeFactory([]) });
  const a = (await env.call('/agents', { label: '旧名字', backend: 'dsh' })).data;
  const b = (await env.call('/agents', { label: '已占用', backend: 'dsh' })).data;
  const group = (await env.call('/groups', { agentIds: [a.agent.id, b.agent.id] })).data.conversation;
  assert.equal((await env.call('/conversation/rename', { id: a.conversation.id, name: '已占用' })).status, 400);
  assert.equal((await env.call('/conversation/rename', { id: a.conversation.id, name: '@非法' })).status, 400);
  assert.equal((await env.call('/conversation/rename', { id: a.conversation.id, name: '新名字' })).status, 200);
  assert.equal((await env.call('/conversation/rename', { id: group.id, name: '新群聊' })).status, 200);
  await env.app.close();
  const again = await start(t, { dataDir: env.dataDir, roomFactory: fakeFactory([]) });
  const data = (await again.call('/catalog')).data;
  assert.equal(data.agents[0].label, '新名字');
  assert.equal(data.agents[0].workspace, a.agent.workspace);
  assert.deepEqual(data.agents[0].aliases, ['新名字']);
  assert.equal(data.conversations.find(c => c.id === a.conversation.id).title, '新名字');
  assert.equal(data.conversations.find(c => c.id === group.id).title, '新群聊');
  assert.deepEqual(data.conversations.find(c => c.id === group.id).agentIds, group.agentIds);
});

test('manually copied data restores history attachments from the new directory', async t => {
 const captured=[];const env=await start(t,{roomFactory:fakeFactory(captured)});
 const a=(await env.call('/agents',{label:'迁移附件',backend:'dsh'})).data;
 const response=await fetch(env.url+'/api/attach?name=note.txt&type=text/plain',{method:'POST',body:'copied bytes'});
 const file=(await response.json()).attachment;
 await env.call('/say',{room:a.conversation.id,text:'读取附件',attachments:[file.id]});
 await until(async()=>!(await env.call('/conversation?id='+a.conversation.id)).data.pending);
 await env.app.close();
 const newDir=env.dataDir+'-copy';fs.cpSync(env.dataDir,newDir,{recursive:true});
 const restored=await start(t,{dataDir:newDir,roomFactory:fakeFactory(captured)});
 assert.equal(await (await fetch(restored.url+'/api/attachment/'+file.id)).text(),'copied bytes');
 await restored.call('/say',{room:a.conversation.id,text:'继续'});
 await until(()=>captured.length===2);
 assert.ok(captured[1].input.text.includes(newDir), 'history broadcast should use the new attachment path');
});
