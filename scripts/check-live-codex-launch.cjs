'use strict';
// Real model acceptance in a fresh local app. Requires an already signed-in
// Codex install; no proxy/OS settings are changed. Sends one fixed-text prompt.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApplication } = require('../standalone/server.cjs');
const { childEnv } = require('../lib/codex-pool.cjs');
const exe = process.argv[2];
if (!exe || !path.isAbsolute(exe)) throw new Error('Pass the absolute installed codex.exe path');
const root = fs.mkdtempSync(path.resolve('output/codex-launch-live-'));
const dataDir = path.join(root, 'data');
const report = { root, exe, passed: false, generatedModelRequests: 1,
  proxyConfigured: Boolean(childEnv({}).HTTPS_PROXY || childEnv({}).ALL_PROXY), osProxyChanged: false };
const app = createApplication({ dataDir, workspaceRoot: path.join(root, 'agents'),
  registerAgent: async () => ({ status: 'skipped', detail: 'Live test does not register a desktop project' }),
  prepareNativeSession: async () => ({}), afterNativeTurn: async () => {},
});
(async () => {
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    async function api(route, body) {
      const response = await fetch(base + '/api' + route, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
      return result;
    }
    await api('/discovery-consent', { choice: 'manual' });
    await api('/backends', { id: 'codex', path: exe, ...(process.env.CHECK_BACKEND_PROXY ? { proxy: process.env.CHECK_BACKEND_PROXY } : {}) });
    report.perBackendProxyConfigured = Boolean(process.env.CHECK_BACKEND_PROXY);
    const catalogue = await api('/models', { backend: 'codex' });
    const model = catalogue.models.find(m => m.id === catalogue.selected);
    assert.ok(model); report.model = model.id;
    const { agent, conversation } = await api('/agents', { label: 'Codex launch acceptance', backend: 'codex', model: model.id });
    report.workspace = agent.workspace; report.groupId = conversation.id;
    report.binaryAndWorkspaceOnDifferentDrives = path.parse(exe).root.toLowerCase() !== path.parse(agent.workspace).root.toLowerCase();
    if (model.efforts?.includes('low')) await api('/member-effort', { room: conversation.id, agent: agent.id, effort: 'low' });
    await api('/say', { room: conversation.id, text: '只回复 ROOM_CODEX_LAUNCH_OK，不要调用工具或读写文件。' });
    const deadline = Date.now() + 90000;
    let state;
    do {
      await new Promise(resolve => setTimeout(resolve, 500));
      state = await api('/conversation?id=' + conversation.id);
    } while ((state.pending || state.snapshot.busy.length) && Date.now() < deadline);
    report.members = state.snapshot.members;
    report.log = state.snapshot.log;
    assert.equal(state.pending, false, 'request must finish');
    assert.equal(state.snapshot.busy.length, 0);
    assert.ok(state.snapshot.log.some(row => row.authorId === agent.id && row.text?.includes('ROOM_CODEX_LAUNCH_OK')), 'missing real Codex reply');
    assert.equal(fs.existsSync(path.join(dataDir, 'workspaces/codex')), false, 'acceptance must not rely on a pre-existing legacy folder');
    report.passed = true;
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    await app.close();
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
