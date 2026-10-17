'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readDesktopCatalog } = require('../lib/workbuddy-catalog.cjs');
const filename = 'wb_entry_d43e96994f944cfb77961c2ea7d04605.info';
test('desktop cloud catalog follows declared order and rereads replacements, never installed models', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'local_storage'));
  const file = path.join(root, 'local_storage', filename);
  const data = { agents: [{ name: 'cli', models: ['auto', 'new', 'hidden', 'image'] }], models: [
    { id: 'new', name: 'New', supportsToolCall: true, apiKey: 'SECRET' },
    { id: 'auto', name: 'Auto', supportsToolCall: true },
    { id: 'unlisted', supportsToolCall: true }, { id: 'hidden', hidden: true, supportsToolCall: true },
    { id: 'image', supportsToolCall: false },
  ] };
  const save = entries => fs.writeFileSync(file, JSON.stringify(zlib.gzipSync(JSON.stringify(entries)).toString('base64')));
  save([{ userId: 'one', ts: Date.now(), data }]);
  assert.deepEqual(readDesktopCatalog(root).options.map(m => m.value), ['auto', 'new']);
  assert.equal(JSON.stringify(readDesktopCatalog(root)).includes('SECRET'), false);
  data.agents[0].models = ['new']; save([{ userId: 'one', ts: Date.now(), data }]);
  assert.deepEqual(readDesktopCatalog(root).options.map(m => m.value), ['new']);
  save([{ userId: 'one', data }, { userId: 'other', data }]);
  assert.equal(readDesktopCatalog(root).options, undefined);
  fs.writeFileSync(file, 'corrupt');
  assert.equal(readDesktopCatalog(root).options, undefined);
});
