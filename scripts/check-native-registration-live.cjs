'use strict';
// Explicit opt-in smoke test against native stores. Only inserts its own empty
// verification rows. Run `prepare`, inspect the restarted apps, then `cleanup`
// while they are closed. No prompts or model calls are made.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const qoder = require('../standalone/qoder-desktop-registration.cjs');
const wb = require('../standalone/workbuddy-desktop-registration.cjs');
function requireClosed() {
  const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name WorkBuddyAI,WorkBuddy,'Qoder CN',Qoder -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8', windowsHide: true }).trim();
  if (value !== '0') throw Error('Fully exit WorkBuddy and Qoder first');
}
(async () => {
  const [mode, arg] = process.argv.slice(2);
  requireClosed();
  if (mode === 'prepare') {
    const source = path.resolve(arg), root = fs.mkdtempSync(path.resolve('output/native-registration-live-'));
    const bindings = JSON.parse(fs.readFileSync(path.join(source, 'desktop-sync/bindings.json')));
    fs.mkdirSync(path.join(root, 'desktop-sync')); fs.writeFileSync(path.join(root, 'desktop-sync/bindings.json'), JSON.stringify(bindings));
    const agents = ['qoder', 'workbuddy-ai'].map(backend => ({ id: randomUUID(), backend, label: backend + ' 自动登记验证', workspace: path.join(root, backend + '-自动登记验证') }));
    for (const agent of agents) fs.mkdirSync(agent.workspace);
    fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ agents, conversations: [] }));
    qoder.enqueue(root, agents[0], {});
    wb.enqueue(root, agents[1], { workbuddyConfigCandidates: [path.dirname(path.dirname(bindings['workbuddy-ai'].snapshotFile))] });
    const qJob = JSON.parse(fs.readFileSync(path.join(root, 'desktop-sync/qoder-pending.json'))).jobs[0];
    const wJob = JSON.parse(fs.readFileSync(path.join(root, 'desktop-sync/workbuddy-pending.json'))).jobs[0];
    const before = {};
    for (const [key, job, table] of [['qoder', qJob, 'workspaces'], ['workbuddy', wJob, 'sessions']]) {
      const db = new DatabaseSync(job.databaseFile, { readOnly: true }); before[key] = db.prepare('SELECT * FROM ' + table).all(); db.close();
    }
    // Save identity before mutation so an interrupted test can be cleaned up.
    fs.writeFileSync(path.join(root, 'test-records.json'), JSON.stringify({ qJob, wJob }, null, 2));
    await qoder.flush(root); await wb.flush(root);
    for (const [key, job, table, column, id] of [['qoder', qJob, 'workspaces', 'workspace_id', qJob.workspaceId], ['workbuddy', wJob, 'sessions', 'id', wJob.taskId]]) {
      const db = new DatabaseSync(job.databaseFile, { readOnly: true });
      const rows = db.prepare('SELECT * FROM ' + table).all().filter(row => row[column] !== id); db.close();
      require('node:assert/strict').deepEqual(rows, before[key]);
    }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ root, existingRowsUnchanged: true, modelCalls: 0, nativeUiVerified: false }, null, 2));
    console.log(JSON.stringify({ root, qoderWorkspaceId: qJob.workspaceId, workbuddyTaskId: wJob.taskId, existingRowsUnchanged: true }));
  } else if (mode === 'cleanup') {
    const root = path.resolve(arg), jobs = JSON.parse(fs.readFileSync(path.join(root, 'test-records.json')));
    for (const [key, table, column, idField] of [['qJob', 'workspaces', 'workspace_id', 'workspaceId'], ['wJob', 'sessions', 'id', 'taskId']]) {
      const job = jobs[key];
      if (path.dirname(path.resolve(job.workspace)) !== root || !path.basename(root).startsWith('native-registration-live-')) throw Error('Unexpected verification workspace');
      const db = new DatabaseSync(job.databaseFile);
      try {
        const row = db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).get(job[idField]);
        if (!row) continue;
        const cwd = key === 'qJob' ? JSON.parse(row.root_paths_json)[0] : row.cwd;
        if (!require('../standalone/desktop-state.cjs').samePath(cwd, job.workspace)) throw Error('Test row changed directories');
        await backup(db, job.databaseFile + '.before-agent-room-cleanup-' + Date.now()); requireClosed();
        db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(job[idField]);
      } finally { db.close(); }
    }
    const reportFile = path.join(root, 'report.json'), report = JSON.parse(fs.readFileSync(reportFile));
    fs.writeFileSync(reportFile, JSON.stringify({ ...report, testRowsRemoved: true }, null, 2));
    console.log(JSON.stringify({ root, testRowsRemoved: true }));
  } else throw Error('Usage: prepare <Room data> | cleanup <test root>');
})().catch(error => { console.error(error); process.exitCode = 1; });
