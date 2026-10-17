'use strict';
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { agents: [], conversations: [], harnesses: [], current: null, snapshot: null, filter: 'all', drafts: {}, uploads: {}, pending: new Set(), unread: new Set(), live: new Map(), loading: 0 };
let onSubmit = null;
let toastTimer;
async function api(route, body, method = 'POST') {
  const response = await fetch('/api' + route, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function avatar(agent, group = false) { return `<span class="avatar ${group ? 'group' : escapeHtml(agent?.backend || '')}">${group ? '☷' : escapeHtml((agent?.label || 'A').slice(0, 1).toUpperCase())}</span>`; }
function time(ts) { return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''; }
function renderList() {
  const query = $('#search').value.trim().toLowerCase();
  const rows = state.conversations.filter((row) => (state.filter === 'all' || row.kind === state.filter) && (row.title.toLowerCase().includes(query) || row.agentIds.some((id) => state.agents.find((a) => a.id === id)?.label.toLowerCase().includes(query)))).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
  $('#conversations').innerHTML = rows.length ? rows.map((row) => `<button class="conversation ${row.id === state.current ? 'active' : ''}" data-room="${row.id}" aria-current="${row.id === state.current}">${avatar(state.agents.find((a) => a.id === row.agentIds[0]), row.kind === 'group')}<div class="conversation-info"><div class="conversation-top"><strong>${row.pinned ? '<span class="pin-mark" aria-label="已置顶">⌃ </span>' : ''}${escapeHtml(row.title)}</strong><time>${time(row.updatedAt)}</time>${state.unread.has(row.id) ? '<i class="unread"></i>' : ''}</div><p>${escapeHtml(row.preview || '开始聊天吧')}</p></div></button>`).join('') : '<p class="empty-list">' + (query ? '没有找到匹配的会话' : state.filter === 'group' ? '还没有群聊<br>选择几位伙伴，一起聊聊' : '点击搜索框旁的 ＋<br>添加你的第一位 AI 伙伴') + '</p>';
  $('#welcome-add').textContent = state.agents.length ? '＋ 添加 Agent' : '＋ 添加第一个 Agent';
}
function attachmentsHtml(items, removable = false) {
  return items.map((file, index) => `<span class="file-chip">${file.isImage ? `<img alt="${escapeHtml(file.name)}" src="/api/attachment/${encodeURIComponent(file.id)}">` : '▤'}${escapeHtml(file.name)}${removable ? `<button data-remove-file="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button>` : ''}</span>`).join('');
}
function renderAttachments() { $('#attachments').innerHTML = attachmentsHtml(state.uploads[state.current] || [], true); }
function renderMessages() {
  const panel = $('#messages');
  const stick = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
  const log = state.snapshot?.log || [];
  panel.innerHTML = log.map((record) => {
    if (record.kind === 'system') return `<div class="system-message">${escapeHtml(record.text)}</div>`;
    const isUser = record.kind === 'user';
    const agent = state.agents.find((a) => a.id === record.authorId) || { label: record.authorLabel };
    const files = (record.attachments || []).map((f) => f.isImage ? `<a href="/api/attachment/${encodeURIComponent(f.id)}" target="_blank" rel="noopener"><img class="message-image" src="/api/attachment/${encodeURIComponent(f.id)}" alt="${escapeHtml(f.name)}"></a>` : `<a class="file-chip" href="/api/attachment/${encodeURIComponent(f.id)}" download="${escapeHtml(f.name)}">▤ ${escapeHtml(f.name)}</a>`).join('');
    const privateMessage = record.visibility === 'private';
    const recipients = (record.recipientIds || []).map((id, i) => id === 'user' ? '用户' : (state.agents.find(a => a.id === id)?.label || record.recipientLabels?.[i] || id)).join('、');
    const scope = privateMessage ? `<span class="private-label">私聊 · ${escapeHtml(record.authorLabel)} → ${escapeHtml(recipients)} · 用户可见</span>` : '';
    return `<article class="message ${isUser ? 'user' : ''} ${privateMessage ? 'private-message' : ''}">${isUser ? '<span class="avatar">我</span>' : avatar(agent)}<div class="message-main"><div class="message-meta"><span>${escapeHtml(record.authorLabel)}</span><time>${time(record.ts)}</time></div>${scope}<div class="bubble">${escapeHtml(record.displayText || record.text)}${files}</div></div></article>`;
  }).join('');
  updateLiveMessages(panel);
  if (!panel.children.length) panel.innerHTML = '<div class="empty-chat"><strong>从一句「你好」开始</strong><p>文字、文件、图片，都可以分享。</p></div>';
  if (stick) panel.scrollTop = panel.scrollHeight;
  updateActivity();
}
// Coalesce streaming updates once per frame without rebuilding history DOM.
let messageFrame = null;
let fullMessageRender = false;
function scheduleMessages(full = false) {
  fullMessageRender ||= full;
  if (messageFrame !== null) return;
  messageFrame = requestAnimationFrame(() => {
    messageFrame = null;
    const rebuild = fullMessageRender; fullMessageRender = false;
    if (rebuild) renderMessages();
    else {
      const panel = $('#messages'); const stick = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
      updateLiveMessages(panel);
      if (stick) panel.scrollTop = panel.scrollHeight;
      updateActivity();
    }
  });
}
function updateLiveMessages(panel) {
  for (const node of panel.querySelectorAll('[data-live]')) {
    const live = state.live.get(node.dataset.live);
    if (!live || live.room !== state.current) node.remove();
  }
  for (const [id, live] of state.live) {
    if (live.room !== state.current) continue;
    panel.querySelector('.empty-chat')?.remove();
    let node = [...panel.querySelectorAll('[data-live]')].find(n => n.dataset.live === id);
    if (!node) {
      const agent = state.agents.find(a => a.id === live.memberId);
      node = document.createElement('article'); node.className = 'message'; node.dataset.live = id;
      node.innerHTML = avatar(agent) + '<div class="message-main"><div class="message-meta">' + escapeHtml(agent?.label || 'Agent') + ' · 生成预览，仅用户可见，完成后投递</div><div class="bubble"></div></div>';
      panel.append(node);
    }
    const bubble = node.querySelector('.bubble'); const text = live.text || '正在思考…';
    if (bubble.textContent !== text) bubble.textContent = text;
  }
}
function updateActivity() {
  const busy = state.snapshot?.busy?.length || 0;
  $('#activity').textContent = state.loading ? '正在上传…' : state.pending.has(state.current) ? '正在处理消息…' : busy ? `${busy} 位 Agent 正在回复…` : '';
  $('#send').disabled = !state.snapshot || state.pending.has(state.current) || state.loading > 0;
  $('#stop').hidden = !busy;
}
async function openConversation(id) {
  hideMentions();
  if (state.current) state.drafts[state.current] = $('#draft').value;
  state.current = id; state.snapshot = null; state.unread.delete(id);
  localStorage.setItem('agent-room:selected', id);
  $('#welcome').hidden = true; $('#conversation-view').hidden = false;
  const row = state.conversations.find((c) => c.id === id);
  $('#chat-title').textContent = row.title;
  $('#chat-subtitle').textContent = row.kind === 'group' ? `${row.agentIds.length} 位 Agent · @ 提及伙伴，让对话接着走` : `${state.agents.find((a) => a.id === row.agentIds[0])?.backend || ''} · 独立对话`;
  $('#draft').value = state.drafts[id] || '';
  $('#messages').innerHTML = '<div class="empty-chat">正在读取聊天记录…</div>';
  renderList(); renderAttachments(); updateActivity();
  try {
    const result = await api('/conversation?id=' + encodeURIComponent(id));
    if (state.current !== id) return;
    state.snapshot = result.snapshot;
    if (result.pending) state.pending.add(id); else state.pending.delete(id);
    renderMessages(); $('#messages').scrollTop = $('#messages').scrollHeight;
  } catch (error) { if (state.current === id) $('#messages').textContent = error.message; toast(error.message); }
}
function showModal(title, content, submit, submitLabel = '确定') {
  $('#modal-title').textContent = title; $('#modal-content').innerHTML = content; $('#modal-error').textContent = '';
  $('#modal-footer').hidden = !submit; $('#modal-submit').textContent = submitLabel; $('#modal-submit').disabled = false;
  onSubmit = submit; $('#modal').showModal();
}
function addAgent() {
  showModal('添加 Agent', `<p class="hint">给你的 AI 伙伴取个名字。相同后端也可以添加多位伙伴。</p><label class="field">名称<input name="label" required maxlength="40" placeholder="例如：灵感搭子" autofocus></label><label class="field">后端<select name="backend">${state.harnesses.map(h => h.id).map((id) => { const found = state.harnesses.find((h) => h.id === id); return `<option value="${id}">${escapeHtml(found?.label || id)} · ${found?.found || found?.configured ? '已发现 / 已配置' : '未检测到'}</option>`; }).join('')}</select></label><p class="hint" id="backend-hint"></p><label class="field">固定模型<select name="model" required></select></label><p class="hint" id="model-hint"></p><button type="button" id="reload-models">重新读取模型</button><label class="field">工作区文件夹<input name="workspace" placeholder="留空自动创建：后端名称/Agent 名称"></label><p class="hint" id="workspace-hint"></p><button type="button" id="choose-workspace">选择文件夹…</button><label class="field">角色设定 <span class="hint">（可选）</span><textarea name="persona" maxlength="2000" placeholder="例如：你是一位擅长发散思考的设计伙伴。"></textarea></label>`, async (form) => {
    const result = await api('/agents', Object.fromEntries(new FormData(form)));
    await refresh(); $('#modal').close(); await openConversation(result.conversation.id);
    if (result.agent.desktopSync?.status !== 'registered') toast(result.agent.desktopSync?.detail || '桌面同步待处理');
  }, '添加并开始聊天');
  const choose = $('#choose-workspace'); choose.hidden = !state.canChooseWorkspace;
  $('#workspace-hint').textContent = '留空将创建在 ' + state.workspaceRoot + ' 下；同一 Agent 在各群聊中共用文件夹，对话独立。';
  choose.onclick = async () => { try { const result = await api('/workspace/browse', {}); if (result.path && $('#modal-content [name="workspace"]')) $('#modal-content [name="workspace"]').value = result.path; } catch(error) { toast(error.message); } };
  const select = $('#modal-content select');
  const hint = () => { const found = state.harnesses.find((h) => h.id === select.value); $('#backend-hint').textContent = found?.found || found?.configured ? '使用本机后端的登录状态。首次发送时连接。' : '可以先添加。聊天前需安装并登录此后端，或在本地后端配置中指定启动路径。'; };
  let generation = 0;
  const loadModels = async () => {
    hint(); const ticket = ++generation; const backend = select.value;
    const models = $('#modal-content [name="model"]'); const note = $('#model-hint');
    models.innerHTML = '<option value="">正在读取…</option>'; $('#modal-submit').disabled = true;
    models.required = true;
    try {
      const data = await api('/models', { backend, refresh: true });
      if (ticket !== generation || !models.isConnected) return;
      models.innerHTML = data.models.map(m => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml([m.provider, m.name].filter(Boolean).join(' · ')) + '</option>').join('');
      models.value = data.selected; note.textContent = '模型随 Agent 固定，加入群聊后仅可调整推理强度。'; $('#modal-submit').disabled = !models.value;
    } catch (error) { if (ticket !== generation || !models.isConnected) return; models.innerHTML = '<option value="">读取失败</option>'; note.textContent = error.message; }
  };
  select.onchange = loadModels; $('#reload-models').onclick = loadModels; void loadModels();
  const configure = document.createElement('button');
  configure.type = 'button'; configure.textContent = '未找到后端？自动发现 / 手动配置';
  configure.className = 'text-button';
  configure.onclick = () => { void backendSettings(select.value); };
  $('#backend-hint').after(configure);
}
let discoveryPromptShown = false;
function discoveryPrompt(selectedId = 'codex', reset = false) {
  discoveryPromptShown = true;
  const choose = async choice => {
    await api('/discovery-consent', { choice });
    if (reset && choice === 'automatic') await api('/backends', { id: selectedId, automatic: true });
    await refresh(); await backendSettings(selectedId);
  };
  showModal('是否允许查找已安装的 Agent？', '<p>自动发现需要读取本机安装记录、运行程序路径、快捷方式和 PATH，并在相关安装目录中查找后端文件。不会扫描聊天内容或上传文件。</p><p>允许后会记住选择，并在后续启动时自动发现；可随时改为手动配置。</p><p class="hint">手动查找：在开始菜单或桌面右键 Agent 快捷方式，选择“打开文件所在的位置”；若打开的仍是快捷方式，查看“属性 → 目标”。复制程序文件的完整路径，或在桌面版中点击“浏览选择程序”。</p><button type="button" id="discovery-manual">不扫描，手动配置</button>', () => choose('automatic'), '允许扫描');
  $('#discovery-manual').onclick = async () => { try { await choose('manual'); } catch(error) { $('#modal-error').textContent = error.message; } };
}
async function backendSettings(selectedId = 'codex', force = false) {
  try {
    const result = await api('/backends' + (force ? '?refresh=1' : ''));
    state.harnesses = result.harnesses;
    showModal('后端管理', `<p class="hint">自动查找已安装的 CLI 和桌面后端。没有找到时，可手动填写程序或安装目录。发现入口不代表已经登录或连接成功。</p><label class="field">Agent 后端<select id="backend-id">${result.harnesses.map((row) => `<option value="${row.id}" ${row.id === selectedId ? 'selected' : ''}>${escapeHtml(row.label)} · ${row.found ? '已发现入口' : row.status === 'invalid' ? '配置失效' : row.status === 'installed' ? '需要配置' : '未发现'}</option>`).join('')}</select></label><p class="hint" id="backend-status"></p><button type="button" id="rescan">扫描设置 / 重新检测</button><label class="field">已发现的入口<select id="backend-candidates"></select></label><label class="field">程序或安装目录<input id="backend-path" placeholder="粘贴完整路径，例如 C:\\安装目录\\程序.exe" autocomplete="off"></label><button type="button" id="browse-backend" ${result.canBrowse ? '' : 'hidden'}>浏览选择程序…</button><p class="hint">手动查找：右键桌面或开始菜单快捷方式 → 打开文件所在的位置；若仍是快捷方式，查看属性中的“目标”。复制程序文件完整路径，桌面版也可浏览选择。手动模式不会扫描安装目录。</p><label class="field">仅此后端使用的代理（可选）<input id="backend-proxy" placeholder="留空跟随现有网络；例如 http://127.0.0.1:端口" autocomplete="off"></label><p class="hint" id="backend-proxy-hint">TUN 模式通常可留空；填写代理只影响 Room 启动的此后端，不更改系统代理或 Dot 设置。</p><details><summary>高级：启动参数</summary><label class="field">参数 JSON 数组<textarea id="backend-args" placeholder='留空自动推导；例如 ["--acp"]'></textarea></label><p class="hint">仅在自定义启动方式时填写。每个参数单独一项，不要填整条命令。Codex 会自动追加 app-server 参数。</p></details><button type="button" id="backend-auto">恢复自动选择</button>`, async () => {
      const args = $('#backend-args').value.trim();
      await api('/backends', { id: $('#backend-id').value, path: $('#backend-path').value, proxy: $('#backend-proxy').value.trim(), ...(args ? { args: JSON.parse(args) } : {}) });
      $('#modal').close(); await refresh(); if (state.current) await openConversation(state.current); toast('后端配置已保存，下次发送时使用；连接与登录尚未验证');
    }, '保存配置');
    const storageButton = document.createElement('button'); storageButton.type = 'button'; storageButton.id = 'data-location-settings'; storageButton.textContent = '数据目录与手动迁移…'; storageButton.onclick = () => void dataLocationSettings(); $('#modal-content').prepend(storageButton);
    function fields() {
      const row = result.harnesses.find((r) => r.id === $('#backend-id').value);

      $('#backend-status').textContent = [row.detail, row.selected && `来源：${row.selected.source}`, row.warning, ['workbuddy', 'workbuddy-ai'].includes(row.id) && '保持对应 WorkBuddy 桌面已登录并运行，先在桌面发送过一条消息。群聊复用当前 Windows 用户的桌面登录，无需重新授权；其他 Windows 用户需在该用户下运行连接程序。'].filter(Boolean).join(' · ');
      $('#backend-candidates').innerHTML = '<option value="">选择自动发现的入口</option>' + row.candidates.map((c) => `<option value="${escapeHtml(c.path)}">${escapeHtml(c.source + ' · ' + c.path)}</option>`).join('');
      $('#backend-path').value = row.preference?.path || row.selected?.path || '';
      $('#backend-args').value = row.preference?.args ? JSON.stringify(row.preference.args) : '';
      const desktopNetwork = ['workbuddy', 'workbuddy-ai'].includes(row.id);
      $('#backend-proxy').disabled = desktopNetwork;
      $('#backend-proxy').value = desktopNetwork ? '' : row.preference?.proxy || '';
      $('#backend-proxy-hint').textContent = desktopNetwork ? 'WorkBuddy 复用桌面应用的网络配置，请在对应桌面应用中设置代理。' : 'TUN 模式通常可留空；填写代理只影响 Room 启动的此后端，不更改系统代理或 Dot 设置。';
    }
    $('#backend-id').onchange = fields; fields();
    $('#backend-candidates').onchange = () => { if ($('#backend-candidates').value) { $('#backend-path').value = $('#backend-candidates').value; $('#backend-args').value = ''; } };
    $('#rescan').onclick = () => discoveryPrompt($('#backend-id').value);
    $('#browse-backend').onclick = async () => { try { const picked = await api('/backends/browse', {}); if (picked.path) $('#backend-path').value = picked.path; } catch (error) { $('#modal-error').textContent = error.message; } };
    $('#backend-auto').onclick = async () => {
      if (result.discoveryChoice !== 'automatic') { discoveryPrompt($('#backend-id').value, true); return; }
      try { await api('/backends', { id: $('#backend-id').value, automatic: true }); const id = $('#backend-id').value; await refresh(); await backendSettings(id); toast('已恢复自动选择'); }
      catch (error) { $('#modal-error').textContent = error.message; }
    };
  } catch (error) { toast(error.message); }
}
async function dataLocationSettings() {
  try {
    const info = await api('/data-location');
    showModal('数据目录与手动迁移', '<p>当前数据目录：</p><p class="data-path">' + escapeHtml(info.current) + '</p>' + (info.warning ? '<p class="hint">' + escapeHtml(info.warning) + '</p>' : '') + '<label class="field">下次启动使用的目录<input name="dataPath" required value="' + escapeHtml(info.pending || info.current) + '"></label><button type="button" id="browse-data" ' + (info.canBrowse ? '' : 'hidden') + '>选择文件夹…</button><p class="hint">保存后不会立即切换，也不会自动搬移或删除文件。</p><ol class="hint"><li>保存设置，然后完全退出桌面应用；浏览器版需停止本地服务。</li><li>把当前目录内的全部文件和子文件夹复制到新目录，直接包含 catalog.json、rooms 等，不要再套一层 data。</li><li>重新启动应用。系统校验复制结果，通过后启用新目录；缺失或不一致时继续使用旧目录。</li><li>确认 Agent、历史和附件正常后，再自行决定如何处理旧目录。</li></ol><p class="hint">工作区路径不会自动改变。安装目录下的 agents 或自选工作区仍使用原路径；若旧数据目录内含 workspaces，复制后也需在各 Agent 设置中修改工作区路径。外部后端的登录配置不受影响。</p>' + (info.pending ? '<button type="button" id="cancel-data-change">取消待切换目录</button>' : ''), info.configurable ? async form => {
      const result = await api('/data-location', { path: new FormData(form).get('dataPath') });
      await dataLocationSettings(); toast(result.pending ? '已保存。请退出应用、手动复制文件，再重新启动。' : '继续使用当前数据目录');
    } : null, '保存，下次启动生效');
    $('#browse-data').onclick = async () => { try { const result = await api('/workspace/browse', {}); if (result.path) $('#modal-content [name="dataPath"]').value = result.path; } catch(e) { $('#modal-error').textContent = e.message; } };
    if ($('#cancel-data-change')) $('#cancel-data-change').onclick = async () => { try { await api('/data-location', { cancel: true }); await dataLocationSettings(); } catch(e) { $('#modal-error').textContent = e.message; } };
  } catch(e) { toast(e.message); }
}
function createGroup() {
  showModal('发起群聊', `<p class="hint">选择要邀请的伙伴，可以一次选择多位 Agent。</p><label class="field">群聊名称<input name="title" placeholder="例如：产品灵感小组" maxlength="60"></label><div class="picker">${state.agents.map((agent) => `<label class="pick-row">${avatar(agent)}<span>${escapeHtml(agent.label)}<small>${escapeHtml(agent.backend)} · ${escapeHtml(agent.modelName || agent.model || "后端默认")}</small></span><input type="checkbox" name="agentIds" value="${agent.id}" aria-label="选择 ${escapeHtml(agent.label)}"></label>`).join('') || '<p class="hint">还没有 Agent，请先点击左侧 ＋ 添加。</p>'}</div><p class="hint" id="selected-count">已选择 0 位 · 至少选择 2 位 Agent</p>`, async (form) => {
    const data = new FormData(form);
    const result = await api('/groups', { title: data.get('title'), agentIds: data.getAll('agentIds') });
    await refresh(); $('#modal').close(); await openConversation(result.conversation.id);
  }, '创建群聊');
  const count = () => { const n = $('#modal-content').querySelectorAll('input:checked').length; $('#selected-count').textContent = `已选择 ${n} 位 · 可选择 2–12 位 Agent`; $('#modal-submit').disabled = n < 2 || n > 12; };
  $('#modal-content').onchange = count; count();
}
async function memberEffort(agentId, roomId) {
  const agent = state.agents.find(a => a.id === agentId);
  const row = state.conversations.find(r => r.id === roomId);
  showModal('Agent 设置 · ' + agent.label, '<p>固定模型：' + escapeHtml(agent.modelName || agent.model || '后端默认') + '</p><label class="field">推理强度<select name="effort" disabled><option value="">正在读取…</option></select></label><p class="hint" id="effort-loading"></p><label class="field">工作区文件夹<input name="workspace" required value="' + escapeHtml(agent.workspace) + '"></label><button type="button" id="choose-workspace">选择文件夹…</button><p class="hint">推理强度仅用于当前会话。工作区用于这位 Agent 的所有会话；更改后将使用新的后端会话，历史记录保留，原文件不会搬移或删除。</p>', async form => {
    const data = new FormData(form);
    await api('/agents/settings', { id: agentId, room: roomId, workspace: data.get('workspace'), ...(data.has('effort') && data.get('effort') ? { effort: data.get('effort') } : {}) });
    await refresh(); $('#modal').close(); toast('设置已保存');
  }, '保存设置');
  const select = $('#modal-content [name="effort"]');
  $('#choose-workspace').hidden = !state.canChooseWorkspace;
  $('#choose-workspace').onclick = async () => { try { const result = await api('/workspace/browse', {}); if (result.path && select.isConnected) $('#modal-content [name="workspace"]').value = result.path; } catch(e) { toast(e.message); } };
  try {
    const data = await api('/models', { backend: agent.backend, model: agent.model });
    if (!select.isConnected) return;
    const model = data.models.find(m => m.id === agent.model);
    const efforts = model?.efforts || [];
    select.innerHTML = efforts.length ? efforts.map(e => '<option value="' + escapeHtml(e) + '">' + escapeHtml(e) + '</option>').join('') : '<option value="">后端默认</option>';
    select.disabled = !efforts.length;
    if (efforts.length) select.value = row.efforts?.[agentId] || agent.effort || model.defaultEffort || efforts[0];
    $('#effort-loading').textContent = efforts.length ? '' : '后端未提供可调整的推理档位，仍可修改工作区。';
  } catch(e) { if (select.isConnected) { select.innerHTML = '<option value="">保持原设置</option>'; $('#effort-loading').textContent = '推理档位读取失败：' + e.message + '。仍可修改工作区。'; } }
}
function showMembers(mention = false) {
  const row = state.conversations.find(c => c.id === state.current); if (!row) return;
  if (!mention && row.agentIds.length === 1) { void memberEffort(row.agentIds[0], row.id); return; }
  showModal(mention ? '提及 Agent' : '会话设置', '<div class="picker">' + row.agentIds.map(id => {
    const agent = state.agents.find(a => a.id === id);
    return '<button type="button" class="pick-row" data-member="' + id + '">' + avatar(agent) + '<span>' + escapeHtml(agent.label) + '<small>' + (mention ? '点击提及' : '修改推理强度和工作区') + '</small></span></button>';
  }).join('') + '</div>', null);
  if (mention && row.kind === 'group' && row.agentIds.length) $('#modal-content .picker').insertAdjacentHTML('afterbegin', '<button type="button" class="pick-row" data-member="__all__"><span class="avatar group">☷</span><span>所有人<small>提及当前群聊的全部成员</small></span></button>');
  $('#modal-content').onclick = event => {
    const button = event.target.closest('[data-member]'); if (!button) return;
    const agent = button.dataset.member === '__all__' ? { label: '所有人' } : state.agents.find(a => a.id === button.dataset.member);
    if (!mention) { $('#modal-content').onclick = null; void memberEffort(agent.id, row.id); return; }
    $('#draft').value += '@' + agent.label + ' '; state.drafts[state.current] = $('#draft').value; $('#modal').close(); $('#draft').focus();
  };
}
function renameConversation(row, agent) {
  showModal(agent ? '重命名 Agent' : '重命名群聊', '<label class="field">名称<input name="label" required maxlength="' + (agent ? 40 : 60) + '" value="' + escapeHtml(agent?.label || row.title) + '"></label><p class="hint">' + (agent ? '工作区目录保持不变，之后点名请使用新名称。' : '只修改群聊名称，成员和历史记录保持不变。') + '</p>', async form => {
    await api('/conversation/rename', { id: row.id, name: new FormData(form).get('label') });
    await refresh();
    const current = state.conversations.find(c => c.id === state.current); if (current) $('#chat-title').textContent = current.title;
    $('#modal').close(); toast('名称已修改');
  }, '保存名称');
}
function closeAgentMenu() { $('#agent-context-menu')?.remove(); }
$('#conversations').addEventListener('contextmenu', event => {
  closeAgentMenu();
  const button = event.target.closest('[data-room]');
  const row = state.conversations.find(c => c.id === button?.dataset.room);
  if (!row) return;
  event.preventDefault();
  const agent = row.kind === 'direct' ? state.agents.find(a => a.id === row.agentIds[0]) : null; if (row.kind === 'direct' && !agent) return;
  const menu = document.createElement('div'); menu.id = 'agent-context-menu'; menu.setAttribute('role', 'menu');
  menu.innerHTML = '<button role="menuitem" data-action="pin">' + (row.pinned ? '取消置顶' : '置顶') + '</button><button role="menuitem" data-action="delete">删除</button>';
  if (row.kind === 'group') menu.innerHTML = '';
  menu.insertAdjacentHTML('afterbegin', '<button role="menuitem" data-action="rename">重命名</button>');
  document.body.append(menu);
  menu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.onclick = async e => {
    const action = e.target.closest('[data-action]')?.dataset.action; if (!action) return;
    closeAgentMenu();
    if (action === 'rename') { renameConversation(row, agent); return; }
    if (action === 'delete') { deleteAgent(agent); return; }
    try { await api('/conversation/pin', { id: row.id, pinned: !row.pinned }); await refresh(); } catch(e) { toast(e.message); }
  };
  menu.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const buttons = [...menu.querySelectorAll('button')]; buttons[(buttons.indexOf(document.activeElement) + 1) % buttons.length].focus(); } });
  menu.querySelector('button').focus();
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('#agent-context-menu')) closeAgentMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAgentMenu(); });
window.addEventListener('resize', closeAgentMenu);
document.addEventListener('wheel', closeAgentMenu, { passive: true });
function deleteAgent(agent) {
  showModal('删除 Agent：' + agent.label, '<p>将从联系人和所有群聊中移除这位 Agent。群聊历史及原后端中的对话仍保留。</p><p>工作区：<code>' + escapeHtml(agent.workspace) + '</code></p><label class="field">工作区处理<select name="deleteWorkspace"><option value="false">保留文件夹和文件（默认）</option><option value="true">同时永久删除工作区及全部文件</option></select></label><label class="field" id="delete-path-field" hidden>确认删除时，请输入上面的完整路径<input name="confirmWorkspace" autocomplete="off"></label>', async form => {
    const data = new FormData(form);
    const result = await api('/agents/delete', { id: agent.id, deleteWorkspace: data.get('deleteWorkspace') === 'true', confirmWorkspace: data.get('confirmWorkspace') });
    $('#modal').close(); await refresh();
    if (state.conversations.some(c => c.id === state.current)) await openConversation(state.current);
    else { state.current = null; state.snapshot = null; localStorage.removeItem('agent-room:selected'); $('#conversation-view').hidden = true; $('#welcome').hidden = false; }
    toast(result.warning || 'Agent 已删除');
  }, '确认删除');
  $('#modal-content [name="deleteWorkspace"]').onchange = event => { const remove = event.target.value === 'true'; $('#delete-path-field').hidden = !remove; $('#modal-content [name="confirmWorkspace"]').required = remove; };
}
let themeData;
function applyTheme(theme) {
  themeData = theme;
  for (const [name, value] of Object.entries(theme.colors || {})) document.documentElement.style.setProperty(name, value);
  document.documentElement.style.setProperty('--wallpaper', theme.background?.kind === 'file' ? `url("/api/background?v=${theme.background.version}")` : 'none');
}
async function settings() {
  try {
    const result = await api('/theme'); applyTheme(result.theme);
    showModal('让房间更像你', `<p class="hint">外观设置会应用到所有会话，并保存在本机。</p><div class="themes">${result.presets.map((p) => `<button type="button" data-preset="${p.id}"><span class="theme-swatch" style="background:${p.colors['--ar-bg']}"></span>${escapeHtml(p.label)}</button>`).join('')}</div><label class="colors">聊天背景色<input type="color" id="bg-color" value="${themeData.colors['--ar-bg']}"></label><label class="colors">正文颜色<input type="color" id="text-color" value="${themeData.colors['--ar-text']}"></label><label class="upload-background">聊天背景图片<input type="file" id="background-input" accept="image/png,image/jpeg,image/webp"></label><button type="button" id="remove-background">移除背景图片</button>`, null);
    $('#modal-content').onclick = async (event) => { const preset = event.target.closest('[data-preset]'); if (!preset) return; try { applyTheme((await api('/theme', { preset: preset.dataset.preset })).theme); $('#bg-color').value = themeData.colors['--ar-bg']; $('#text-color').value = themeData.colors['--ar-text']; } catch (error) { toast(error.message); } };
    for (const [id, token] of [['bg-color', '--ar-bg'], ['text-color', '--ar-text']]) $('#' + id).onchange = async (event) => { try { applyTheme((await api('/theme', { colors: { [token]: event.target.value } })).theme); } catch (error) { toast(error.message); } };
    $('#background-input').onchange = async (event) => { try { const file = event.target.files[0]; if (!file) return; if (file.size > 16 * 1024 * 1024) throw new Error('背景图片不能超过 16 MB'); const response = await fetch('/api/theme/background?type=' + encodeURIComponent(file.type), { method: 'POST', body: file }); const data = await response.json(); if (!response.ok) throw new Error(data.error); applyTheme(data.theme); } catch (error) { toast(error.message); } };
    $('#remove-background').onclick = async () => { try { applyTheme((await api('/theme', { background: null })).theme); } catch (error) { toast(error.message); } };
  } catch (error) { toast(error.message); }
}
async function uploadFiles(files) {
  const id = state.current; if (!id) return toast('请先选择一个会话');
  state.loading++; updateActivity();
  try {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) { toast(file.name + ' 超过 20 MB'); continue; }
      const response = await fetch('/api/attach?name=' + encodeURIComponent(file.name) + '&type=' + encodeURIComponent(file.type), { method: 'POST', body: file });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      (state.uploads[id] ||= []).push(data.attachment);
      if (state.current === id) renderAttachments();
    }
  } catch (error) { toast(error.message); }
  finally { state.loading--; updateActivity(); }
}
let mentionState = null;
const mentionPopup = document.createElement('div'); mentionPopup.id = 'mention-suggestions'; mentionPopup.hidden = true; mentionPopup.setAttribute('role', 'listbox'); mentionPopup.setAttribute('aria-label', '提及成员'); $('.composer').append(mentionPopup);
$('#draft').setAttribute('aria-controls', mentionPopup.id);
function hideMentions() { mentionState = null; mentionPopup.hidden = true; $('#draft').removeAttribute('aria-activedescendant'); }
function paintMentions() {
  mentionPopup.innerHTML = mentionState.agents.map((a, i) => '<button type="button" role="option" id="mention-option-' + i + '" data-index="' + i + '" aria-selected="' + (i === mentionState.index) + '">' + avatar(a) + '<span>' + escapeHtml(a.label) + '</span></button>').join('');
  mentionPopup.hidden = false; $('#draft').setAttribute('aria-activedescendant', 'mention-option-' + mentionState.index);
  mentionPopup.children[mentionState.index]?.scrollIntoView({ block: 'nearest' });
}
function updateMentions() {
  const draft = $('#draft'); const caret = draft.selectionStart;
  if (caret !== draft.selectionEnd) { hideMentions(); return; }
  const prefix = draft.value.slice(0, caret); const start = Math.max(prefix.lastIndexOf('@'), prefix.lastIndexOf('#'));
  if (start < 0 || (start > 0 && /[\p{L}\p{N}_]/u.test(prefix[start - 1]))) { hideMentions(); return; }
  const query = prefix.slice(start + 1);
  const marker = prefix[start];
  if (/[\r\n]/.test(query)) { hideMentions(); return; }
  const row = state.conversations.find(c => c.id === state.current);
  const members = (row?.agentIds || []).map(id => state.agents.find(a => a.id === id)).filter(Boolean);
  if (marker === '@' && row?.kind === 'group' && members.length) members.unshift({ id: '__all__', label: '所有人', backend: 'group' });
  const agents = members.filter(a => a.label.toLowerCase().includes(query.toLowerCase()));
  if (!agents.length) { hideMentions(); return; }
  mentionState = { start, end: caret, agents, index: 0, marker }; paintMentions();
}
function acceptMention(index) {
  if (!mentionState) return;
  const draft = $('#draft'); const value = mentionState.marker + mentionState.agents[index].label + ' ';
  const caret = mentionState.start + value.length;
  draft.value = draft.value.slice(0, mentionState.start) + value + draft.value.slice(mentionState.end);
  state.drafts[state.current] = draft.value; hideMentions(); draft.focus(); draft.setSelectionRange(caret, caret);
}
mentionPopup.onmousedown = e => e.preventDefault();
mentionPopup.onclick = e => { const button = e.target.closest('[data-index]'); if (button) acceptMention(Number(button.dataset.index)); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('#mention-suggestions') && e.target !== $('#draft')) hideMentions(); });
$('#draft').addEventListener('click', updateMentions);
$('#draft').addEventListener('compositionstart', hideMentions);
$('#draft').addEventListener('compositionend', updateMentions);
async function send() {
  const id = state.current; const text = $('#draft').value.trim(); const files = state.uploads[id] || [];
  if ((!text && !files.length) || $('#send').disabled) return;
  state.pending.add(id); updateActivity();
  // Clear immediately so an asynchronous failure can restore the draft safely.
  hideMentions(); $('#draft').value = ''; state.drafts[id] = ''; state.uploads[id] = []; renderAttachments();
  try { await api('/say', { room: id, text, attachments: files.map((f) => f.id) }); }
  catch (error) { state.pending.delete(id); restoreDraft(id, text, files); toast(error.message); }
  finally { updateActivity(); }
}
function restoreDraft(id, text, files) {
  const current = state.current === id ? $('#draft').value : state.drafts[id];
  state.drafts[id] = [text, current].filter(Boolean).join('\n');
  state.uploads[id] = [...files, ...(state.uploads[id] || [])];
  if (state.current === id) { $('#draft').value = state.drafts[id]; renderAttachments(); }
}
async function refresh() { const data = await api('/catalog'); Object.assign(state, { agents: data.agents, conversations: data.conversations, harnesses: data.harnesses, canChooseWorkspace: data.canChooseWorkspace, workspaceRoot: data.workspaceRoot, discoveryChoice: data.discoveryChoice }); renderList(); if (data.discoveryChoice === null && !discoveryPromptShown) discoveryPrompt(); }
$('#add-agent').onclick = $('#welcome-add').onclick = addAgent;
$('#new-group').onclick = createGroup; $('#settings').onclick = settings;
$('#backends').onclick = () => { void backendSettings(); };
$('#search').oninput = renderList;
document.querySelectorAll('[data-filter]').forEach((button) => { button.onclick = () => { state.filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('selected', b === button)); renderList(); }; });
$('#conversations').onclick = (event) => { const button = event.target.closest('[data-room]'); if (button) void openConversation(button.dataset.room); };
$('#close-modal').onclick = $('#cancel-modal').onclick = () => $('#modal').close();
$('#modal').addEventListener('close', () => { $('#modal-content').onclick = null; $('#modal-content').onchange = null; });
$('#modal-form').onsubmit = async (event) => { event.preventDefault(); if (!onSubmit) return; $('#modal-submit').disabled = true; try { await onSubmit(event.target); } catch (error) { $('#modal-error').textContent = error.message; } finally { $('#modal-submit').disabled = false; } };
$('#attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = (event) => { void uploadFiles([...event.target.files]); event.target.value = ''; };
$('#attachments').onclick = (event) => { const button = event.target.closest('[data-remove-file]'); if (button) { state.uploads[state.current].splice(Number(button.dataset.removeFile), 1); renderAttachments(); } };
$('#members').onclick = () => showMembers(); $('#mention').onclick = () => showMembers(true);
$('#send').onclick = send;
$('#draft').oninput = e => { state.drafts[state.current] = $('#draft').value; if (!e.isComposing) updateMentions(); };
$('#draft').onkeydown = (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (mentionState) {
    if (event.key === 'Escape') { event.preventDefault(); hideMentions(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); mentionState.index = (mentionState.index + (event.key === 'ArrowDown' ? 1 : -1) + mentionState.agents.length) % mentionState.agents.length; paintMentions(); return; }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); acceptMention(mentionState.index); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } };
$('#draft').onpaste = (event) => { if (event.clipboardData.files.length) { event.preventDefault(); void uploadFiles([...event.clipboardData.files]); } };
$('#chat').ondragover = (event) => { event.preventDefault(); $('#chat').classList.add('dragging'); };
$('#chat').ondragleave = () => $('#chat').classList.remove('dragging');
$('#chat').ondrop = (event) => { event.preventDefault(); $('#chat').classList.remove('dragging'); void uploadFiles([...event.dataTransfer.files]); };
$('#stop').onclick = async () => { try { await api('/stop', { room: state.current }); } catch (error) { toast(error.message); } };
const events = new EventSource('/api/events');
events.onopen = async () => {
  $('#connection').className = 'online'; $('#connection').innerHTML = '<i></i>本地已连接';
  try { await refresh(); if (state.current) { const id = state.current; const data = await api('/conversation?id=' + encodeURIComponent(id)); if (id === state.current) { state.snapshot = data.snapshot; if (data.pending) state.pending.add(id); else state.pending.delete(id); state.live.clear(); renderMessages(); } } } catch (error) { toast(error.message); }
};
events.onerror = () => { $('#connection').className = ''; $('#connection').innerHTML = '<i></i>连接中断，正在重连'; };
events.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.type === 'catalog') { state.agents = data.catalog.agents; state.conversations = data.catalog.conversations; renderList(); }
  if (data.type === 'snapshot' && data.room === state.current) { state.snapshot = data.snapshot; scheduleMessages(true); }
  if (data.type === 'message' && data.room !== state.current) { state.unread.add(data.room); renderList(); }
  if (data.type === 'pending') { if (data.pending) state.pending.add(data.room); else state.pending.delete(data.room); updateActivity(); }
  if (data.type === 'failure') { restoreDraft(data.room, data.text, data.attachments); toast('发送失败，内容已恢复到草稿：' + data.error); }
  if (data.type === 'stream') {
    const event = data.event;
    if (event.type === 'agent-start') state.live.set(event.liveId, { room: data.room, memberId: event.memberId, text: '' });
    if (event.type === 'delta') { const live = state.live.get(event.liveId); if (live) live.text += event.delta; }
    if (event.type === 'agent-end') { state.live.delete(event.liveId); if (event.error) toast('Agent 回复失败：' + event.error); }
    if (data.room === state.current) scheduleMessages();
  }
};
(async () => { try { const location = await api('/data-location'); if (location.warning) toast(location.warning); await refresh(); applyTheme((await api('/theme')).theme); const id = localStorage.getItem('agent-room:selected'); if (state.conversations.some((row) => row.id === id)) await openConversation(id); } catch (error) { toast(error.message); } })();

const alarmButton = document.createElement('button');
alarmButton.id = 'alarms'; alarmButton.textContent = '◷ 闹钟'; alarmButton.title = '设置、查看和取消当前会话的闹钟';
$('#mention').after(alarmButton);
async function showAlarms() {
  if (!state.current) return;
  const room = state.current;
  try {
    const data = await api('/alarms?room=' + encodeURIComponent(room));
    const status = { pending: '等待触发', fired: '已触发', cancelled: '已取消' };
    showModal('会话闹钟', '<p class="hint">在输入框发送 /alarm 10m #成员 备注；@成员 为公开提醒。支持 s、m、h、d 或含时区的日期时间。应用关闭时不运行，重启后补发。</p><button type="button" id="alarm-compose">填入闹钟指令</button>' + (data.alarms.length ? data.alarms.slice().reverse().map(a => '<div class="alarm-row"><strong>' + escapeHtml((a.visibility === 'private' ? '#' : '@') + a.targetLabel) + '</strong> · ' + escapeHtml(new Date(a.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) + ' 北京时间 · ' + status[a.status] + '<p>' + escapeHtml(a.note) + '</p>' + (a.error ? '<p class="hint">投递失败，将重试：' + escapeHtml(a.error) + '</p>' : '') + (a.status === 'pending' ? '<button type="button" data-cancel-alarm="' + escapeHtml(a.id) + '">取消闹钟</button>' : '') + '</div>').join('') : '<p>当前没有闹钟。</p>'), null);
    $('#alarm-compose').onclick = () => {
      const row = state.conversations.find(c => c.id === room);
      const target = state.agents.find(a => a.id === row?.agentIds[0])?.label || '用户';
      $('#modal').close(); $('#draft').value = '/alarm 10m #' + target + ' 提醒备注'; state.drafts[room] = $('#draft').value; $('#draft').focus();
    };
    for (const button of document.querySelectorAll('[data-cancel-alarm]')) button.onclick = async () => {
      try { await api('/alarms/cancel', { room, id: button.dataset.cancelAlarm }); await showAlarms(); }
      catch (error) { toast(error.message); }
    };
  } catch (error) { toast(error.message); }
}
alarmButton.onclick = showAlarms;
