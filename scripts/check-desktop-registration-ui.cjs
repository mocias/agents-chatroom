'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
(async () => {
  const source = path.resolve(process.argv[2]);
  const home = fs.mkdtempSync(path.resolve('output/desktop-registration-ui-'));
  const data = path.join(home, 'data');
  fs.mkdirSync(path.join(data, 'desktop-sync'), { recursive: true });
  const catalog = JSON.parse(fs.readFileSync(path.join(source, 'catalog.json'), 'utf8'));
  catalog.agents = catalog.agents.filter(a => ['dsh', 'codex', 'qoder', 'workbuddy-ai', 'claude'].includes(a.backend));
  catalog.conversations = catalog.conversations.filter(c => c.kind === 'direct' && catalog.agents.some(a => c.agentIds.includes(a.id)));
  fs.writeFileSync(path.join(data, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(data, 'discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  for (const name of ['bindings.json', 'dsh.json']) fs.copyFileSync(path.join(source, 'desktop-sync', name), path.join(data, 'desktop-sync', name));
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: home, AGENT_ROOM_WORKSPACE_ROOT: path.join(home, 'agents') };
  delete env.ELECTRON_RUN_AS_NODE;
  const errors = []; let app;
  async function launch() {
    app = await _electron.launch({ executablePath: process.env.SMOKE_EXECUTABLE || path.resolve('dist/win-unpacked/Agent Room.exe'), env });
    const page = await app.firstWindow();
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/models', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [], selected: null }) }));
    await page.locator('[data-room]').first().waitFor();
    return page;
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await launch();
      const state = await page.evaluate(async () => (await (await fetch('/api/catalog')).json()));
      assert.equal(state.agents.length, 5);
      for (const agent of state.agents) assert.equal(agent.desktopSync.workspaceRegistered, true, agent.backend + ': ' + agent.desktopSync.detail);
      const agent = catalog.agents.find(a => a.backend === 'qoder');
      const chat = catalog.conversations.find(c => c.agentIds.includes(agent.id));
      await page.locator(`[data-room="${chat.id}"]`).click();
      await page.locator('#members').click();
      await page.locator('#desktop-sync-status').waitFor();
      assert.match(await page.locator('#desktop-sync-status').innerText(), /尚未导入/);
      await page.locator('#check-desktop-sync').click();
      await page.waitForFunction(() => !document.querySelector('#check-desktop-sync').disabled);
      assert.match(await page.locator('#desktop-sync-status').innerText(), /已持久化登记/);
      await page.screenshot({ path: path.join(home, 'settings-' + attempt + '.png') });
      await app.close(); app = null;
    }
    assert.deepEqual(errors, []);
    const report = { ok: true, home, checks: ['five native workspace registrations', 'packaged SQLite read-only adapter', 'settings status and check button', 'isolated app restart retains registrations'], realModelCalls: 0 };
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
