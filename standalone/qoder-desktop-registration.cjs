'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { samePath } = require('./desktop-state.cjs');
const { replaceFile } = require('./native-files.cjs');
const run = promisify(execFile);
function validateSchema(db) {
  const columns = db.prepare('PRAGMA table_info(workspaces)').all();
  const fields = ['workspace_id', 'name', 'workspace_source', 'root_paths_json', 'product_mode', 'extra_json', 'created_at', 'updated_at', 'archived', 'deleted_at'];
  if (!fields.every(f => columns.some(c => c.name === f)) || columns.some(c => c.notnull && c.dflt_value === null && !fields.includes(c.name))) throw Error('此 Qoder 工作区存储版本尚未适配，未修改');
}
function workspaceRows(db, workspace) {
  return db.prepare('SELECT workspace_id,root_paths_json,archived,deleted_at FROM workspaces WHERE workspace_source = ?').all('local')
    .filter(r => JSON.parse(r.root_paths_json).some(p => samePath(p, workspace)));
}
function resolveBinding(launch, dataDir) {
  const file = path.join(dataDir, 'desktop-sync/bindings.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const bindings = raw ? JSON.parse(raw) : {};
  if (bindings.qoder?.databaseFile) return bindings.qoder;
  const exe = path.basename(launch?.agentCommand || '');
  if (!/^Qoder(?: CN)?\.exe$/i.test(exe)) throw Error('Qoder CLI 不提供桌面索引；请配置 Qoder 桌面入口');
  const profile = /^Qoder CN/i.test(exe) ? 'com.qodercn.app.stable' : 'com.qoder.app.stable';
  const databaseFile = path.join(process.env.APPDATA || '', profile, 'main.sqlite');
  if (!fs.existsSync(databaseFile)) throw Error('请先打开对应版本的 Qoder 桌面以生成配置');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const binding = { databaseFile };
  replaceFile(file, raw, JSON.stringify({ ...bindings, qoder: binding }, null, 2) + '\n');
  return binding;
}
async function desktopRunning() {
  if (process.platform !== 'win32') throw Error('Qoder 自动登记目前只支持 Windows');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name Qoder,'Qoder CN' -ErrorAction SilentlyContinue).Count"], { windowsHide: true, timeout: 10000 });
  if (!/^\d+$/.test(stdout.trim())) throw Error('无法确认 Qoder 已退出');
  return Number(stdout.trim()) > 0;
}
function enqueue(dataDir, agent, launch) {
  const binding = resolveBinding(launch, dataDir);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(binding.databaseFile, { readOnly: true });
  try {
    validateSchema(db);
    const rows = workspaceRows(db, agent.workspace), active = rows.find(r => !r.archived && r.deleted_at === null);
    if (active) return { status: 'workspace-registered', workspaceRegistered: true, workspaceId: active.workspace_id, detail: 'Qoder 原生工作区已登记；ACP 对话历史尚未导入。' };
    if (rows.length) throw Error('Qoder 中此工作区已被归档或删除，请在 Qoder 中恢复；不会自动覆盖此选择');
  } finally { db.close(); }
  const file = path.join(dataDir, 'desktop-sync/qoder-pending.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const queue = raw ? JSON.parse(raw) : { version: 1, jobs: [] };
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的 Qoder 登记队列');
  const previous = queue.jobs.find(j => j.agentId === agent.id && samePath(j.workspace, agent.workspace));
  queue.jobs = [...queue.jobs.filter(j => j.agentId !== agent.id), { ...binding, agentId: agent.id, workspace: agent.workspace, label: agent.label, workspaceId: previous?.workspaceId || randomUUID() }];
  replaceFile(file, raw, JSON.stringify(queue, null, 2) + '\n');
  return { status: 'waiting-for-exit', workspaceRegistered: false, detail: 'Qoder 工作区登记已排队。保持 Agent Room 运行，完全退出 Qoder 后自动补齐，再打开查看；ACP 历史尚未导入。' };
}
async function registerWorkspace(job, options = {}) {
  const { DatabaseSync, backup } = require('node:sqlite');
  if (!fs.statSync(job.workspace).isDirectory()) throw Error('Qoder 工作区目录不存在');
  if (await (options.running || desktopRunning)()) throw Error('Qoder 正在运行，等待退出');
  const db = new DatabaseSync(job.databaseFile);
  try {
    db.exec('PRAGMA busy_timeout = 3000'); validateSchema(db);
    let rows = workspaceRows(db, job.workspace), active = rows.find(r => !r.archived && r.deleted_at === null);
    if (active) return active.workspace_id;
    if (rows.length) throw Error('Qoder 此目录的工作区已被归档或删除');
    await backup(db, job.databaseFile + '.before-agent-room-' + Date.now() + '-' + randomUUID());
    if (await (options.running || desktopRunning)()) throw Error('Qoder 已重新启动，等待再次退出');
    db.exec('BEGIN IMMEDIATE');
    try {
      rows = workspaceRows(db, job.workspace); active = rows.find(r => !r.archived && r.deleted_at === null);
      if (active) { db.exec('ROLLBACK'); return active.workspace_id; }
      if (rows.length) throw Error('Qoder 工作区状态已变化');
      const now = Date.now();
      db.prepare(`INSERT INTO workspaces(workspace_id,name,workspace_source,root_paths_json,product_mode,extra_json,created_at,updated_at,archived,deleted_at)
        VALUES (?,?,'local',?,'coding',?,?,?,0,NULL)`).run(job.workspaceId, job.label, JSON.stringify([path.resolve(job.workspace)]), JSON.stringify({ workspaceIcon: 'folder', workspaceColor: 'primary' }), now, now);
      db.exec('COMMIT'); return job.workspaceId;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  } finally { db.close(); }
}
async function flush(dataDir, options = {}) {
  const file = path.join(dataDir, 'desktop-sync/qoder-pending.json');
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8'), queue = JSON.parse(raw);
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的 Qoder 登记队列');
  if (!queue.jobs.length || await (options.running || desktopRunning)()) return;
  const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json')));
  for (const job of queue.jobs) {
    if (!catalog.agents.some(a => a.id === job.agentId && a.backend === 'qoder' && samePath(a.workspace, job.workspace))) continue;
    const binding = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-sync/bindings.json'))).qoder;
    if (!samePath(binding?.databaseFile, job.databaseFile)) throw Error('Qoder 索引绑定已变化，请重新检查登记');
    await registerWorkspace(job, options);
  }
  replaceFile(file, raw, JSON.stringify({ version: 1, jobs: [] }, null, 2) + '\n');
}
module.exports = { enqueue, flush, registerWorkspace, validateSchema, workspaceRows };
