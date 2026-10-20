'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncDshCatalog } = require('../lib/dsh-catalog-sync.cjs');

test('DSH host reconciles independent agent directories and existing sessions, retrying failed attachments', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agents = ['a', 'b'].map(id => {
    const workspace = path.join(root, id); fs.mkdirSync(workspace);
    return { id, label: id, backend: 'dsh', workspace };
  });
  const rows = new Map(); let fail = true;
  const registry = { async create(dir, title) {
    if (!rows.has(dir)) rows.set(dir, { id: dir, title, sessions: new Set(), async attachSession(id) {
      if (fail && id === 'later') throw Error('header not persisted');
      this.sessions.add(id);
    } });
    return rows.get(dir);
  } };
  const catalog = { agents: [...agents, { id: 'q', backend: 'qoder' }], conversations: [
    { nativeSessions: { a: { backend: 'dsh', id: 'one' }, b: { backend: 'dsh', id: 'later' } } },
    { nativeSessions: { a: { backend: 'dsh', id: 'two' } } },
  ] };
  assert.deepEqual((await syncDshCatalog(registry, catalog)).map(a => a.status), ['registered', 'error']);
  fail = false;
  for (let n = 0; n < 2; n++) assert.ok((await syncDshCatalog(registry, catalog)).every(a => a.status === 'registered'));
  assert.equal(rows.size, 2);
  assert.deepEqual([...rows.get(agents[0].workspace).sessions], ['one', 'two']);
  assert.deepEqual([...rows.get(agents[1].workspace).sessions], ['later']);
});
