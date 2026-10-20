'use strict';
// Adapt the installed Claude Code CLI's bidirectional stream-json protocol to
// the room's existing ACP client. No copied credentials or bundled Claude CLI.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { desktopEnvironment, desktopModels } = require('./claude-desktop.cjs');
const { mcpConfig } = require('../lib/poll-mcp.cjs');
const { toolNames } = require('../lib/polls.cjs');

function publicError(error, secrets = []) {
  let text = String(error?.message || error || 'Claude Code 请求失败');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/sk-[\w-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .slice(0, 1200);
}

class ClaudeSession {
  constructor(launch, cwd, send, onDeath = () => {}, mcpServers = []) {
    this.launch = launch; this.cwd = cwd; this.send = send; this.onDeath = onDeath;
    this.id = crypto.randomUUID(); this.controls = new Map(); this.models = [];
    this.child = null; this.turn = null; this.closed = false; this.nextId = 0;
    this.mcpServers = mcpServers;
  }
  async start() {
    const args = [...(this.launch.args || []), '--print', '--verbose',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
      '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--tools', '',
      '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: mcpConfig(this.mcpServers) }),
      '--system-prompt', 'You are a concise chat participant. Follow the supplied room identity and rules. Only supplied agent_room poll tools are allowed. Never disclose anonymous ballots in chat.',
      '--settings', JSON.stringify({ disableAllHooks: true }), '--session-id=' + this.id];
    const env = this.launch.desktopDataDir ? desktopEnvironment(this.launch.desktopDataDir) : process.env;
    this.secrets = [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN].filter(Boolean);
    const child = spawn(this.launch.binary, args, { cwd: this.cwd, env,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stdin.on('error', () => this.fail(new Error('Claude Code 输入连接已关闭')));
    // Never forward raw stderr: provider configuration can contain credentials.
    child.stderr.resume();
    let buffer = ''; child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return this.fail(new Error('Claude Code 响应超过限制'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { this.frame(JSON.parse(line)); } catch { this.fail(new Error('Claude Code 返回了无效的 JSON 响应')); }
      }
    });
    child.on('error', () => { if (this.child === child) this.fail(new Error('无法启动 Claude Code，请检查终端版路径和工作区目录')); });
    child.on('exit', code => {
      if (this.child === child && !this.closed) this.fail(new Error('Claude Code 已退出（' + code + '），请检查终端版登录及网络配置'));
    });
    const info = await this.control({ subtype: 'initialize', hooks: {}, agents: {}, skills: [] });
    this.models = (Array.isArray(info.models) ? info.models : []).filter(m => typeof m.value === 'string')
      .map(m => ({ value: m.value, name: m.displayName || m.value }));
    if (this.launch.desktopDataDir) {
      const concrete = desktopModels(this.launch.desktopDataDir);
      if (concrete.length) {
        const ids = new Set(concrete.map(m => m.value));
        this.models = [...concrete, ...this.models.filter(m => !ids.has(m.value)).map(m => ({ ...m, name: m.name + '（兼容别名）' }))];
      }
    }
    if (!this.models.length) throw new Error('Claude Code 没有返回模型列表，请使用兼容的终端版并确认已登录');
    const current = info.model || env.ANTHROPIC_MODEL;
    this.model = this.models.some(m => m.value === current) ? current : this.models[0].value;
    this.initialized = true;
    return this;
  }
  config() { return [{ id: 'model', name: '模型', category: 'model', type: 'select', currentValue: this.model, options: this.models }]; }
  async selectModel(value) {
    await this.control({ subtype: 'set_model', model: value });
    this.model = value;
  }
  write(frame) {
    if (!this.child || this.closed || this.child.killed) throw new Error('Claude Code 会话已关闭');
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }
  control(request, timeoutMs = 30000) {
    const requestId = 'room-' + ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(requestId); reject(new Error('Claude Code 控制请求超时：' + request.subtype));
      }, timeoutMs);
      this.controls.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'control_request', request_id: requestId, request }); }
      catch (error) { clearTimeout(timer); this.controls.delete(requestId); reject(error); }
    });
  }
  update(kind, text) {
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: this.id,
      update: { sessionUpdate: kind, content: { type: 'text', text } } } });
  }
  frame(frame) {
    if (frame.type === 'control_response') {
      const result = frame.response || {}, pending = this.controls.get(result.request_id);
      if (!pending) return;
      this.controls.delete(result.request_id); clearTimeout(pending.timer);
      if (result.subtype === 'error') pending.reject(new Error(publicError(result.error, this.secrets)));
      else pending.resolve(result.response || {});
      return;
    }
    if (frame.type === 'control_request') {
      const request = frame.request || {};
      const allowed = this.mcpServers.some(s => s.name === 'agent_room') && toolNames.some(name => request.tool_name === 'mcp__agent_room__' + name);
      this.write({ type: 'control_response', response: request.subtype === 'can_use_tool'
        ? { subtype: 'success', request_id: frame.request_id, response: allowed ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Agent Room CHAT 仅授权投票工具' } }
        : { subtype: 'error', request_id: frame.request_id, error: 'Unsupported client request in Agent Room CHAT' } });
      return;
    }
    const turn = this.turn;
    if (!turn || frame.parent_tool_use_id) return;
    if (frame.type === 'stream_event') {
      const delta = frame.event?.type === 'content_block_delta' ? frame.event.delta : null;
      if (delta?.type === 'text_delta' && delta.text) {
        turn.text += delta.text; this.update('agent_message_chunk', delta.text);
      } else if (delta?.type === 'thinking_delta' && delta.thinking) this.update('agent_thought_chunk', delta.thinking);
    } else if (frame.type === 'assistant') {
      turn.fallback += (frame.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    } else if (frame.type === 'result') {
      this.turn = null; clearTimeout(turn.timer);
      if (turn.cancelled) return turn.resolve({ stopReason: 'cancelled' });
      if (frame.is_error || frame.subtype !== 'success') {
        return turn.reject(new Error(publicError((frame.errors || []).join('; ') || frame.result || frame.subtype || 'Claude Code 未成功回复', this.secrets)));
      }
      if (!turn.text) {
        const text = turn.fallback || frame.result || '';
        if (text) this.update('agent_message_chunk', text);
      }
      const used = Number(frame.usage?.input_tokens || 0) + Number(frame.usage?.output_tokens || 0);
      if (used) this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: this.id,
        update: { sessionUpdate: 'usage_update', used } } });
      turn.resolve({ stopReason: 'end_turn' });
    }
  }
  prompt(content) {
    if (this.turn) return Promise.reject(new Error('Claude Code 此会话正在回复'));
    return new Promise((resolve, reject) => {
      const turn = { resolve, reject, text: '', fallback: '', cancelled: false };
      turn.timer = setTimeout(() => this.fail(new Error('Claude Code 回复超时，请检查网络或模型权限')), 300000);
      this.turn = turn;
      try { this.write({ type: 'user', session_id: this.id, parent_tool_use_id: null, client_composed: true,
        message: { role: 'user', content }, uuid: crypto.randomUUID() }); }
      catch (error) { this.turn = null; clearTimeout(turn.timer); reject(error); }
    });
  }
  async cancel() {
    if (!this.turn) return;
    this.turn.cancelled = true;
    await this.control({ subtype: 'interrupt' });
  }
  fail(error) {
    if (this.closed) return;
    const initialized = this.initialized;
    this.close(error);
    if (initialized) this.onDeath();
  }
  close(error = new Error('Claude Code 会话已关闭')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.controls.clear();
    if (this.turn) { clearTimeout(this.turn.timer); this.turn.reject(error); this.turn = null; }
    try { this.child?.stdin.end(); this.child?.kill(); } catch {}
  }
}

function serve(launch, input = process.stdin, output = process.stdout) {
  const sessions = new Map(); let stopping = false;
  const send = frame => { if (!output.destroyed && !output.writableEnded) output.write(JSON.stringify(frame) + '\n'); };
  const stop = () => { stopping = true; for (const s of sessions.values()) s.close(); sessions.clear(); };
  async function handle(frame) {
    const { method, params = {} } = frame;
    if (method === 'initialize') return { protocolVersion: 1, agentInfo: { name: 'Claude Code (local stream-json)', version: '1' },
      agentCapabilities: { sessionCapabilities: { close: true } }, authMethods: [] };
    if (method === 'session/new') {
      const session = new ClaudeSession(launch, params.cwd, send, () => { stop(); process.exitCode = 1; input.destroy(); }, params.mcpServers || []);
      sessions.set(session.id, session);
      try { await session.start(); if (stopping) throw new Error('Claude Code 连接已关闭'); }
      catch (error) { session.close(); sessions.delete(session.id); throw error; }
      return { sessionId: session.id, configOptions: session.config() };
    }
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error('Claude Code 会话不存在，请重新连接');
    if (method === 'session/set_config_option') {
      if (session.turn) throw new Error('请等待当前 Claude Code 回复结束后再切换模型');
      if (params.configId !== 'model' || !session.models.some(m => m.value === params.value)) throw new Error('Claude Code 未提供此模型或配置');
      await session.selectModel(params.value);
      return { configOptions: session.config() };
    }
    if (method === 'session/prompt') {
      if (!Array.isArray(params.prompt) || params.prompt.some(c => c.type !== 'text' || typeof c.text !== 'string')) throw new Error('当前 Claude Code 桥接仅支持文本消息');
      return session.prompt(params.prompt);
    }
    if (method === 'session/cancel') { await session.cancel(); return {}; }
    if (method === 'session/close') { session.close(); sessions.delete(session.id); return {}; }
    throw new Error('不支持的 Claude Code 会话操作：' + method);
  }
  const lines = readline.createInterface({ input });
  lines.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    if (!frame.method) return;
    void handle(frame).then(result => {
      if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, result });
    }, error => {
      if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: publicError(error) } });
    });
  });
  lines.on('close', stop); input.on('error', stop); output.on('error', stop);
  return { stop, sessions };
}
if (require.main === module) {
  let launch;
  try { launch = JSON.parse(process.argv[2]); if (typeof launch.binary !== 'string' || !Array.isArray(launch.args)) throw new Error(); }
  catch { process.stderr.write('Claude Code 启动配置无效\n'); process.exit(1); }
  const bridge = serve(launch);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { bridge.stop(); process.exit(0); });
}
module.exports = { ClaudeSession, serve, publicError };
