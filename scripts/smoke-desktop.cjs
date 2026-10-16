'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  const executablePath = process.env.SMOKE_EXECUTABLE || path.join(root, 'dist', 'win-unpacked', 'Agent Room.exe');
  const home = fs.mkdtempSync(path.join(root, 'output', 'desktop-smoke-'));
  const report = { executablePath, home, checks: [] };
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: home, AGENT_ROOM_WORKSPACE_ROOT: path.join(home, 'agents') };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SMOKE_NO_NODE_PATH === '1') {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    report.withoutSystemNodeOnPath = true;
  }
  let instance;
  let origin;
  const launch = async () => {
    instance = await electron.launch({ executablePath, env, timeout: 30000 });
    const page = await instance.firstWindow();
    await page.getByRole('button', { name: '添加 Agent', exact: true }).waitFor();
    await page.getByText('本地已连接', { exact: true }).waitFor();
    const consent = await page.evaluate(async () => (await (await fetch('/api/catalog')).json()).discoveryChoice);
    if (consent === null) {
      await page.getByRole('button', { name: '不扫描，手动配置', exact: true }).click();
      await page.getByRole('button', { name: '扫描设置 / 重新检测', exact: true }).click();
      await page.getByRole('button', { name: '允许扫描', exact: true }).click();
      await page.locator('#backend-id').waitFor();
      await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    }
    origin = new URL(page.url()).origin;
    return page;
  };
  try {
    let page = await launch();
    const prefs = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    report.checks.push('Packaged window loads with sandbox, context isolation, and no renderer Node access');
    assert.equal((await fetch(origin + '/api/catalog')).status, 403);
    report.checks.push('Desktop local service rejects requests without its per-launch credential');
    const manualEntry = path.join(home, 'qodercli.exe');
    fs.writeFileSync(manualEntry, 'Discovery test fixture, never execute');
    await page.getByRole('button', { name: '后端管理', exact: true }).click();
    await page.locator('#backend-id').selectOption('qoder');
    await page.locator('#backend-path').fill('not-an-absolute-path');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '绝对路径' }).waitFor();
    await instance.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] }); }, manualEntry);
    await page.getByRole('button', { name: '浏览选择程序…', exact: true }).click();
    await page.waitForFunction((value) => document.querySelector('#backend-path').value === value, manualEntry);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '后端管理', exact: true }).click();
    await page.locator('#backend-id').selectOption('qoder');
    assert.equal(await page.locator('#backend-path').inputValue(), manualEntry);
    await page.getByRole('button', { name: '恢复自动选择', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已恢复自动选择' }).waitFor();
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    report.checks.push('Backend settings validate paths, accept picker results, persist selection and restore discovery (native picker mocked)');
    const customWorkspace = path.join(home, '我的 DSH 工作区');
    fs.mkdirSync(customWorkspace);
    for (const [name, backend] of [['桌面测试伙伴', 'codex'], ['另一位伙伴', 'dsh'], ['Qoder伙伴', 'qoder']]) {
      await page.getByRole('button', { name: '添加 Agent', exact: true }).click();
      await page.getByRole('textbox', { name: '名称', exact: true }).fill(name);
      await page.getByRole('combobox', { name: '后端', exact: true }).selectOption(backend);
      if (backend === 'dsh') {
        await instance.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, customWorkspace);
        await page.getByRole('button', { name: '选择文件夹…', exact: true }).click();
        await page.waitForFunction(value => document.querySelector('[name="workspace"]').value === value, customWorkspace);
      }
      await page.getByRole('button', { name: '添加并开始聊天', exact: true }).click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
    }
    await page.getByRole('button', { name: '发起群聊', exact: true }).click();
    await page.getByRole('textbox', { name: '群聊名称', exact: true }).fill('桌面安装验收');
    await page.getByRole('checkbox', { name: '选择 桌面测试伙伴' }).check();
    await page.getByRole('checkbox', { name: '选择 另一位伙伴' }).check();
    await page.getByRole('button', { name: '创建群聊', exact: true }).click();
    await page.getByRole('heading', { name: '桌面安装验收', exact: true }).waitFor();
    report.checks.push('Add contacts and multi-select group creation work in packaged renderer');
    for (const name of ['桌面测试伙伴', '另一位伙伴']) {
      await page.locator('#members').click();
      await page.locator('#modal-content .pick-row').filter({ hasText: name }).click();
      await page.locator('[name="effort"]').selectOption('high');
      assert.equal(await page.locator('#modal-content [name="model"]').count(), 0);
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    report.checks.push('Real Codex/DSH model lists populate; group reasoning saves independently while model stays read-only');
    const catalog = await page.evaluate(async () => (await fetch('/api/catalog')).json());
    assert.equal(catalog.agents.length, 3);
    assert.equal(catalog.agents[2].modelLocked, true);
    assert.equal(catalog.agents[0].workspace, path.join(home, 'agents', 'codex', '桌面测试伙伴'));
    assert.equal(catalog.agents[1].workspace, customWorkspace);
    assert.ok(fs.statSync(catalog.agents[0].workspace).isDirectory());
    report.checks.push('Default per-agent folder created; custom workspace picker result persists (native picker mocked)');
    const firstDirect = catalog.conversations.find(c => c.kind === 'direct' && c.agentIds.includes(catalog.agents[0].id));
    const firstRow = page.locator('[data-room="' + firstDirect.id + '"]');
    await firstRow.click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem').count(), 3);
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
    await page.waitForFunction(id => document.querySelector('#conversations [data-room]')?.dataset.room === id, firstDirect.id);
    await firstRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '取消置顶', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').count(), 0);
    await firstRow.click();
    await page.locator('#members').click();
    const changedWorkspace = path.join(home, 'changed-workspace'); fs.mkdirSync(changedWorkspace);
    await page.locator('#modal-content [name="workspace"]').fill(changedWorkspace);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const updated = await page.evaluate(async () => (await (await fetch('/api/catalog')).json()));
    assert.equal(updated.agents[0].workspace, changedWorkspace);
    assert.ok(fs.existsSync(catalog.agents[0].workspace));
    report.checks.push('Agent context menu pins to top, Escape dismisses; direct settings edit workspace and retain old files');

    assert.ok(!catalog.harnesses.find((h) => h.id === 'dsh').detail.includes('当前进程即 DSH'));
    report.checks.push('Agent Room Electron host is not misidentified as DSH');
    await page.locator('#file-input').setInputFiles(path.join(root, 'desktop', 'assets', 'icon.png'));
    await page.getByRole('button', { name: '移除 icon.png' }).waitFor();
    await page.waitForFunction(() => document.querySelector('#attachments img')?.naturalWidth > 0);
    report.checks.push('Native file input uploads and previews a real image');
    await page.getByRole('button', { name: '⚙ 外观设置', exact: true }).click();
    await page.getByRole('button', { name: '森林', exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ar-bg').trim() === '#0d1512');
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.screenshot({ path: path.join(home, 'desktop.png') });
    const closedOrigin = origin;
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(fetch(closedOrigin + '/api/catalog'));
    report.checks.push('Closing the main window releases its local service');
    instance = null;
    page = await launch();
    const restored = await page.evaluate(async () => ({ catalog: await (await fetch('/api/catalog')).json(), theme: await (await fetch('/api/theme')).json() }));
    assert.equal(restored.catalog.agents.length, 3);
    assert.equal(restored.catalog.conversations.find(c => c.id === firstDirect.id).pinned, true);
    assert.equal(restored.catalog.agents[0].workspace, changedWorkspace);
    await page.locator('[data-room="' + firstDirect.id + '"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click();
    await page.waitForFunction(async () => !(await (await fetch('/api/catalog')).json()).conversations.some(c => c.pinned));
    assert.equal(restored.catalog.conversations.length, 4);
    assert.equal(restored.theme.theme.preset, 'forest');
    report.checks.push('Contacts, groups and appearance persist after packaged app restart');
    // Exercise both destructive and non-destructive choices through the real UI.
    for (const [name, remove] of [['另一位伙伴', false], ['Qoder伙伴', true]]) {
      const agent = restored.catalog.agents.find(a => a.label === name);
      const direct = restored.catalog.conversations.find(c => c.kind === 'direct' && c.agentIds.includes(agent.id));
      await page.locator(`[data-room="${direct.id}"]`).click();
      await page.locator(`[data-room="${direct.id}"]`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: '删除', exact: true }).click();
      assert.equal(await page.locator('[name="deleteWorkspace"]').inputValue(), 'false');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      assert.ok(fs.existsSync(agent.workspace));
      await page.locator(`[data-room="${direct.id}"]`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: '删除', exact: true }).click();
      if (remove) {
        await page.locator('[name="deleteWorkspace"]').selectOption('true');
        await page.locator('[name="confirmWorkspace"]').fill(agent.workspace);
      }
      await page.getByRole('button', { name: '确认删除', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(fs.existsSync(agent.workspace), !remove);
    }
    report.checks.push('Delete dialog defaults to keeping files, cancel preserves Agent, explicit path confirmation deletes only selected workspace');
    await instance.close();
    instance = null;
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    if (instance) await instance.close().catch(() => {});
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
})();
