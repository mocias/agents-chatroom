'use strict';
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const home = fs.mkdtempSync(path.resolve('output/default-root-'));
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AGENT_ROOM_WORKSPACE_ROOT;
  const executablePath = path.resolve('dist/win-unpacked/Agent Room.exe');
  const app = await electron.launch({ executablePath, env });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const workspaceRoot = await page.evaluate(async () => (await (await fetch('/api/catalog')).json()).workspaceRoot);
    assert.equal(workspaceRoot, path.join(path.dirname(executablePath), 'agents'));
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify({ ok: true, workspaceRoot }));
    console.log(home + ': ' + workspaceRoot);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
