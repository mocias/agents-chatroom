'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { samePath } = require('./desktop-state.cjs');
const { replaceFile } = require('./native-files.cjs');
const run = promisify(execFile);
const requiredColumns = ['id', 'cwd', 'user_id', 'title', 'custom_title', 'status', 'created_at', 'updated_at', 'last_activity_at', 'deleted_at', 'is_playground', 'source_mode', 'mode', 'transport', 'session_settings'];
function validateSchema(db) {
  const columns = db.prepare('PRAGMA table_info(sessions)').all();
  if (!requiredColumns.every(n => columns.some(c => c.name === n))) throw Error('此 WorkBuddy 数据库版本尚未适配，未修改');
  const supplied = new Set(['id', 'cwd', 'user_id', 'title', 'custom_title', 'status', 'created_at', 'updated_at', 'last_activity_at', 'is_playground', 'source_mode', 'mode', 'transport']);
  if (columns.some(c => c.notnull && c.dflt_value === null && !supplied.has(c.name))) throw Error('WorkBuddy 新版本存在未知必填字段，未修改');
}
function existingTask(db, workspace, userId, pinned = []) {
  return db.prepare("SELECT id, cwd FROM sessions WHERE user_id = ? AND transport = 'local' AND deleted_at IS NULL AND status != 'archived' AND is_playground = 0").all(userId).find(r => !pinned.includes(r.id) && samePath(r.cwd, workspace));
}
function validateBinding(binding) {
  if (!/^[a-f0-9-]{36}$/i.test(binding.userId)) throw Error('不支持的 WorkBuddy 账号目录格式');
  const snapshot = JSON.parse(fs.readFileSync(binding.snapshotFile, 'utf8'));
  if (snapshot.version !== 3 || !Array.isArray(snapshot.items)) throw Error('不兼容的 WorkBuddy 账号快照');
  return snapshot.items.filter(i => i.isPinned).map(i => i.id);
}
function resolveBinding(agent, launch, dataDir) {
  const file = path.join(dataDir, 'desktop-sync', 'bindings.json');
  const bindings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const explicit = bindings[agent.backend];
  if (explicit?.snapshotFile) {
    const accountDir = path.dirname(explicit.snapshotFile), configDir = path.dirname(accountDir);
    if (!launch.workbuddyConfigCandidates?.some(p => samePath(p, configDir))) throw Error('WorkBuddy 索引与当前后端配置不匹配');
    return { configDir, userId: path.basename(accountDir), databaseFile: path.join(configDir, 'workbuddy.db'), snapshotFile: explicit.snapshotFile };
  }
  // Auto-bind only an unambiguous installation/account. Do not infer identity
  // from newest file timestamps or copy authentication material.
  const candidates = [];
  const expected = agent.backend === 'workbuddy-ai' ? '.workbuddy-ai' : '.workbuddy';
  for (const configDir of launch.workbuddyConfigCandidates || []) {
    if (path.basename(configDir) !== expected || !fs.existsSync(configDir)) continue;
    for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const snapshotFile = path.join(configDir, entry.name, 'sidebar-list-snapshot.json');
      if (!fs.existsSync(snapshotFile) || !fs.existsSync(path.join(configDir, 'workbuddy.db'))) continue;
      const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      if (snapshot.version === 3 && Array.isArray(snapshot.items)) candidates.push({ configDir, userId: entry.name, snapshotFile, databaseFile: path.join(configDir, 'workbuddy.db') });
    }
  }
  if (candidates.length !== 1) throw Error('无法唯一确定 WorkBuddy 账号，请在本机索引绑定中选择账号');
  const binding = candidates[0];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  replaceFile(file, raw, JSON.stringify({ ...bindings, [agent.backend]: { snapshotFile: binding.snapshotFile } }, null, 2) + '\n');
  return binding;
}
async function desktopRunning() {
  if (process.platform !== 'win32') throw Error('WorkBuddy 自动登记目前只支持 Windows');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name WorkBuddy,WorkBuddyAI -ErrorAction SilentlyContinue).Count"], { windowsHide: true, timeout: 10000 });
  if (!/^\d+$/.test(stdout.trim())) throw Error('无法确认 WorkBuddy 已退出');
  return Number(stdout.trim()) > 0;
}
function pendingFile(dataDir) { return path.join(dataDir, 'desktop-sync', 'workbuddy-pending.json'); }
function enqueue(dataDir, agent, launch) {
  const binding = resolveBinding(agent, launch, dataDir);
  const pinned = validateBinding(binding);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(binding.databaseFile, { readOnly: true });
  try {
    validateSchema(db);
    const task = existingTask(db, agent.workspace, binding.userId, pinned);
    if (task) return { status: 'workspace-registered', workspaceRegistered: true, nativeTaskIds: [task.id],
      detail: 'WorkBuddy 原生任务索引已包含此工作区；ACP 历史尚未导入。' };
  } finally { db.close(); }
  const file = pendingFile(dataDir);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const queue = raw ? JSON.parse(raw) : { version: 1, jobs: [] };
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的 WorkBuddy 登记队列');
  const prior = queue.jobs.find(j => j.agentId === agent.id && j.userId === binding.userId && samePath(j.workspace, agent.workspace));
  queue.jobs = [...queue.jobs.filter(j => j.agentId !== agent.id), { ...binding, agentId: agent.id, backend: agent.backend, workspace: agent.workspace,
    taskId: prior?.taskId || randomUUID(), title: agent.label + ' · Agent Room 工作区登记' }];
  replaceFile(file, raw, JSON.stringify(queue, null, 2) + '\n');
  return { status: 'waiting-for-exit', workspaceRegistered: false,
    detail: '已排队创建空的原生登记任务，不发送模型消息。完全退出 WorkBuddy（包括托盘）后自动登记，重新打开后检查显示。ACP 历史仍独立保存。' };
}
async function registerTask(job, options = {}) {
  const { DatabaseSync, backup } = require('node:sqlite');
  if (!fs.statSync(job.workspace).isDirectory()) throw Error('WorkBuddy 工作区不存在');
  const db = new DatabaseSync(job.databaseFile);
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    validateSchema(db);
    const pinned = job.snapshotFile ? validateBinding(job) : [];
    const existing = existingTask(db, job.workspace, job.userId, pinned);
    if (existing) return existing.id;
    await backup(db, job.databaseFile + '.before-agent-room-' + Date.now() + '-' + randomUUID());
    if (await (options.running || desktopRunning)()) throw Error('WorkBuddy 已重新启动，等待再次退出');
    db.exec('BEGIN IMMEDIATE');
    try {
      const found = existingTask(db, job.workspace, job.userId, pinned);
      if (found) { db.exec('ROLLBACK'); return found.id; }
      // Mirrors LocalConversationsImpl.insertConversation in WorkBuddy 5.8.4.
      // No transcript is fabricated, no permission/trust setting is changed.
      const now = Date.now();
      db.prepare(`INSERT INTO sessions (id,cwd,user_id,title,custom_title,status,created_at,updated_at,last_activity_at,is_playground,source_mode,mode,transport)
        VALUES (?,?,?,?,?,'active',?,?,?,0,'craft','craft','local')`).run(job.taskId, job.workspace.replace(/\\/g, '/'), job.userId, job.title, job.title, now, now, now);
      db.exec('COMMIT');
      return job.taskId;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  } finally { db.close(); }
}
async function flush(dataDir, options = {}) {
  const file = pendingFile(dataDir);
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8'), queue = JSON.parse(raw);
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的 WorkBuddy 登记队列');
  if (!queue.jobs.length || await (options.running || desktopRunning)()) return;
  const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8'));
  for (const job of queue.jobs) {
    if (!catalog.agents.some(a => a.id === job.agentId && a.backend === job.backend && samePath(a.workspace, job.workspace))) continue;
    const bindings = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-sync', 'bindings.json'), 'utf8'));
    if (!samePath(bindings[job.backend]?.snapshotFile, job.snapshotFile)) throw Error('WorkBuddy 账号绑定已更改，需要重新检查登记');
    await registerTask(job, options);
  }
  replaceFile(file, raw, JSON.stringify({ version: 1, jobs: [] }, null, 2) + '\n');
}
module.exports = { enqueue, flush, registerTask, resolveBinding, validateSchema, existingTask, desktopRunning };
