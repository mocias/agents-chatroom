'use strict';
// Read native registration evidence. Never manufacture desktop database rows.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function codexDesktopProject(agent, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  try {
    const state = json(path.join(home, '.codex-global-state.json'));
    const mappings = state['app-server-project-id-by-legacy-project-id-by-host'] || {};
    const host = Object.keys(mappings).find(key => key.startsWith('local:') && samePath(key.slice(6), home));
    for (const [id, project] of Object.entries(state['local-projects'] || {})) {
      if (project.rootPaths?.some(root => samePath(root, agent.workspace))) {
        const projectId = mappings[host]?.[id];
        if (projectId) return { desktopProjectId: id, projectId };
      }
    }
  } catch {}
  return null;
}
function nativeIds(agent, conversations = []) {
  return [...new Set(conversations.map(c => c.nativeSessions?.[agent.id]).filter(s => s?.backend === agent.backend && s.id).map(s => s.id))];
}
function inspectDesktop(agent, options = {}) {
  const pending = detail => ({ status: 'pending', workspaceRegistered: false, detail });
  try {
    if (options.dataDir && ['codex', 'qoder', 'workbuddy', 'workbuddy-ai'].includes(agent.backend)) {
      const backend = ['codex', 'qoder'].includes(agent.backend) ? agent.backend : 'workbuddy';
      const file = path.join(options.dataDir, 'desktop-sync', backend + '-pending.json');
      if (fs.existsSync(file) && json(file).jobs?.some(j => j.agentId === agent.id && samePath(j.workspace, agent.workspace))) {
        const errors = path.join(options.dataDir, 'desktop-sync', 'registration-errors.json');
        const error = fs.existsSync(errors) && json(errors)[backend];
        if (error) return { status: 'error', workspaceRegistered: false, detail: '自动登记暂未完成，将重试：' + error };
        // Existing native registrations remain visible while their session
        // mappings are waiting to be refreshed after exit.
        if (backend !== 'codex' || !codexDesktopProject(agent, options.codexHome)) return { status: 'waiting-for-exit', workspaceRegistered: false,
          detail: '登记任务已保存。保持 Agent Room 运行，完全退出对应桌面（包括托盘）后自动补齐，再打开查看。' };
      }
    }
    if (agent.backend === 'codex') {
      const project = codexDesktopProject(agent, options.codexHome);
      return project ? { ...project, status: 'workspace-registered', workspaceRegistered: true,
        detail: 'Codex 桌面项目已登记；新对话将复用此项目。已有对话归属可通过“检查桌面登记”核对。' }
        : { status: 'waiting-for-exit', workspaceRegistered: false, detail: '点击检查桌面登记以排队；保持 Agent Room 运行，完全退出 Codex 后自动补齐，再打开 Codex 查看。' };
    }
    if (agent.backend === 'dsh') {
      if (!options.dataDir) return pending('等待 Agent Room 配置内置 DSH 桥接。');
      const receiptFile = path.join(options.dataDir, 'desktop-sync', 'dsh.json');
      if (!fs.existsSync(receiptFile)) return pending('等待 DSH 加载内置桥接；点击检查桌面登记后，打开或重启 DSH，无需另装插件。');
      const receipt = json(receiptFile);
      const row = receipt.agents?.find(a => a.agentId === agent.id && samePath(a.workspace, agent.workspace));
      if (!row?.workspaceId) return pending('等待 DSH 原生工作区注册；请确认 DSH 已打开且目录桥接已配置。');
      const ids = nativeIds(agent, options.conversations);
      const complete = row.status === 'registered' && ids.every(id => row.sessions?.includes(id));
      return { status: complete ? 'registered' : 'workspace-registered', workspaceRegistered: true,
        workspaceId: row.workspaceId, checkedAt: receipt.checkedAt, sessions: row.sessions || [],
        detail: complete ? 'DSH 工作区已登记，当前已有会话已归入该工作区。' : 'DSH 工作区已登记；部分会话仍等待桌面桥接归档，请稍后检查。' };
    }
    if (!['qoder', 'workbuddy', 'workbuddy-ai', 'claude'].includes(agent.backend)) return null;
    // Explicit per-installation bindings avoid choosing a different edition or
    // account merely because its cache happens to be newer.
    const bindingsFile = options.dataDir && path.join(options.dataDir, 'desktop-sync', 'bindings.json');
    const bindings = options.bindings || (bindingsFile && fs.existsSync(bindingsFile) ? json(bindingsFile) : {});
    const binding = bindings[agent.backend];
    if (agent.backend === 'claude') {
      if (!binding?.sessionsDir) return { status: 'cli-only', workspaceRegistered: false, detail: 'Claude Code 会话已保存在终端端；选择兼容的 Claude 桌面入口后可自动导入。' };
      const { workspaceSessions } = require('./claude-desktop-registration.cjs');
      const ids = nativeIds(agent, options.conversations);
      const imported = workspaceSessions(binding, agent.workspace);
      if (imported.length && ids.every(id => imported.some(s => s.cliSessionId === id))) return { status: 'registered', workspaceRegistered: true, nativeTaskIds: imported.map(s => s.id), detail: 'Claude Code 原生桌面已保存此工作区与已有对话的导入记录。' };
      const errorFile = options.dataDir && path.join(options.dataDir, 'desktop-sync/registration-errors.json');
      const error = errorFile && fs.existsSync(errorFile) && json(errorFile).claude;
      return { status: error ? 'error' : ids.length ? 'waiting-for-desktop' : 'waiting-for-session', workspaceRegistered: imported.length > 0,
        detail: error ? 'Claude 自动导入暂未完成，将重试：' + error : ids.length ? '等待 Claude 桌面打开且对应 CLI 会话退出后，通过原生入口导入。' : '等待首次对话生成原生记录，无需发送占位消息。' };
    }
    if (agent.backend === 'qoder') {
      if (!binding?.databaseFile) return pending('点击检查桌面登记以识别 Qoder 桌面索引并排队；完全退出 Qoder 后自动补齐工作区。');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(binding.databaseFile, { readOnly: true });
      try {
        const rows = db.prepare('SELECT workspace_id, root_paths_json FROM workspaces WHERE archived = 0 AND deleted_at IS NULL').all();
        const row = rows.find(r => JSON.parse(r.root_paths_json).some(root => samePath(root, agent.workspace)));
        if (!row) return pending('Qoder 桌面索引中尚无此目录；点击检查桌面登记，然后完全退出 Qoder 等待补齐。');
        return { status: 'workspace-registered', workspaceRegistered: true, workspaceId: row.workspace_id,
          detail: 'Qoder 工作区已持久化登记；Agent Room 的 ACP 对话尚未导入 Qoder 桌面。' };
      } finally { db.close(); }
    }
    if (!binding?.snapshotFile) return pending('点击检查桌面登记以自动识别 WorkBuddy 账号并排队；多个账号时需要明确绑定账号。');
    const snapshot = json(binding.snapshotFile);
    if (snapshot.version !== 3 || !Array.isArray(snapshot.items)) throw Error('不兼容的侧栏索引');
    const tasks = snapshot.items.filter(item => item.kind === 'task' && !item.isPinned && item.space?.type === 'local' && samePath(item.space.name, agent.workspace));
    if (!tasks.length) {
      const databaseFile = path.join(path.dirname(path.dirname(binding.snapshotFile)), 'workbuddy.db');
      if (fs.existsSync(databaseFile)) {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(databaseFile, { readOnly: true });
        try {
          const { existingTask, validateSchema } = require('./workbuddy-desktop-registration.cjs');
          validateSchema(db);
          const task = existingTask(db, agent.workspace, path.basename(path.dirname(binding.snapshotFile)), snapshot.items.filter(i => i.isPinned).map(i => i.id));
          if (task) return { status: 'workspace-registered', workspaceRegistered: true, nativeTaskIds: [task.id], detail: '原生任务已持久化登记；请重新打开 WorkBuddy 核对侧栏显示。ACP 历史尚未导入。' };
        } finally { db.close(); }
      }
      return pending('尚无原生任务。点击检查桌面登记后，完全退出 WorkBuddy，程序将自动创建空登记任务。');
    }
    return { status: 'workspace-registered', workspaceRegistered: true, nativeTaskIds: tasks.map(item => item.id),
      checkedAt: new Date(snapshot.savedAt).toISOString(),
      detail: 'WorkBuddy 已保存此工作区的原生任务（已绑定账号的侧栏快照）；Agent Room 的 ACP 对话仍独立管理。' };
  } catch {
    return { status: 'unverified', workspaceRegistered: false, detail: '暂时无法读取此桌面工作区的登记记录。请打开对应桌面后重试，并核对本机索引绑定。' };
  }
}
module.exports = { samePath, codexDesktopProject, nativeIds, inspectDesktop };
