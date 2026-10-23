const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('agentschat display name preserves the DSH host registration contract', async () => {
  const manifest = require('../package.json');
  const builder = require('../desktop/builder.cjs');
  assert.equal(manifest.productName, 'agentschat');
  assert.equal(builder.productName, manifest.productName);
  let registered;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(bundle) {
      assert.equal(bundle.id, manifest.name, 'DSH drops client bundles whose ID differs from the package name');
      registered = bundle;
    } } },
  });
  assert.equal(typeof registered.factory, 'function');
  assert.equal((await import('../lib/index.js')).name, manifest.name);
  const patch = fs.readFileSync(path.join(__dirname, '../cordis.patch.yml'), 'utf8');
  assert.equal(patch.match(/^\s+name: '([^']+)'/m)[1], manifest.name);
  assert.equal(require('../package-lock.json').packages[''].name, manifest.name);
  assert.equal(builder.appId, 'com.mocias.agentroom');
  assert.equal(builder.executableName, 'Agent Room');
});
