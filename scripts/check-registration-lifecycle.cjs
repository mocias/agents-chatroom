'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
const codex = require('../standalone/codex-desktop-registration.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const home = fs.mkdtempSync(path.resolve('output/registration-lifecycle-'));
  const data = path.join(home, 'queue'), native = path.join(home, 'native'), workspace = path.join(home, 'workspace');
  for (const dir of [data, native, workspace]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(data, 'catalog.json'), JSON.stringify({ agents: [{ id: 'a', backend: 'codex', workspace }], conversations: [] }));
  const target = path.join(native, '.codex-global-state.json');
  fs.writeFileSync(target, JSON.stringify({ unrelated: 'preserved' }));
  const blocker = path.join(home, 'backend-running'); fs.writeFileSync(blocker, '1');
  codex.enqueue(data, { id: 'a', backend: 'codex', workspace, label: 'Lifecycle' }, 'project', { env: { CODEX_HOME: native } });
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: path.join(home, 'app'), AGENT_ROOM_WORKSPACE_ROOT: path.join(home, 'agents') }; delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  async function launch() {
    desktop = await _electron.launch({ executablePath: process.env.SMOKE_EXECUTABLE || path.resolve('dist/win-unpacked/Agent Room.exe'), env });
    const page = await desktop.firstWindow();
    await page.getByRole('button', { name: '添加 Agent', exact: true }).waitFor();
    await page.getByText('本地已连接', { exact: true }).waitFor();
    await desktop.evaluate(async ({ app }, { data, blocker }) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const fs = require('node:fs'), path = require('node:path');
      const root = app.getAppPath();
      globalThis.registrationTestDispatcher = require(path.join(root, 'standalone/registration-dispatcher.cjs')).createDispatcher(data, {
        intervalMs: 50,
        flush: () => require(path.join(root, 'standalone/codex-desktop-registration.cjs')).flush(data, { running: async () => fs.existsSync(blocker) }),
      });
      await globalThis.registrationTestDispatcher.kick();
    }, { data, blocker });
  }
  try {
    await launch(); const pid = desktop.process().pid;
    await desktop.close(); desktop = null;
    assert.throws(() => process.kill(pid, 0));
    fs.unlinkSync(blocker); await wait(1000);
    assert.equal(JSON.parse(fs.readFileSync(target))['local-projects'], undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'desktop-sync/codex-pending.json'))).jobs.length, 1);
    await launch();
    assert.ok(JSON.parse(fs.readFileSync(target))['local-projects'].project);
    assert.equal(JSON.parse(fs.readFileSync(target)).unrelated, 'preserved');
    await desktop.close(); desktop = null;
    assert.equal(fs.existsSync(path.join(data, 'desktop-sync/worker')), false);
    const report = { ok: true, home, packagedParentExited: true, registrationPausedAfterExit: true, pendingQueuePreserved: true, resumedOnReopen: true, noDetachedWorker: true, realModelCalls: 0 };
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { if (desktop) await desktop.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
