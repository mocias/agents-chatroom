'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApplication } = require('../standalone/server.cjs');
const { AgentRoom } = require('../lib/room.cjs');
const { PollStore } = require('../lib/polls.cjs');
fs.mkdirSync(path.resolve('output/playwright'), { recursive: true });
const root = fs.mkdtempSync(path.resolve('output/playwright/polls-ui-'));
const members = [{ id: 'design', label: '设计师', backend: 'codex' }, { id: 'review', label: '审查员', backend: 'dsh' }, { id: 'research', label: '研究员', backend: 'qoder' }];
fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ version: 1, agents: members,
  conversations: [
    { id: 'polls-group', kind: 'group', title: '投票体验验收', agentIds: members.map(m => m.id), updatedAt: new Date().toISOString() },
    { id: 'other-group', kind: 'group', title: '另一群聊', agentIds: members.map(m => m.id), updatedAt: new Date().toISOString() },
  ] }));
const polls = new PollStore(path.join(root, 'polls.json'));
for (const visibility of ['anonymous', 'public']) {
  const p = polls.call('polls-group', 'design', 'poll_create', { question: visibility === 'anonymous' ? '下一版优先完善什么？' : '本周先验证哪个环节？',
    options: ['优化聊天界面', '完善自动化测试', '增加后端适配'], visibility, duration_seconds: 3600, request_id: visibility }, members);
  polls.call('polls-group', 'review', 'poll_vote', { poll_id: p.id, option_id: 'o2' }, members);
}
const app = createApplication({ dataDir: root, pollScheduling: false, discoveryInventory: async () => ({ rows: [], warning: '' }),
  registerAgent: async () => ({}), prepareNativeSession: async () => ({}), afterNativeTurn: async () => {},
  roomFactory: options => {
    const room = new AgentRoom(options);
    for (const backend of ['codex', 'dsh', 'qoder']) room.pools.set(backend, { running: true, stop: async () => {}, getThread: () => null, modelCapabilities: async () => new Map() });
    return room;
  } });
app.server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + app.server.address().port, data: root })));
process.stdin.resume();
process.stdin.on('data', () => { void app.close().then(() => process.exit(0)); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
