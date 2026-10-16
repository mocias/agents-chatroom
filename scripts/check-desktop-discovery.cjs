'use strict';
const { _electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createPackage } = require('@electron/asar');
(async () => {
  const home = fs.mkdtempSync(path.resolve('output/discovery-desktop-'));
  const source = path.join(home, 'source');
  const entry = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
  fs.mkdirSync(path.dirname(path.join(source, entry)), { recursive: true });
  fs.writeFileSync(path.join(source, entry), '// fixture, never executed');
  const install = path.join(home, '自定义 安装');
  fs.mkdirSync(path.join(install, 'resources'), { recursive: true });
  await createPackage(source, path.join(install, 'resources', 'app.asar'));
  for (const name of ['DeepSeek Harness.exe', 'Codex.exe', 'qoder.exe']) fs.writeFileSync(path.join(install, name), 'fixture, never executed');
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: path.join(home, 'user') };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.SMOKE_EXECUTABLE || path.resolve('dist/win-unpacked/Agent Room.exe');
  const app = await _electron.launch({ executablePath, env });
  try {
    const result = await app.evaluate(async ({ app }, { install, real }) => {
      const req = process.mainModule.require.bind(process.mainModule);
      const path = req('node:path');
      const { adapt, BackendDiscovery } = req(path.join(app.getAppPath(), 'standalone/discovery.cjs'));
      const fixture = adapt('dsh', path.join(install, 'DeepSeek Harness.exe'));
      const excluded = [];
      for (const [id, file] of [['codex', 'Codex.exe'], ['qoder', 'qoder.exe']]) {
        try { adapt(id, path.join(install, file)); } catch { excluded.push(id); }
      }
      const result = { fixtureKind: fixture.kind, excluded };
      if (real) {
        const discovery = new BackendDiscovery({ dir: app.getPath('userData') });
        const row = (await discovery.scan()).find(row => row.id === 'dsh');
        if (!row.found) throw new Error('Real DSH was not discovered: ' + row.detail);
        const { AcpPool } = req(path.join(app.getAppPath(), 'lib/acp-backend.cjs'));
        const pool = new AcpPool(row.selected.launch);
        let timer;
        try {
          await Promise.race([pool.start(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DSH initialize timed out')), 15000); })]);
          result.real = { path: row.selected.path, source: row.selected.source, initialized: true };
        } finally { clearTimeout(timer); await pool.stop(); }
      }
      return result;
    }, { install, real: process.env.CHECK_REAL_DSH === '1' });
    assert.equal(result.fixtureKind, '桌面后端');
    assert.deepEqual(result.excluded, ['codex', 'qoder']);
    const page = await app.firstWindow();
    await page.getByText('本地已连接', { exact: true }).waitFor();
    if (process.env.CHECK_REAL_DSH === '1') {
      const rows = await page.evaluate(async () => (await (await fetch('/api/backends')).json()).harnesses);
      assert.equal(rows.find(row => row.id === 'dsh').found, true);
      await page.getByRole('button', { name: '后端管理', exact: true }).click();
      await page.locator('#backend-id').selectOption('dsh');
      await page.screenshot({ path: path.join(home, 'dsh-discovered.png') });
    }
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify({ ok: true, executablePath, ...result }, null, 2));
    console.log(JSON.stringify({ home, ...result }, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
