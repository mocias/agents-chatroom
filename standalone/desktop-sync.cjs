'use strict';
const path = require('node:path');
const { CodexThreadPool } = require('../lib/codex-pool.cjs');

// Project identity belongs to the Agent, not its label or the current room.
async function ensureCodexProject(pool, agent) {
  let cursor;
  do {
    const result = await pool.request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    const found = (result.data || []).find(p => p.metadata?.agentRoomAgentId === agent.id &&
      p.roots?.some(r => path.resolve(r.path).toLowerCase() === path.resolve(agent.workspace).toLowerCase()));
    if (found) return found.id;
    cursor = result.nextCursor;
  } while (cursor);
  const result = await pool.request('project/create', {
    name: agent.label, roots: [{ path: agent.workspace }],
    metadata: { agentRoomAgentId: agent.id, source: 'agents-chatroom' },
    idempotencyKey: 'agent-room:' + agent.id,
  });
  if (!result.project?.id) throw new Error('Codex 未返回项目 ID');
  return result.project.id;
}
async function registerAgent(agent, launch) {
  if (['workbuddy', 'workbuddy-ai'].includes(agent.backend)) return { status: 'unsupported', detail: '已使用本机 WorkBuddy 后端及独立工作区；会话在本应用中管理，桌面任务列表显示尚未验证。' };
  if (agent.backend !== 'codex') return { status: 'unsupported', detail: agent.backend === 'dsh'
    ? 'DSH 会话已使用独立工作区；独立应用尚未连接桌面端 workspaceRegistry，不能保证桌面列表可见。'
    : 'Qoder ACP 会话与桌面项目库分离；当前版本尚无已验证的桌面导入接口。' };
  if (!launch) throw new Error('请先配置 Codex 后端路径');
  const pool = new CodexThreadPool({ ...launch, cwd: agent.workspace });
  try { await pool.start(); return { status: 'backend-registered', projectId: await ensureCodexProject(pool, agent), detail: 'Codex 后端项目已注册，对话将关联到项目；当前桌面列表的自动显示仍待接入。' }; }
  finally { await pool.stop(); }
}
module.exports = { ensureCodexProject, registerAgent };
