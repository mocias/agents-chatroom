'use strict';
const { CodexThreadPool } = require('../lib/codex-pool.cjs');
const { samePath, codexDesktopProject, inspectDesktop, nativeIds } = require('./desktop-state.cjs');
const { enqueue } = require('./codex-desktop-registration.cjs');
const { installBridge } = require('./dsh-desktop-registration.cjs');
const { enqueue: enqueueWorkbuddy } = require('./workbuddy-desktop-registration.cjs');
const { enqueue: enqueueQoder } = require('./qoder-desktop-registration.cjs');
const { enqueue: enqueueClaude } = require('./claude-desktop-registration.cjs');

// Project identity belongs to the Agent, not its label or the current room.
async function ensureCodexProject(pool, agent) {
  const desktop = codexDesktopProject(agent, pool.env?.CODEX_HOME);
  let fallback;
  let cursor;
  do {
    const result = await pool.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    const matches = (result.data || []).filter(p => p.roots?.some(r => samePath(r.path, agent.workspace)));
    const visible = matches.find(p => p.id === desktop?.projectId && (!p.metadata?.agentRoomAgentId || p.metadata.agentRoomAgentId === agent.id));
    if (visible) return visible.id;
    fallback ||= matches.find(p => p.metadata?.agentRoomAgentId === agent.id)?.id;
    cursor = result.nextCursor;
  } while (cursor);
  if (fallback) return fallback;
  const result = await pool.request('project/create', {
    name: agent.label, roots: [{ path: agent.workspace }],
    metadata: { agentRoomAgentId: agent.id, source: 'agents-chatroom' },
    idempotencyKey: 'agent-room:' + agent.id,
  });
  if (!result.project?.id) throw new Error('Codex 未返回项目 ID');
  return result.project.id;
}
async function syncCodexSessions(pool, agent, projectId, conversations) {
  const unmatchedSessions = [];
  for (const id of nativeIds(agent, conversations)) {
    let result = await pool.request('thread/read', { threadId: id, includeTurns: false });
    if (result.thread?.projectId !== projectId && samePath(result.thread?.cwd, agent.workspace)) {
      await pool.request('thread/metadata/update', { threadId: id, projectId });
      result = await pool.request('thread/read', { threadId: id, includeTurns: false });
    }
    if (result.thread?.projectId !== projectId) unmatchedSessions.push(id);
  }
  return unmatchedSessions;
}
async function registerAgent(agent, launch, options = {}) {
  if (agent.backend === 'claude') {
    if (options.dataDir && launch) return enqueueClaude(options.dataDir, agent, launch, options.conversations);
    return inspectDesktop(agent, options);
  }
  if (agent.backend === 'dsh' && options.dataDir && launch) {
    const installed = installBridge(options.dataDir, launch);
    const current = inspectDesktop(agent, options);
    return current?.workspaceRegistered ? current : installed;
  }
  if (['workbuddy', 'workbuddy-ai'].includes(agent.backend) && options.dataDir && launch) return enqueueWorkbuddy(options.dataDir, agent, launch);
  if (agent.backend === 'qoder' && options.dataDir && launch) return enqueueQoder(options.dataDir, agent, launch);
  if (agent.backend !== 'codex') return inspectDesktop(agent, options) || { status: 'unsupported', detail: '此后端尚未提供桌面登记接口。' };
  if (!launch) throw new Error('请先配置 Codex 后端路径');
  const pool = new CodexThreadPool({ ...launch, cwd: agent.workspace });
  try {
    await pool.start();
    const projectId = await ensureCodexProject(pool, agent);
    const desktop = codexDesktopProject(agent, pool.env?.CODEX_HOME);
    const unmatchedSessions = await syncCodexSessions(pool, agent, projectId, options.conversations);
    if (options.dataDir) enqueue(options.dataDir, agent, projectId, launch, options.conversations, unmatchedSessions);
    if (desktop?.projectId !== projectId) return { status: 'waiting-for-exit', projectId, workspaceRegistered: false, detail: '已排队自动登记。保持 Agent Room 运行，完全退出 Codex 后通常数秒内完成；再次打开 Codex 即可显示工作区。' };
    return { ...desktop, status: unmatchedSessions.length ? 'workspace-registered' : 'registered', workspaceRegistered: true, unmatchedSessions,
      detail: unmatchedSessions.length ? 'Codex 工作区已登记；部分已有对话需要在 Codex 桌面移入该项目。新对话会自动使用此项目。' : 'Codex 工作区已登记；已有对话的项目归属已核对，新对话会复用此项目。' };
  }
  finally { await pool.stop(); }
}
module.exports = { ensureCodexProject, registerAgent, syncCodexSessions };
