'use strict';
const { _electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const home = fs.mkdtempSync(path.resolve('output/packaged-alarms-'));
  const data = path.join(home, 'data'), workspace = path.join(home, 'workspace');
  fs.mkdirSync(data); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(data, 'discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  fs.writeFileSync(path.join(data, 'catalog.json'), JSON.stringify({ version: 1,
    agents: [{ id: 'a', label: '测试伙伴', backend: 'codex', workspace, persona: '' }],
    conversations: [{ id: 'alarm-smoke', kind: 'group', title: '桌面闹钟验收', agentIds: ['a'] }] }));
  const executablePath = process.env.SMOKE_EXECUTABLE || path.resolve('dist/win-unpacked/Agent Room.exe');
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: home, AGENT_ROOM_WORKSPACE_ROOT: workspace }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const mainErrors = [];
  const watchErrors = async instance => {
    instance.process().stderr.on('data', data => { if (String(data).includes('SMOKE_UNCAUGHT')) mainErrors.push(String(data)); });
    await instance.evaluate(() => { process.on('uncaughtException', error => console.error('SMOKE_UNCAUGHT', error.stack)); });
  };
  try {
    app = await _electron.launch({ executablePath, env });
    await watchErrors(app);
    let page = await app.firstWindow();
    const version = await app.evaluate(({ app }) => app.getVersion()); assert.equal(version, '0.1.11');
    await page.getByRole('button', { name: /桌面闹钟验收/ }).click();
    await page.locator('#draft').fill('/alarm 1s #用户 desktop-reminder'); await page.locator('#send').click();
    await page.getByText(/#系统：#用户 当前时间为：.*desktop-reminder/).waitFor();
    await page.locator('#draft').fill('/alarm 1h #用户 cancel-desktop'); await page.locator('#send').click();
    await page.getByText(/闹钟已设置：.*cancel-desktop/).waitFor();
    await page.locator('#alarms').click();
    await page.locator('.alarm-row').filter({ hasText: 'cancel-desktop' }).getByRole('button', { name: '取消闹钟' }).click();
    await page.locator('.alarm-row').filter({ hasText: '已取消' }).waitFor();
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await app.close(); app = null;
    assert.deepEqual(mainErrors, []);
    app = await _electron.launch({ executablePath, env }); page = await app.firstWindow();
    await watchErrors(app);
    await page.getByRole('button', { name: /桌面闹钟验收/ }).click();
    await page.getByText(/#系统：#用户 当前时间为：.*desktop-reminder/).waitFor();
    const snapshot = await page.evaluate(async () => (await (await fetch('/api/conversation?id=alarm-smoke')).json()).snapshot);
    assert.equal(snapshot.log.filter(r => r.kind === 'alarm').length, 1);
    assert.equal(snapshot.members[0].turns, 0); // No real harness/model calls.
    await page.screenshot({ path: path.join(home, 'desktop.png') });
    await app.close(); app = null;
    assert.deepEqual(mainErrors, []);
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify({ passed: true, version, executablePath, realModelCalls: 0, checks: ['packaged launch', 'private system reminder', 'list and cancel', 'restart history and no duplicate'] }, null, 2));
    console.log(JSON.stringify({ passed: true, home, version, executablePath }));
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
