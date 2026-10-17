'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApplication } = require('../standalone/server.cjs');

test('history searches and exports persisted direct/group records without starting models or exposing paths', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-history-'));
  fs.mkdirSync(path.join(dir, 'rooms'));
  const conversations = ['direct', 'group'].map(kind => ({ id: kind, kind, title: kind === 'group' ? '讨论组' : '伙伴', agentIds: [], updatedAt: '2026-10-17' }));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ agents: [], conversations }));
  const rows = Array.from({ length: 85 }, (_, i) => ({ id: 'm' + i, seq: i, ts: '2026-10-17T10:00:00Z', authorLabel: '伙伴', kind: 'agent', text: '历史检索 ' + i,
    visibility: i === 2 ? 'private' : 'public', recipientLabels: ['接收者'], internalSecret: 'DO_NOT_EXPORT',
    attachments: i === 1 ? [{ name: '附件查询.pdf', path: 'C:/PRIVATE/file', id: 'x' }] : [] }));
  fs.writeFileSync(path.join(dir, 'rooms/group.log.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\ncorrupt\n');
  fs.writeFileSync(path.join(dir, 'rooms/direct.log.jsonl'), JSON.stringify({ ...rows[0], text: '单聊 Hello' }) + '\n');
  const app = createApplication({ dataDir: dir, workspaceRoot: path.join(dir, 'agents'), roomFactory: () => { throw new Error('History must not start a room'); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api/history/';
  const get = async p => (await fetch(base + p)).json();
  const first = await get('search?q=' + encodeURIComponent('历史检索'));
  assert.equal(first.total, 85); assert.equal(first.results.length, 40); assert.equal(first.skipped, 1);
  assert.equal((await get('search?room=group&offset=80')).results.length, 5);
  assert.equal((await get('search?q=hello')).results[0].roomId, 'direct');
  assert.equal((await get('search?q=' + encodeURIComponent('附件查询'))).total, 1);
  assert.equal((await get('search?room=direct&q=' + encodeURIComponent('历史检索'))).total, 0);
  const response = await fetch(base + 'export?room=group&format=json');
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const data = await response.json(); assert.equal(data.messages.length, 85); assert.equal(data.skippedRecords, 1);
  assert.equal(data.messages[2].visibility, 'private'); assert.deepEqual(data.messages[2].recipients, ['接收者']);
  assert.equal(JSON.stringify(data).includes('PRIVATE'), false); assert.equal(JSON.stringify(data).includes('DO_NOT_EXPORT'), false);
  const md = await (await fetch(base + 'export?room=direct&format=md')).text();
  assert.match(md, /单聊 Hello/); assert.match(md, /伙伴/);
  assert.equal((await fetch(base + 'search?room=..%2Fcatalog')).status, 404);
  assert.equal((await fetch(base + 'export?room=group&format=exe')).status, 400);
  assert.equal((await fetch(base + 'search?offset=-1')).status, 400);
  assert.equal((await get('search?q=not-found')).total, 0);
});
