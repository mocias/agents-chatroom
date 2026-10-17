'use strict';
// WorkBuddy owns the account credentials. Ask its running supervisor to start
// our runtime through the desktop's normal credential bootstrap; never invoke
// ACP authenticate or copy the desktop's credential files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AcpPool, AcpError } = require('./acp-backend.cjs');
const run = promisify(execFile);
const { readDesktopCatalog } = require('./workbuddy-catalog.cjs');

class SupervisorControl {
  constructor(socket) {
    this.socket = socket; this.pending = new Map(); this.nextId = 1;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        const entry = this.pending.get(frame.id);
        if (!entry) continue;
        this.pending.delete(frame.id); clearTimeout(entry.timer);
        // Supervisor errors can contain launch environment. Keep them private.
        if (frame.error) entry.reject(new AcpError('WorkBuddy 桌面运行时请求失败'));
        else entry.resolve(frame.result);
      }
    });
    const fail = () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer); entry.reject(new AcpError('WorkBuddy 桌面连接已断开'));
      }
      this.pending.clear();
    };
    socket.on('error', fail); socket.on('close', fail);
  }
  call(method, params = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) return reject(new AcpError('WorkBuddy 桌面连接已断开'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new AcpError('WorkBuddy 桌面请求超时：' + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  destroy() { this.socket.destroy(); }
}

async function processExecutable(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return '';
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`],
  { windowsHide: true, timeout: 5000 });
  return stdout.trim();
}

async function connectSupervisor(options) {
  if (process.platform !== 'win32') throw new AcpError('WorkBuddy 桌面连接目前仅支持 Windows');
  const candidates = options.workbuddyConfigCandidates || [];
  for (const config of candidates) {
    const configDir = path.resolve(config);
    const hash = crypto.createHash('sha1').update(configDir).digest('hex').slice(0, 12);
    let control;
    try {
      const descriptor = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'wb', hash, 'sidecar.pid'), 'utf8'));
      if (!/^[a-f0-9]+$/.test(descriptor.controlPipeUuid) || typeof descriptor.token !== 'string') continue;
      // Both editions can use .workbuddy. Bind to the selected executable,
      // rather than assuming that a directory name identifies the product.
      const exe = await processExecutable(descriptor.pid);
      if (!exe || path.resolve(exe).toLowerCase() !== path.resolve(options.agentCommand).toLowerCase()) continue;
      const socket = net.connect('\\\\.\\pipe\\workbuddy-' + hash + '-sidecar-control-' + descriptor.controlPipeUuid);
      control = new SupervisorControl(socket);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 2000);
        const done = callback => value => { clearTimeout(timer); callback(value); };
        socket.once('connect', done(resolve)); socket.once('error', done(reject));
      });
      const identity = await control.call('sidecar.ping');
      if (identity.pid !== descriptor.pid || identity.token !== descriptor.token) throw new Error('identity mismatch');
      return { control, configDir };
    } catch { control?.destroy(); }
  }
  throw new AcpError('未找到此版本的桌面运行时。请在当前 Windows 用户下打开并登录对应 WorkBuddy，先发送一条消息，再重试。另一个 Windows 用户的桌面需在该用户下运行连接程序。');
}

async function readFrames(response, dispatch) {
  if (!response.ok) throw new AcpError('WorkBuddy 本机接口连接失败（HTTP ' + response.status + '）');
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const text = await response.text();
    if (text.trim()) dispatch(JSON.parse(text));
    return;
  }
  if (!type.includes('text/event-stream')) { await response.text(); return; }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', data = [];
  const line = value => {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (value === '') {
      if (data.length) dispatch(JSON.parse(data.join('\n')));
      data = [];
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (done) { if (buffer) line(buffer); line(''); break; }
    }
  } finally { reader.releaseLock(); }
}

class WorkbuddyConnection extends AcpPool {
  async request(method, params, options) {
    const result = await super.request(method, params, options);
    if (['session/new', 'session/set_config_option'].includes(method) && result?.configOptions) {
      const option = result.configOptions.find(o => o.category === 'model');
      const catalog = readDesktopCatalog(this.desktopConfigDir);
      this.desktopCatalogStatus = { source: catalog.source, updatedAt: catalog.updatedAt, warning: catalog.warning };
      if (option && catalog.options) {
        option.options = catalog.options;
      }
    }
    return result;
  }
  get running() { return this.alive && Boolean(this.endpoint) && !this.abort?.signal.aborted; }
  get pid() { return this.running ? this.runtime?.pid || null : null; }
  async start() {
    if (this.closing) await this.closing;
    if (this.ready) return this.ready;
    this.stopping = false;
    this.ready = this._startDesktop().catch(async error => {
      await this._cleanup(); this.ready = null; throw error;
    });
    return this.ready;
  }
  async _startDesktop() {
    const options = this.commandOptions;
    const connection = await (options.workbuddyConnect || connectSupervisor)(options);
    this.control = connection.control;
    this.desktopConfigDir = connection.configDir;
    this.runtimeSession = 'agent-room-' + crypto.randomUUID();
    this.gatewayPassword = crypto.randomBytes(32).toString('base64url');
    this.abort = new AbortController();
    this.runtime = await this.control.call('session.create', {
      sessionId: this.runtimeSession, command: options.agentCommand, cwd: this.cwd, port: 0,
      args: [...options.agentArgs, '--acp-transport', 'streamable-http',
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
        '--permission-mode', 'plan', '--tools', ''],
      env: { ...options.env, CODEBUDDY_CONFIG_DIR: connection.configDir, WORKBUDDY_CONFIG_DIR: connection.configDir,
        CODEBUDDY_GATEWAY_AUTH: 'password', CODEBUDDY_GATEWAY_PASSWORD: this.gatewayPassword },
    }, 90000);
    const url = new URL(this.runtime.acpEndpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) {
      throw new AcpError('WorkBuddy 返回了无效的本机接口地址');
    }
    this.endpoint = url.href.replace(/\/$/, '');
    if (this.stopping) throw new AcpError('WorkBuddy 连接已取消');
    const response = await fetch(this.endpoint + '/connect', {
      method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new AcpError('WorkBuddy 本机接口握手失败（HTTP ' + response.status + '）');
    this.credentials = await response.json();
    if (typeof this.credentials.connectionId !== 'string') throw new AcpError('WorkBuddy 未返回连接标识');
    this.alive = true;
    const abort = this.abort;
    const eventResponse = await fetch(this.endpoint, { headers: { ...this.headers(), Accept: 'text/event-stream' }, signal: abort.signal });
    if (!eventResponse.ok) throw new AcpError('WorkBuddy 消息订阅失败（HTTP ' + eventResponse.status + '）');
    this.events = readFrames(eventResponse, frame => this._dispatch(frame))
      .then(() => { if (!abort.signal.aborted) throw new AcpError('WorkBuddy 消息连接已关闭'); })
      .catch(() => {
        if (abort.signal.aborted) return;
        this.log('WorkBuddy 桌面运行时连接已断开');
        void this._cleanup();
      });
    this.info = await this.request('initialize', { protocolVersion: 1,
      clientInfo: { name: 'agent-room', version: '0.1.10' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, { timeoutMs: 30000 });
    return this.info;
  }
  headers() {
    return { 'x-codebuddy-request': '1', Authorization: 'Bearer ' + this.gatewayPassword,
      ...(this.credentials ? { 'acp-connection-id': this.credentials.connectionId,
        ...(this.credentials.sessionToken ? { 'acp-session-token': this.credentials.sessionToken } : {}) } : {}) };
  }
  async _answerServerRequest(frame) {
    if (frame.method === 'session/request_permission') {
      this.write({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    return super._answerServerRequest(frame);
  }
  write(frame) {
    if (!this.running) {
      const entry = this.pending.get(frame.id);
      if (entry) { this.pending.delete(frame.id); entry.reject(new AcpError('WorkBuddy 桌面连接不可用')); }
      return;
    }
    void fetch(this.endpoint, { method: 'POST', headers: { ...this.headers(),
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(frame), signal: this.abort.signal })
      .then(response => readFrames(response, value => this._dispatch(value)))
      .catch(() => {
        const entry = this.pending.get(frame.id);
        if (entry) { this.pending.delete(frame.id); entry.reject(new AcpError('WorkBuddy 本机请求失败，请重试')); }
      });
  }
  async stop() {
    this.stopping = true;
    try { await this.ready; } catch {}
    await this._cleanup();
  }
  _cleanup() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.alive = false; this.abort?.abort();
      for (const entry of this.pending.values()) entry.reject(new AcpError('WorkBuddy 桌面连接已关闭'));
      this.pending.clear();
      if (this.endpoint && this.credentials) {
        try { await fetch(this.endpoint, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(1500) }); } catch {}
      }
      if (this.control && this.runtimeSession) {
        try { await this.control.call('session.kill', { sessionId: this.runtimeSession,
          ...(this.runtime?.runtimeId ? { expectedRuntimeId: this.runtime.runtimeId } : {}) }, 5000); }
        catch { this.log('WorkBuddy 群聊运行时关闭失败；未操作桌面已有会话'); }
      }
      this.control?.destroy();
      this.control = null; this.runtime = null; this.runtimeSession = null;
      this.endpoint = null; this.credentials = null; this.gatewayPassword = null;
      this.ready = null; this.info = null; this._onDeath();
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
}

// WorkBuddy's desktop runtime has process-level active-session state. A room
// needs a runtime per member so simultaneous prompts cannot replace that state.
class WorkbuddyPool {
  constructor(options = {}) {
    this.options = options;
    this.primary = new WorkbuddyConnection(options);
    this.connections = new Map();
    this.primaryOwner = null;
  }
  get running() { return this.primary.running; }
  get pid() { return this.primary.pid; }
  get binary() { return this.primary.binary; }
  get info() { return this.primary.info; }
  get desktopCatalogStatus() { return this.primary.desktopCatalogStatus; }
  get supportsInject() { return false; }
  start() { return this.primary.start(); }
  request(...args) { return this.primary.request(...args); }
  listModels() { return this.primary.listModels(); }
  modelCapabilities() { return this.primary.modelCapabilities(); }
  async openThread(key, options) {
    let connection = this.connections.get(key);
    if (!connection) {
      connection = this.primaryOwner === null ? this.primary : new WorkbuddyConnection(this.options);
      if (connection === this.primary) this.primaryOwner = key;
      this.connections.set(key, connection);
    }
    return connection.openThread(key, options);
  }
  getThread(key) { return this.connections.get(key)?.getThread(key); }
  closeThread(key) {
    const connection = this.connections.get(key);
    if (!connection) return;
    connection.closeThread(key);
    // Keep the dedicated runtime for this member's next session. stop() owns
    // its lifetime, including after a mode/configuration change.
  }
  runTurn(key, options) {
    const connection = this.connections.get(key);
    if (!connection) return Promise.reject(new AcpError('unknown WorkBuddy thread: ' + key));
    return connection.runTurn(key, options);
  }
  flush(key) { return this.connections.get(key)?.flush(key) || Promise.resolve(); }
  interrupt(key) { return this.connections.get(key)?.interrupt(key) || Promise.resolve(false); }
  inject() { return Promise.resolve(); }
  injectItems() { return Promise.resolve({ injected: 0, skipped: 'unsupported' }); }
  async stop() {
    await Promise.all([...new Set([this.primary, ...this.connections.values()])].map(connection => connection.stop()));
    this.connections.clear(); this.primaryOwner = null;
  }
}
module.exports = { WorkbuddyPool, WorkbuddyConnection, SupervisorControl, connectSupervisor, readFrames };
