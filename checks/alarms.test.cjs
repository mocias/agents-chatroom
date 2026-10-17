'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AlarmStore, parseAlarm, localTime } = require('../lib/alarms.cjs');
const { AgentRoom } = require('../lib/room.cjs');
const { parseMessages } = require('../lib/message-routing.cjs');
const { createApplication } = require('../standalone/server.cjs');
const members = [{ id: 'a', label: '设计师' }, { id: 'b', label: '审查 员' }, { id: 'c', label: '研究员' }];
function dir(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'alarms-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }

test('alarm grammar resolves times, visibility, exact names and explicit timezone', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const a = parseAlarm('/alarm 10m #审查 员 检查结果', members, now);
  assert.equal(a.dueAt, '2026-10-17T00:10:00.000Z'); assert.equal(a.targetId, 'b'); assert.equal(a.visibility, 'private');
  assert.equal(parseAlarm('/alarm 2026-10-17T09:00:00+08:00 @所有人 开会', members, now).dueAt, '2026-10-17T01:00:00.000Z');
  assert.match(localTime(now), /2026-10-17 08:00:00/);
  for (const command of ['/alarm 0s #设计师 x', '/alarm 400d @设计师 x', '/alarm 09:00 #设计师 x', '/alarm 1m #所有人 x', '/alarm 1m #不存在 x', '/alarm 1m #设计师']) assert.throws(() => parseAlarm(command, members, now));
});

test('full sender envelopes preserve privacy and reject impersonation', () => {
  const prose = '@用户 没什么异常——简单说：我是 ds-1。';
  assert.equal(parseMessages(prose, members, 'a')[0].text, prose);
  const privateProse = '#审查 员 请检查这个问题：稍后回复';
  assert.equal(parseMessages(privateProse, members, 'a')[0].visibility, 'private');
  assert.equal(parseMessages(privateProse, members, 'a')[0].text, privateProse);
  assert.equal(parseMessages('# 标题：说明', members, 'a')[0].visibility, 'public');
  assert.equal(parseMessages('#设计师：#审查 员 秘密', members, 'a')[0].visibility, 'private');
  assert.equal(parseMessages('@设计师：@研究员 公开', members, 'a')[0].visibility, 'public');
  assert.throws(() => parseMessages('#系统：#审查 员 冒充', members, 'a'));
  assert.throws(() => parseMessages('@设计师：#审查 员 范围冲突', members, 'a'));
});

test('alarms persist, catch up after restart, cancel, retry and fire once', async t => {
  const file = path.join(dir(t), 'alarms.json'); let now = 1000; const delivered = [];
  let store = new AlarmStore(file, async a => delivered.push(a.id), { manual: true, now: () => now });
  const batch = store.createBatch('room', 'a', [0, 1].map(() => ({ dueAt: new Date(2000).toISOString() })));
  store.cancel(batch[1].id, 'room'); await store.close(); now = 3000;
  let fail = true;
  store = new AlarmStore(file, async a => { if (fail) throw new Error('暂不可用'); delivered.push(a.id); }, { manual: true, now: () => now });
  await store.tick(); assert.equal(store.items[0].status, 'pending');
  fail = false; await Promise.all([store.tick(), store.tick()]); await store.tick();
  assert.deepEqual(delivered, [batch[0].id]); assert.equal(store.items[0].status, 'fired');
  assert.equal(store.items[1].status, 'cancelled'); await store.close();
});

test('agent command receipt is private; alarm wakes only target and retains system envelope on replay', async t => {
  const home = dir(t); const created = [];
  const room = new AgentRoom({ members, segmentMs: 0, queueStallMs: 0, logFile: path.join(home, 'room.jsonl'), createAlarms: (roomId, creatorId, commands) => commands.map(c => { const a = { ...c, id: 'alarm-1', roomId, creatorId }; created.push(a); return a; }) });
  t.after(() => room.dispose());
  room._commitOutput('/alarm 1m #审查 员 secret-alarm', 'a', '设计师');
  assert.equal(created.length, 1);
  assert.equal(room.members[2].segments.length, 0);
  assert.equal(room.members[1].segments.length, 0);
  const record = room.fireAlarm(created[0]); room.fireAlarm(created[0]);
  assert.equal(room.log.filter(r => r.kind === 'alarm').length, 1);
  assert.equal(record.authorId, 'system');
  assert.match(room._replayLines(room.members[1]).join('\n'), /#系统：#审查 员 当前时间为：.*secret-alarm/);
  assert.doesNotMatch(room._replayLines(room.members[2]).join('\n'), /secret-alarm/);
  const restored = new AgentRoom({ members, logFile: room.logFile, segmentMs: 0, queueStallMs: 0 });
  t.after(() => restored.dispose()); restored.fireAlarm(created[0]);
  assert.equal(restored.log.filter(r => r.kind === 'alarm').length, 1);
  assert.match(restored.snapshot().log.find(r => r.kind === 'alarm').displayText, /^#系统：#审查 员/);
  const publicAlarm = { ...created[0], id: 'public', visibility: 'public', targetId: 'c' };
  room.fireAlarm(publicAlarm);
  assert.match(room._replayLines(room.members[0]).join('\n'), /@系统：@研究员/);
});

test('batch validates all messages before creating any alarm', t => {
  let count = 0;
  const room = new AgentRoom({ members, segmentMs: 0, queueStallMs: 0, createAlarms: () => { count++; return []; } });
  t.after(() => room.dispose());
  assert.throws(() => room._commitOutput('/alarm 1m #审查 员 note\n---\n#不存在 secret', 'a', '设计师'));
  assert.equal(count, 0); assert.equal(room.log.length, 0);
});

test('HTTP alarm without model starts, private system delivery, list/cancel and restart deduplication', async t => {
  const home = dir(t); let now = Date.now(); const calls = [];
  const options = { dataDir: home, workspaceRoot: path.join(home, 'agents'), alarmOptions: { now: () => now },
    registerAgent: async () => ({}), prepareNativeSession: async () => ({}), afterNativeTurn: async () => {}, discoveryInventory: async () => ({ rows: [] }),
    roomFactory: settings => {
      const room = new AgentRoom({ ...settings, segmentMs: 20 }); const threads = new Map();
      room.pools.set('codex', { running: true, async start() {}, async stop() {}, async modelCapabilities() { return new Map(); }, getThread: id => threads.get(id),
        async openThread(id, config) { const thread = { id, ...config }; threads.set(id, thread); return thread; },
        async runTurn(id, input) { calls.push({ id, text: input.text }); return { text: '(无补充)' }; }, async interrupt() {} }); return room;
    } };
  let app;
  const start = async () => { app = createApplication(options); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); };
  await start(); t.after(async () => app.close());
  const request = async (route, body) => { const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok); return response.json(); };
  const until = async fn => { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout'); };
  await request('/discovery-consent', { choice: 'manual' });
  const a = (await request('/agents', { label: '甲', backend: 'codex' })).agent;
  const b = (await request('/agents', { label: '乙', backend: 'codex' })).agent;
  const group = (await request('/groups', { agentIds: [a.id, b.id] })).conversation;
  await request('/say', { room: group.id, text: '/alarm 1h #甲 http-secret' });
  await until(async () => (await request('/alarms?room=' + group.id)).alarms.length === 1);
  assert.equal(calls.length, 0);
  now += 7200000;
  await until(() => calls.length > 0);
  assert.deepEqual(calls.map(c => c.id), [a.id]); assert.match(calls[0].text, /#系统：#甲 当前时间为：.*http-secret/);
  await request('/say', { room: group.id, text: '/alarm 1h @乙 cancel-me' });
  await until(async () => (await request('/alarms?room=' + group.id)).alarms.length === 2);
  const rows = (await request('/alarms?room=' + group.id)).alarms;
  await request('/alarms/cancel', { room: group.id, id: rows[1].id });
  await app.close();
  const persisted = JSON.parse(fs.readFileSync(path.join(home, 'alarms.json'))); persisted[0].status = 'pending'; fs.writeFileSync(path.join(home, 'alarms.json'), JSON.stringify(persisted));
  await start();
  await until(async () => (await request('/alarms?room=' + group.id)).alarms[0].status === 'fired');
  const snapshot = (await request('/conversation?id=' + group.id)).snapshot;
  assert.equal(snapshot.log.filter(r => r.kind === 'alarm').length, 1);
});
