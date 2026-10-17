'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentRoom } = require('../lib/room.cjs');
const { parseMessages, splitMessages } = require('../lib/message-routing.cjs');

const members = [{ id: 'a', label: '架构师' }, { id: 'b', label: '审查 员' }, { id: 'c', label: '研究员' }];
function fixture(t, options = {}) {
  const room = new AgentRoom({ id: 'private-test', members, prewarm: false, segmentMs: 0, queueStallMs: 0, maxRelayHops: 0, ...options });
  const calls = [], opened = [], threads = new Map();
  const pool = { running: true, getThread: id => threads.get(id),
    async openThread(id, config) { opened.push(config); const thread = { id, ...config }; threads.set(id, thread); return thread; },
    async modelCapabilities() { return new Map(); }, closeThread(id) { threads.delete(id); },
    async runTurn(id, input) { calls.push({ id, input }); return { text: '(无补充)' }; },
    async stop() {}, async interrupt() { return true; }
  };
  room.pools.set('codex', pool);
  t.after(() => room.dispose());
  return { room, calls, opened, pool };
}

test('one reply splits public/private blocks, preserves #, spaces and fenced separators', () => {
  const raw = '公开\n---\n#审查 员\n私密\n---\n@研究员 公开';
  const rows = parseMessages(raw, members, 'a');
  assert.deepEqual(rows.map(r => r.visibility), ['public', 'private', 'public']);
  assert.equal(rows[1].text, '#审查 员\n私密');
  assert.deepEqual(rows[1].recipientIds, ['b']);
  assert.equal(splitMessages('```text\n---\n#研究员 example\n```\n---\n公开').length, 2);
  assert.equal(parseMessages('# 标题\n正文含 #研究员', members)[0].visibility, 'public');
  assert.throws(() => parseMessages('公开\n---\n#不存在 私密', members));
  assert.throws(() => parseMessages('#研究员-extra 私密', members));
  assert.throws(() => parseMessages('#架构师 自己', members, 'a'));
  assert.deepEqual(parseMessages('#用户 仅给用户', members, 'a')[0].recipientIds, ['user']);
});

test('private first message wakes only recipient; sender/header/# and attachment stay scoped', async t => {
  const { room, calls } = fixture(t);
  await room.say('#审查 员 secret-123 @研究员', { attachments: [{ id: 'file', path: '/private/file.txt', name: 'private.txt' }] });
  assert.deepEqual(calls.map(c => c.id), ['b']);
  assert.match(calls[0].input.text, /私聊：用户 → 审查 员/);
  assert.match(calls[0].input.text, /#审查 员 secret-123 @研究员/);
  assert.equal(calls[0].input.attachments.length, 1);
  for (const id of ['a', 'c']) {
    const member = room.members.find(m => m.id === id);
    assert.equal(member.segments.length, 0);
    assert.doesNotMatch(room._replayLines(member).join('\n'), /secret-123|private\/file/);
  }
  assert.equal(room.snapshot().log[0].visibility, 'private'); // Human sees all.
});

test('agent batch is captured completely before one relay and no private @ leaks', async t => {
  const { room, pool } = fixture(t);
  pool.runTurn = async () => ({ text: '公开一\n---\n#审查 员 secret-456 @研究员\n---\n@研究员 公开二' });
  const relays = [];
  room._enqueueRelay = record => relays.push(record);
  room.append({ authorId: 'user', text: '@架构师 开始', mentions: ['a'] });
  const author = room.members[0];
  await room._runSegment(author, author.segments.shift());
  const b = room.members[1].segments.flatMap(s => s.lines).join('\n');
  const c = room.members[2].segments.flatMap(s => s.lines).join('\n');
  assert.match(b, /#审查 员 secret-456/);
  assert.match(b, /私聊：架构师 → 审查 员/);
  assert.doesNotMatch(c, /secret-456/);
  assert.match(c, /公开一/); assert.match(c, /公开二/);
  assert.equal(room.log.length, 4);
  assert.equal(relays.length, 1);
  assert.deepEqual(new Set(relays[0].mentions), new Set(['b', 'c']));
});

test('invalid batch commits nothing; interrupted generation commits nothing', async t => {
  const { room, pool } = fixture(t);
  await assert.rejects(room.say('公开\n---\n#错误名字 私密'));
  assert.equal(room.log.length, 0);
  const segment = () => ({ id: 's', lines: [], mentions: new Set(), attachments: [] });
  pool.runTurn = async () => ({ text: '公开\n---\n#错误名字 私密' });
  const failed = await room._runSegment(room.members[0], segment());
  assert.match(failed.error, /私聊接收者/);
  assert.equal(room.log.length, 0);
  pool.runTurn = async () => ({ text: '#审查 员 未完成', status: 'interrupted' });
  await room._runSegment(room.members[0], segment());
  assert.equal(room.log.length, 0);
});

test('restart replay uses stable IDs, includes own messages, filters private attachments', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-room-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'room.jsonl');
  const first = fixture(t, { logFile }).room;
  first.append({ authorId: 'a', authorLabel: '架构师', text: '#审查 员 secret-replay', visibility: 'private', recipientIds: ['b'], recipientLabels: ['审查 员'], attachments: [{ id: 'secret', path: '/secret/image.png', isImage: true }] });
  first.append({ authorId: 'a', text: '公开历史' });
  const { room, calls } = fixture(t, { logFile });
  assert.match(room._replayLines(room.members[0]).join('\n'), /secret-replay/);
  room.members[1].label = '新审查员';
  assert.match(room._replayLines(room.members[1]).join('\n'), /secret-replay/);
  assert.doesNotMatch(room._replayLines(room.members[2]).join('\n'), /secret-replay|secret\/image/);
  await room._runSegment(room.members[2], { id: 'replay', lines: [], mentions: new Set(), attachments: [] });
  assert.doesNotMatch(calls[0].input.text, /secret-replay/);
  assert.equal(calls[0].input.attachments.length, 0);
});

test('full room skill is loaded once per new session; turn reminder stays short', async t => {
  const { room, calls, opened, pool } = fixture(t);
  await room.say('@架构师 你好');
  await room.say('@架构师 再聊');
  assert.equal(opened.length, 1);
  assert.match(opened[0].developerInstructions, /群聊规则 v2/);
  assert.match(opened[0].developerInstructions, /#原发送者/);
  assert.doesNotMatch(calls[1].input.text, /群聊规则 v2/);
  assert.match(calls[1].input.text, /发送规则/);
  pool.closeThread('a');
  await room.say('@架构师 重建');
  assert.equal(opened.length, 2);
  assert.match(opened[1].developerInstructions, /群聊规则 v2/);
});

test('direct session receives role and workspace without group membership rules', async t => {
  const { room, calls, opened } = fixture(t, { kind: 'direct', members: [{ id: 'a', label: '架构师', workspace: process.cwd(), persona: '职责：设计架构' }] });
  await room.say('你好');
  const prompt = opened[0].developerInstructions;
  assert.ok(prompt.includes(process.cwd()));
  assert.match(prompt, /你的名称是 架构师/);
  assert.match(prompt, /职责：设计架构/);
  assert.match(prompt, /一对一交流/);
  assert.doesNotMatch(prompt, /群聊规则|你已加入群聊/);
  assert.match(calls[0].input.text, /一对一会话/);
  await room.say('继续');
  assert.equal(calls.length, 2, 'direct replies do not wait for the group batching timer');
  assert.equal(opened.length, 1, 'identity is loaded once per backend session');
});

test('addressed agents start together before either finishes', { timeout: 3000 }, async t => {
  const { room, pool } = fixture(t);
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  pool.runTurn = async id => {
    started.push(id);
    if (started.length === 2) release();
    await gate;
    return { text: '(无补充)' };
  };
  await room.say('@架构师 @研究员 一起回答');
  assert.deepEqual(new Set(started), new Set(['a', 'c']));
});
