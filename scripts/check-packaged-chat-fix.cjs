'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { _electron } = require('playwright-core');
(async () => {
  const output = fs.mkdtempSync(path.resolve('output/packaged-chat-fix-'));
  const archive = path.resolve('dist/win-unpacked/resources/app.asar');
  const files = ['lib/room.cjs', 'lib/acp-backend.cjs', 'standalone/server.cjs', 'standalone/models.cjs', 'standalone/public/app.js'];
  for (const file of files) assert.deepEqual(asar.extractFile(archive, path.normalize(file)), fs.readFileSync(path.resolve(file)), file);
  fs.mkdirSync(path.join(output, 'data'));
  fs.writeFileSync(path.join(output, 'data/discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: output, AGENT_ROOM_WORKSPACE_ROOT: path.join(output, 'agents') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: path.resolve('dist/win-unpacked/Agent Room.exe'), env });
  try {
    const page = await app.firstWindow();
    await page.getByText('本地已连接', { exact: true }).waitFor();
    const version = await app.evaluate(({ app }) => app.getVersion());
    assert.equal(version, require('../package.json').version);
    const catalog = await page.evaluate(async () => (await fetch('/api/catalog')).json());
    assert.deepEqual(catalog.agents, []); assert.equal(catalog.discoveryChoice, 'manual');
    await page.screenshot({ path: path.join(output, 'startup.png') });
    const report = { ok: true, version, packagedSourcesMatch: files, isolatedStartup: true };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, ...report }));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
