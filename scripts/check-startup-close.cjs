'use strict';
// Exercise the real main entry with a shutdown during its initial loadURL.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
(async () => {
  const home = fs.mkdtempSync(path.resolve('output/startup-close-'));
  const reportFile = path.join(home, 'events.jsonl'), bootstrap = path.join(home, 'bootstrap.cjs');
  fs.writeFileSync(bootstrap, `
    const { app, BrowserWindow, dialog } = require('electron');
    const fs = require('node:fs');
    const log = event => fs.appendFileSync(${JSON.stringify(reportFile)}, JSON.stringify(event) + '\\n');
    dialog.showErrorBox = (title, message) => log({type:'error-dialog',title,message});
    const original = BrowserWindow.prototype.loadURL;
    BrowserWindow.prototype.loadURL = function(url, ...args) {
      log({type:'load',url});
      const loading = original.call(this, url, ...args);
      app.quit();
      return loading;
    };
    require(${JSON.stringify(path.resolve('desktop/main.cjs'))});
  `);
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: path.join(home, 'app'), AGENT_ROOM_WORKSPACE_ROOT: path.join(home, 'agents') }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [bootstrap], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.stdout.resume();
  const timeout = setTimeout(() => child.kill(), 20000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); clearTimeout(timeout);
  const events = fs.readFileSync(reportFile, 'utf8').trim().split('\n').map(JSON.parse);
  fs.writeFileSync(path.join(home, 'stderr.log'), stderr);
  assert.equal(code, 0, stderr); assert.ok(events.some(event => event.type === 'load'));
  assert.deepEqual(events.filter(event => event.type === 'error-dialog'), [], JSON.stringify(events));
  console.log(JSON.stringify({ ok: true, home, noStartupErrorOnClose: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
