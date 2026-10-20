'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { samePath, nativeIds } = require('./desktop-state.cjs');
const { replaceFile } = require('./native-files.cjs');
const { selectedProfile } = require('./claude-desktop.cjs');
const run = promisify(execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function resolveBinding(launch, dataDir) {
  const native = JSON.parse(launch.agentArgs[1]);
  if (!native.desktopDataDir || !native.desktopExecutable) return null;
  const desktopDataDir = native.desktopDataDir;
  selectedProfile(desktopDataDir); // API profile identity is not the session org.
  const root = path.join(desktopDataDir, 'claude-code-sessions');
  const file = path.join(dataDir, 'desktop-sync/bindings.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const bindings = raw ? JSON.parse(raw) : {};
  const prior = bindings.claude;
  const candidates = [];
  for (const account of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
    if (!account.isDirectory() || account.isSymbolicLink() || !UUID.test(account.name)) continue;
    for (const org of fs.readdirSync(path.join(root, account.name), { withFileTypes: true })) {
      if (!org.isDirectory() || org.isSymbolicLink() || !UUID.test(org.name)) continue;
      const sessionsDir = path.join(root, account.name, org.name), marker = sessionsDir + '.profile-origin.json';
      if (!fs.existsSync(marker)) continue;
      const origin = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (origin.mode === 'local' && origin.org === org.name) candidates.push({ accountId: account.name, orgId: org.name, sessionsDir });
    }
  }
  const explicit = prior && samePath(prior.desktopDataDir, desktopDataDir) && candidates.find(c => c.accountId === prior.accountId && c.orgId === prior.orgId && samePath(c.sessionsDir, prior.sessionsDir));
  const selected = explicit || (candidates.length === 1 && candidates[0]);
  if (!selected) throw Error(candidates.length ? '多个本机账号时需要明确绑定 Claude 会话目录' : '请先打开 Claude 的 Code 页面，等待原生本地会话目录生成');
  const binding = { desktopDataDir, desktopExecutable: native.desktopExecutable, ...selected,
    cliHome: launch.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceFile(file, raw, JSON.stringify({ ...bindings, claude: binding }, null, 2) + '\n');
  return binding;
}
function workspaceSessions(binding, workspace, includeArchived = false) {
  if (!fs.existsSync(binding.sessionsDir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(binding.sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('local_') || !entry.name.endsWith('.json') || !UUID.test(entry.name.slice(6, -5))) continue;
    const record = JSON.parse(fs.readFileSync(path.join(binding.sessionsDir, entry.name), 'utf8'));
    if (record.sessionId !== entry.name.slice(0, -5) || !UUID.test(record.cliSessionId) || !samePath(record.cwd, workspace) || (!includeArchived && record.isArchived)) continue;
    rows.push({ id: record.sessionId, cliSessionId: record.cliSessionId });
  }
  return rows;
}
function importedSession(binding, id, workspace) {
  return UUID.test(id) ? workspaceSessions(binding, workspace).find(row => row.cliSessionId === id) || null : null;
}
function transcriptExists(binding, id, workspace) {
  if (!UUID.test(id)) return false;
  const projects = path.join(binding.cliHome, 'projects');
  if (!fs.existsSync(projects)) return false;
  for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
    const file = path.join(projects, dir.name, id + '.jsonl');
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(128 * 1024), length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      for (const line of buffer.toString('utf8', 0, length).split('\n')) {
        try { const row = JSON.parse(line); if (row.sessionId === id && samePath(row.cwd, workspace)) return true; } catch {}
      }
    } finally { fs.closeSync(fd); }
  }
  return false;
}
async function processState(binding, ids) {
  if (process.platform !== 'win32') throw Error('Claude 桌面自动导入目前只验证 Windows');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -Filter "Name='Claude.exe'")
if (@($rows | Where-Object { -not $_.ExecutablePath -or -not $_.CommandLine }).Count) { throw 'Cannot inspect Claude process ownership' }
$ids = ConvertFrom-Json $env:AGENT_ROOM_CLAUDE_SESSION_IDS
$desktop = @($rows | Where-Object { $_.ExecutablePath -eq $env:AGENT_ROOM_CLAUDE_DESKTOP_EXE }).Count -gt 0
$busy = @($ids | Where-Object { $id = $_; @($rows | Where-Object { $_.ExecutablePath -ne $env:AGENT_ROOM_CLAUDE_DESKTOP_EXE -and $_.CommandLine -and $_.CommandLine.Contains($id) }).Count -gt 0 })
@{ desktopRunning = $desktop; busySessionIds = $busy } | ConvertTo-Json -Compress`;
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000,
    env: { ...process.env, AGENT_ROOM_CLAUDE_DESKTOP_EXE: binding.desktopExecutable, AGENT_ROOM_CLAUDE_SESSION_IDS: JSON.stringify(ids) } });
  const state = JSON.parse(stdout);
  if (typeof state.desktopRunning !== 'boolean' || !Array.isArray(state.busySessionIds)) throw Error('无法确认 Claude 会话运行状态');
  return state;
}
async function openNativeImport(binding, id) {
  if (!UUID.test(id)) throw Error('无效的 Claude 会话 ID');
  const child = spawn(binding.desktopExecutable, ['claude://resume?session=' + id], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
function enqueue(dataDir, agent, launch, conversations = []) {
  const binding = resolveBinding(launch, dataDir);
  if (!binding) return { status: 'cli-only', workspaceRegistered: false, detail: '已配置 Claude Code 终端后端；自动导入桌面需选择兼容的 Claude 桌面入口。' };
  const file = path.join(dataDir, 'desktop-sync/claude-pending.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const queue = raw ? JSON.parse(raw) : { version: 1, jobs: [] };
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的 Claude 登记队列');
  const prior = queue.jobs.find(j => j.agentId === agent.id && samePath(j.workspace, agent.workspace) && samePath(j.sessionsDir, binding.sessionsDir));
  const ids = [...new Set([...nativeIds(agent, conversations), ...(prior?.sessionIds || [])])].filter(id => UUID.test(id));
  const imported = workspaceSessions(binding, agent.workspace);
  const missing = ids.filter(id => !imported.some(s => s.cliSessionId === id));
  if (!missing.length) {
    if (raw && queue.jobs.some(j => j.agentId === agent.id)) replaceFile(file, raw, JSON.stringify({ version: 1, jobs: queue.jobs.filter(j => j.agentId !== agent.id) }, null, 2) + '\n');
    return { status: imported.length ? 'registered' : 'waiting-for-session', workspaceRegistered: imported.length > 0, nativeTaskIds: imported.map(s => s.id),
      detail: imported.length ? 'Claude Code 工作区与已有对话已通过原生入口导入桌面。' : '等待首次 Claude Code 对话产生原生记录；无需另建工作区或发送占位消息。' };
  }
  queue.jobs = [...queue.jobs.filter(j => j.agentId !== agent.id), { ...binding, agentId: agent.id, workspace: agent.workspace, sessionIds: missing, attempted: prior?.attempted || {} }];
  replaceFile(file, raw, JSON.stringify(queue, null, 2) + '\n');
  return { status: 'waiting-for-desktop', workspaceRegistered: imported.length > 0, detail: '已排队通过 Claude 原生入口导入。打开 Claude 桌面且对应 CLI 会话退出后自动执行，不发送新消息。' };
}
async function flush(dataDir, options = {}) {
  const file = path.join(dataDir, 'desktop-sync/claude-pending.json');
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8'), queue = JSON.parse(raw);
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的 Claude 登记队列');
  if (!queue.jobs.length) return;
  const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'))), remaining = [];
  const bindings = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-sync/bindings.json')));
  for (const job of queue.jobs) {
    if (!catalog.agents.some(a => a.id === job.agentId && a.backend === 'claude' && samePath(a.workspace, job.workspace))) continue;
    if (!samePath(bindings.claude?.sessionsDir, job.sessionsDir)) throw Error('Claude 账号绑定已变化，请重新检查登记');
    const ids = job.sessionIds.filter(id => !importedSession(job, id, job.workspace));
    if (!ids.length) continue;
    const state = await (options.processState || processState)(job, ids);
    for (const id of ids) {
      if (!state.desktopRunning || state.busySessionIds.includes(id) || Date.now() - (job.attempted[id] || 0) < 60000) continue;
      // Never silently unarchive a desktop session or adopt another directory.
      if (fs.existsSync(path.join(job.sessionsDir, 'local_' + id + '.json')) || workspaceSessions(job, job.workspace, true).some(s => s.cliSessionId === id)) continue;
      if (!transcriptExists(job, id, job.workspace)) continue;
      if (fs.readFileSync(file, 'utf8') !== raw) return;
      await (options.openNativeImport || openNativeImport)(job, id);
      job.attempted[id] = Date.now();
    }
    remaining.push({ ...job, sessionIds: ids });
  }
  replaceFile(file, raw, JSON.stringify({ version: 1, jobs: remaining }, null, 2) + '\n');
}
module.exports = { enqueue, flush, importedSession, workspaceSessions, transcriptExists, resolveBinding };
