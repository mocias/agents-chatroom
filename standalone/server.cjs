'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AgentRoom } = require('../lib/room.cjs');
const { RoomApi, readJsonBody, sendJson, sendText } = require('../lib/server.cjs');
const { harnessIds } = require('../lib/harnesses.cjs');
const { BackendDiscovery } = require('./discovery.cjs');
const { queryModels } = require('./models.cjs');
const { chooseWorkspace } = require('./workspaces.cjs');

// This host owns contacts and conversations; the existing engine owns turns.
function createApplication(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.AGENT_ROOM_DATA || path.join(__dirname, '..', '.agent-room-data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const catalogFile = path.join(dataDir, 'catalog.json');
  let catalog = fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, 'utf8')) : { version: 1, agents: [], conversations: [] };
  const configFile = path.join(dataDir, 'backends.json');
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  const consentFile = path.join(dataDir, 'discovery-consent.json');
  let discoveryChoice = fs.existsSync(consentFile) ? JSON.parse(fs.readFileSync(consentFile, 'utf8')).choice : null;
  const discovery = new BackendDiscovery({ dir: dataDir, legacy: config, inventory: options.discoveryInventory, allowAuto: discoveryChoice === 'automatic' });
  let configuring = false;
  const roomsDir = path.join(dataDir, 'rooms');
  fs.mkdirSync(roomsDir, { recursive: true });
  const workspaceDirs = {};
  for (const backend of harnessIds()) {
    workspaceDirs[backend] = path.join(dataDir, 'workspaces', backend);
    fs.mkdirSync(workspaceDirs[backend], { recursive: true });
  }
  const api = new RoomApi({ roomsDir, idleRoomTtlMs: 0, maxUploadBytes: 20 * 1024 * 1024 });
  if (!fs.existsSync(path.join(dataDir, 'agent-room-theme', 'theme.json'))) api.theme.update({ preset: 'paper' });
  const runtimes = new Map();
  const modelCache = new Map();
  async function modelsFor(id, model, refresh = false) {
    if (!['codex', 'dsh', 'qoder'].includes(id)) throw new Error('该后端尚未接入模型查询');
    const key = JSON.stringify([id, model || null]);
    const cached = modelCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < 300000) return cached.value;
    const row = (await discovery.scan()).find(r => r.id === id);
    if (!row?.selected && !options.queryModels) throw new Error(row?.detail || '后端不可用');
    const value = await (options.queryModels || queryModels)(id, row?.selected?.launch, workspaceDirs[id], model);
    modelCache.set(key, { at: Date.now(), value });
    return value;
  }
  const clients = new Set();
  const factory = options.roomFactory || ((settings) => new AgentRoom(settings));
  function save(next) {
    const tmp = catalogFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, catalogFile);
    catalog = next;
  }
  function publish(event) {
    const wire = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const client of clients) client.write(wire);
  }
  function changed() { publish({ type: 'catalog', catalog }); }
  // Preserve old contacts' actual directories; new contacts get their own folder.
  if (catalog.agents.some(a => !a.workspace)) save({ ...catalog, agents: catalog.agents.map(a => a.workspace ? a : { ...a, workspace: workspaceDirs[a.backend] || dataDir }) });
  function conversation(id) {
    const found = catalog.conversations.find((row) => row.id === id);
    if (!found) throw Object.assign(new Error('会话不存在'), { status: 404 });
    return found;
  }
  async function runtime(id) {
    const row = conversation(id);
    if (runtimes.has(id)) return runtimes.get(id);
    const detected = await discovery.scan();
    if (!options.roomFactory && !discovery.allowAuto && row.agentIds.some(key => !detected.find(b => b.id === catalog.agents.find(a => a.id === key)?.backend)?.found)) throw new Error('请先在后端管理中允许扫描或手动配置程序路径');
    if (runtimes.has(id)) return runtimes.get(id);
    const backends = {};
    for (const backend of detected) if (backend.selected) backends[backend.id] = backend.selected.launch;
    const members = row.agentIds.map((key) => ({ ...catalog.agents.find((agent) => agent.id === key),
      ...(row.efforts && Object.hasOwn(row.efforts, key) ? { effort: row.efforts[key] } : {}) }));
    const room = factory({ id, title: row.title, members, backend: members[0].backend,
      cwd: dataDir, workspaceDirs, backends, codexPath: backends.codex?.codexPath,
      logFile: path.join(roomsDir, id + '.log.jsonl'), mode: 'chat', prewarm: false,
      replyPolicy: row.kind === 'direct' ? 'everyone' : 'addressed', projectName: null,
      segmentMs: 1200, maxRelayHops: 2 });
    const state = { room, connecting: null, pending: false, lastUsed: Date.now() };
    runtimes.set(id, state);
    room.on('update', (snapshot) => publish({ type: 'snapshot', room: id, snapshot: api._publicSnapshot(snapshot) }));
    room.on('stream', (event) => {
      publish({ type: 'stream', room: id, event });
      if (event.type === 'agent-end' && event.error) {
        const name = members.find((member) => member.id === event.memberId)?.label || 'Agent';
        room.pushSystem(`${name} 回复失败：${event.error}`);
      }
    });
    room.on('message', (record) => {
      const next = { ...catalog, conversations: catalog.conversations.map((entry) => entry.id !== id ? entry : {
        ...entry, updatedAt: record.ts, preview: record.text.slice(0, 100),
      }) };
      save(next);
      publish({ type: 'message', room: id, record: api._publicRecord(record) });
      changed();
    });
    return state;
  }
  async function release(state) {
    if (state.room.tickTimer) clearInterval(state.room.tickTimer);
    if (state.room._groupTimer) clearTimeout(state.room._groupTimer);
    await state.room.dispose();
  }
  const sweeper = setInterval(() => {
    for (const [id, state] of runtimes) {
      if (!state.pending && !state.room.snapshot().busy.length && Date.now() - state.lastUsed > 30 * 60 * 1000) {
        runtimes.delete(id);
        void release(state);
      }
    }
  }, 60000);
  sweeper.unref();
  const assetRoutes = new Set(['/api/theme', '/api/attach', '/api/background', '/api/theme/background']);
  const server = http.createServer(async (req, res) => {
    try {
      if (options.accessToken && req.headers['x-agent-room-token'] !== options.accessToken) {
        return sendJson(res, 403, { error: '仅限桌面客户端访问' });
      }
      // Loopback only, with same-origin checks against browser cross-site requests.
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return sendJson(res, 403, { error: '不允许的主机' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJson(res, 403, { error: '不允许跨站请求' });
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (assetRoutes.has(route) || route.startsWith('/api/attachment/')) {
        if (await api.handle(req, res, { prefix: '/api' })) return;
      }
      if (req.method === 'GET' && route === '/api/catalog') {
        return sendJson(res, 200, { ...catalog, discoveryChoice, canChooseWorkspace: Boolean(options.chooseWorkspaceDirectory), workspaceRoot: path.join(dataDir, 'workspaces'), harnesses: discovery.publicRows(await discovery.scan()) });
      }
      if (req.method === 'POST' && route === '/api/models') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await modelsFor(body.backend, body.model, Boolean(body.refresh)));
      }
      if (req.method === 'POST' && route === '/api/workspace/browse') {
        if (!options.chooseWorkspaceDirectory) throw new Error('浏览器版请填写文件夹的完整路径');
        return sendJson(res, 200, { path: await options.chooseWorkspaceDirectory() });
      }
      if (req.method === 'POST' && route === '/api/member-effort') {
        const body = await readJsonBody(req);
        if (Object.hasOwn(body, 'model')) throw new Error('群聊不能修改 Agent 模型');
        const row = conversation(body.room);
        const agent = catalog.agents.find(a => a.id === body.agent && row.agentIds.includes(a.id));
        if (!agent?.model) throw new Error('请先创建已选择固定模型的 Agent');
        const capabilities = await modelsFor(agent.backend, agent.model);
        const model = capabilities.models.find(m => m.id === agent.model);
        if (!model || !model.efforts.includes(body.effort)) throw new Error('该模型不支持所选推理强度');
        const active = runtimes.get(row.id);
        if (active && (active.pending || active.room.snapshot().busy.length)) throw new Error('请等待当前回复结束后再修改');
        save({ ...catalog, conversations: catalog.conversations.map(r => r.id === row.id ? { ...r, efforts: { ...r.efforts, [agent.id]: body.effort } } : r) });
        if (active) active.room.members.find(m => m.id === agent.id).effort = body.effort;
        changed();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/api/backends') {
        return sendJson(res, 200, { discoveryChoice, harnesses: discovery.publicRows(await discovery.scan(url.searchParams.get('refresh') === '1')), canBrowse: Boolean(options.chooseBackendFile) });
      }
      if (req.method === 'POST' && route === '/api/discovery-consent') {
        const body = await readJsonBody(req);
        if (!['automatic', 'manual'].includes(body.choice)) throw new Error('请选择扫描或手动配置');
        if (configuring) throw new Error('正在更新配置，请稍后');
        for (const state of runtimes.values()) if (state.pending || state.room.snapshot().busy.length) throw new Error('请等待回复结束后再修改');
        configuring = true;
        try {
          if (discovery.inflight) await discovery.inflight;
          fs.writeFileSync(consentFile + '.tmp', JSON.stringify({ choice: body.choice }));
          fs.renameSync(consentFile + '.tmp', consentFile);
          discoveryChoice = body.choice;
          discovery.allowAuto = body.choice === 'automatic'; discovery.cached = null; modelCache.clear();
          for (const state of runtimes.values()) await release(state);
          runtimes.clear();
          return sendJson(res, 200, { discoveryChoice });
        } finally { configuring = false; }
      }
      if (req.method === 'POST' && route === '/api/backends/browse') {
        if (!options.chooseBackendFile) throw new Error('浏览器版请粘贴本机程序的完整路径；桌面版支持直接选择文件');
        return sendJson(res, 200, { path: await options.chooseBackendFile() });
      }
      if (req.method === 'POST' && route === '/api/backends') {
        const body = await readJsonBody(req);
        if (configuring) throw new Error('正在更新配置，请稍后');
        for (const state of runtimes.values()) if (state.pending || state.room.snapshot().busy.length) throw new Error('有 Agent 正在回复，请等待结束后再修改后端');
        configuring = true;
        try {
          const rows = await discovery.save(body.id, body.automatic ? null : { path: body.path, ...(body.args === undefined ? {} : { args: body.args }) });
          modelCache.clear();
          for (const [id, state] of runtimes) {
            if (!state.room.members.some((m) => m.backend === body.id)) continue;
            await release(state);
            runtimes.delete(id);
          }
          publish({ type: 'backends' });
          return sendJson(res, 200, { harnesses: discovery.publicRows(rows) });
        } finally { configuring = false; }
      }
      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 1500\n\n');
        clients.add(res);
        const timer = setInterval(() => res.write(': ping\n\n'), 20000);
        res.on('close', () => { clearInterval(timer); clients.delete(res); });
        return;
      }
      if (req.method === 'GET' && route === '/api/conversation') {
        const state = await runtime(url.searchParams.get('id'));
        state.lastUsed = Date.now();
        return sendJson(res, 200, { snapshot: api._publicSnapshot(state.room.snapshot()), pending: state.pending });
      }
      if (req.method === 'POST' && route === '/api/agents') {
        const body = await readJsonBody(req);
        const label = String(body.label || '').trim();
        if (!label || label.length > 40 || /[\r\n@]/.test(label)) throw new Error('名称需为 1–40 个字符，不能包含 @ 或换行');
        if (catalog.agents.some((a) => a.label.toLowerCase() === label.toLowerCase())) throw new Error('Agent 名称已存在');
        if (!harnessIds().includes(body.backend)) throw new Error('不支持的后端');
        let chosen;
        if (body.model && ['codex', 'dsh', 'qoder'].includes(body.backend)) {
          const capabilities = await modelsFor(body.backend, body.model);
          chosen = capabilities.models.find(m => m.id === body.model);
          if (!chosen) throw new Error('请选择后端返回的有效模型');
          if (catalog.agents.some(a => a.label.toLowerCase() === label.toLowerCase())) throw new Error('Agent 名称已存在');
        }
        const agent = { id: 'agent-' + randomUUID(), label, backend: body.backend,
          workspace: chooseWorkspace(dataDir, body.backend, label, body.workspace),
          model: chosen?.id || String(body.model || '').trim().slice(0, 120) || null,
          modelLocked: Boolean(chosen), modelName: chosen ? [chosen.provider, chosen.name].filter(Boolean).join(' · ') : null,
          ...(chosen ? { effort: chosen.defaultEffort || null } : {}),
          persona: String(body.persona || '').trim().slice(0, 2000), aliases: [label], createdAt: new Date().toISOString() };
        const direct = { id: 'chat-' + randomUUID(), kind: 'direct', title: label, agentIds: [agent.id], updatedAt: agent.createdAt, preview: '开始聊天吧' };
        save({ ...catalog, agents: [...catalog.agents, agent], conversations: [...catalog.conversations, direct] });
        changed();
        return sendJson(res, 201, { agent, conversation: direct });
      }
      if (req.method === 'POST' && route === '/api/groups') {
        const body = await readJsonBody(req);
        const ids = [...new Set(Array.isArray(body.agentIds) ? body.agentIds : [])];
        if (ids.length < 2 || ids.length > 12 || ids.some((id) => !catalog.agents.some((agent) => agent.id === id))) throw new Error('请选择 2–12 个有效 Agent');
        const row = { id: 'chat-' + randomUUID(), kind: 'group', title: String(body.title || '').trim().slice(0, 60) || '新的群聊',
          agentIds: ids, updatedAt: new Date().toISOString(), preview: `${ids.length} 位 Agent 已加入` };
        save({ ...catalog, conversations: [...catalog.conversations, row] });
        changed();
        return sendJson(res, 201, { conversation: row });
      }
      if (req.method === 'POST' && route === '/api/say') {
        if (configuring) throw new Error('正在更新后端配置，请稍后发送');
        const body = await readJsonBody(req);
        const state = await runtime(body.room);
        for (const backend of await discovery.scan()) if (backend.status === 'invalid' && state.room.members.some((m) => m.backend === backend.id)) throw new Error(backend.detail);
        if (configuring) throw new Error('正在更新后端配置，请稍后发送');
        const text = String(body.text || '').trim();
        if (text.length > 50000) throw new Error('消息过长');
        const ids = [...new Set((Array.isArray(body.attachments) ? body.attachments : []).map((a) => typeof a === 'string' ? a : a.id))];
        const attachments = api._resolveAttachments(ids);
        if (ids.length !== attachments.length) throw new Error('附件不存在，请重新上传');
        if (!text && !attachments.length) throw new Error('请输入消息或添加附件');
        if (state.pending) return sendJson(res, 409, { error: '上一条消息仍在处理，请稍后再发' });
        state.pending = true;
        state.lastUsed = Date.now();
        publish({ type: 'pending', room: body.room, pending: true });
        // Accept quickly; completion, connection failures and streaming use SSE.
        sendJson(res, 202, { ok: true });
        void (async () => {
          try {
            if (!state.room.ready) await state.room.connect({ tolerateFailures: true });
            await state.room.say(text, { attachments });
          } catch (error) {
            state.room.pushSystem('发送失败：' + error.message);
            publish({ type: 'failure', room: body.room, text, attachments: attachments.map((a) => api._publicAttachment(a)), error: error.message });
          } finally {
            state.pending = false;
            state.lastUsed = Date.now();
            publish({ type: 'pending', room: body.room, pending: false });
          }
        })();
        return;
      }
      if (req.method === 'POST' && route === '/api/stop') {
        const body = await readJsonBody(req);
        const state = await runtime(body.room);
        for (const member of state.room.members) member.segments = [];
        await state.room.interruptAll();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        if (route === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
        const asset = assets[route];
        if (asset) {
          res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
          return sendText(res, 200, fs.readFileSync(path.join(__dirname, 'public', asset[0]), 'utf8'), asset[1] + '; charset=utf-8');
        }
      }
      sendJson(res, 404, { error: '接口不存在' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 400, { error: error.message });
      else res.end();
    }
  });
  async function close() {
    clearInterval(sweeper);
    for (const client of clients) client.end();
    await Promise.all([...runtimes.values()].map(release));
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await api.dispose();
  }
  return { server, close, dataDir };
}
if (require.main === module) {
  const app = createApplication();
  const port = Number(process.env.PORT || 4318);
  app.server.listen(port, '127.0.0.1', () => console.log(`Agent Room: http://127.0.0.1:${port}\nData: ${app.dataDir}`));
  app.server.on('error', (error) => { console.error(error.message); process.exitCode = 1; void app.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
}
module.exports = { createApplication };
