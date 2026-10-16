const { _electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const home = fs.mkdtempSync(path.resolve('output/qoder-desktop-'));
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: path.resolve('dist/win-unpacked/Agent Room.exe'), env });
  try {
    const page = await app.firstWindow();
    await page.getByText('本地已连接', { exact: true }).waitFor();
    const report = await app.evaluate(async ({ app }) => {
      const req = process.mainModule.require.bind(process.mainModule);
      const path = req('node:path');
      const { BackendDiscovery } = req(path.join(app.getAppPath(), 'standalone/discovery.cjs'));
      const { AcpPool } = req(path.join(app.getAppPath(), 'lib/acp-backend.cjs'));
      const cwd = app.getPath('userData');
      const row = (await new BackendDiscovery({ dir: cwd }).scan()).find(r => r.id === 'qoder');
      const pool = new AcpPool({ ...row.selected.launch, cwd });
      try {
        await pool.start();
        await pool.openThread('test', { cwd, sandbox: 'read-only' });
        const result = await pool.runTurn('test', { text: 'Reply with exactly QODER_DESKTOP_OK. Do not use tools or change files.', timeoutMs: 60000 });
        return { selected: row.selected.path, reply: result.text };
      } finally { await pool.stop(); }
    });
    assert.match(report.reply, /QODER_DESKTOP_OK/);
    await page.getByRole('button', { name: '后端管理', exact: true }).click();
    await page.locator('#backend-id').selectOption('qoder');
    await page.screenshot({ path: path.join(home, 'qoder.png') });
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ home, ...report }, null, 2));
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
