'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { childEnv: codexEnv } = require('../lib/codex-pool.cjs');
const { childEnv: acpEnv } = require('../lib/acp-backend.cjs');
const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy', 'AGENT_ROOM_PROXY'];
function environment(values, action) {
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    return action();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}
for (const [name, childEnv] of [['Codex', codexEnv], ['ACP', acpEnv]]) {
  test(name + ' leaves TUN/direct networking alone instead of forcing a machine-specific proxy', () => {
    environment({}, () => {
      const child = childEnv({});
      for (const key of keys.slice(0, 6)) assert.equal(child[key], undefined, key);
    });
  });
  test(name + ' inherits an existing proxy and honors explicit room proxy settings', () => {
    environment({ HTTPS_PROXY: 'http://127.0.0.1:21080', ALL_PROXY: 'socks5://127.0.0.1:21081' }, () => {
      assert.equal(childEnv({}).HTTPS_PROXY, 'http://127.0.0.1:21080');
      assert.equal(childEnv({}).ALL_PROXY, 'socks5://127.0.0.1:21081');
    });
    environment({ AGENT_ROOM_PROXY: 'http://127.0.0.1:21082' }, () => {
      assert.equal(childEnv({}).HTTPS_PROXY, 'http://127.0.0.1:21082');
      assert.equal(childEnv({ proxy: false }).HTTPS_PROXY, undefined);
      assert.equal(childEnv({ proxy: '' }).HTTPS_PROXY, undefined);
      assert.equal(childEnv({ proxy: 'http://127.0.0.1:21083' }).HTTPS_PROXY, 'http://127.0.0.1:21083');
    });
  });
  test(name + ' preserves custom bypasses and always bypasses local app traffic', () => {
    environment({ NO_PROXY: 'internal.example', no_proxy: 'other.example' }, () => {
      const child = childEnv({ env: { NO_PROXY: 'extra.example,internal.example' } });
      for (const key of ['NO_PROXY', 'no_proxy']) {
        const bypasses = child[key].split(',');
        for (const value of ['internal.example', 'other.example', 'extra.example', 'localhost', '127.0.0.1', '::1']) assert.ok(bypasses.includes(value), key + ' missing ' + value);
      }
    });
  });
}
