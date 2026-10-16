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
  const rows = state.conversations.filter((row) => (state.filter === 'all' || row.kind === state.filter) && (row.title.toLowerCase().includes(query) || row.agentIds.some((id) => state.agents.find((a) => a.id === id)?.label.toLowerCase().includes(query)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('#conversations').innerHTML = rows.length ? rows.map((row) => `<button class="conversation ${row.id === state.current ? 'active' : ''}" data-room="${row.id}" aria-current="${row.id === state.current}">${avatar(state.agents.find((a) => a.id === row.agentIds[0]), row.kind === 'group')}<div class="conversation-info"><div class="conversation-top"><strong>${escapeHtml(row.title)}</strong><time>${time(row.updatedAt)}</time>${state.unread.has(row.id) ? '<i class="unread"></i>' : ''}</div><p>${escapeHtml(row.preview || '开始聊天吧')}</p></div></button>`).join('') : '<p class="empty-list">' + (query ? '没有找到匹配的会话' : state.filter === 'group' ? '还没有群聊<br>选择几位伙伴，一起聊聊' : '点击搜索框旁的 ＋<br>添加你的第一位 AI 伙伴') + '</p>';
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
    return `<article class="message ${isUser ? 'user' : ''}">${isUser ? '<span class="avatar">我</span>' : avatar(agent)}<div class="message-main"><div class="message-meta"><span>${escapeHtml(record.authorLabel)}</span><time>${time(record.ts)}</time></div><div class="bubble">${escapeHtml(record.text)}${files}</div></div></article>`;
  }).join('');
  for (const live of state.live.values()) {
    if (live.room !== state.current) continue;
    const agent = state.agents.find((a) => a.id === live.memberId);
    panel.insertAdjacentHTML('beforeend', `<article class="message">${avatar(agent)}<div class="message-main"><div class="message-meta">${escapeHtml(agent?.label || 'Agent')} · 正在回复</div><div class="bubble">${escapeHtml(live.text || '正在思考…')}</div></div></article>`);
  }
  if (!panel.children.length) panel.innerHTML = '<div class="empty-chat"><strong>从一句「你好」开始</strong><p>文字、文件、图片，都可以分享。</p></div>';
  if (stick) panel.scrollTop = panel.scrollHeight;
  updateActivity();
}
function updateActivity() {
  const busy = state.snapshot?.busy?.length || 0;
  $('#activity').textContent = state.loading ? '正在上传…' : state.pending.has(state.current) ? '正在处理消息…' : busy ? `${busy} 位 Agent 正在回复…` : '';
  $('#send').disabled = !state.snapshot || state.pending.has(state.current) || state.loading > 0;
  $('#stop').hidden = !busy;
}
async function openConversation(id) {
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
  showModal('添加 Agent', `<p class="hint">给你的 AI 伙伴取个名字。相同后端也可以添加多位伙伴。</p><label class="field">名称<input name="label" required maxlength="40" placeholder="例如：灵感搭子" autofocus></label><label class="field">后端<select name="backend">${['codex', 'dsh', 'qoder'].map((id) => { const found = state.harnesses.find((h) => h.id === id); return `<option value="${id}">${id === 'dsh' ? 'DSH' : id === 'codex' ? 'Codex' : 'Qoder'} · ${found?.found || found?.configured ? '已发现 / 已配置' : '未检测到'}</option>`; }).join('')}</select></label><p class="hint" id="backend-hint"></p><label class="field">固定模型<select name="model" required></select></label><p class="hint" id="model-hint"></p><button type="button" id="reload-models">重新读取模型</button><label class="field">工作区文件夹<input name="workspace" placeholder="留空自动创建：后端名称/Agent 名称"></label><p class="hint" id="workspace-hint"></p><button type="button" id="choose-workspace">选择文件夹…</button><label class="field">角色设定 <span class="hint">（可选）</span><textarea name="persona" maxlength="2000" placeholder="例如：你是一位擅长发散思考的设计伙伴。"></textarea></label>`, async (form) => {
    const result = await api('/agents', Object.fromEntries(new FormData(form)));
    await refresh(); $('#modal').close(); await openConversation(result.conversation.id);
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
    showModal('后端管理', `<p class="hint">自动查找已安装的 CLI 和桌面后端。没有找到时，可手动填写程序或安装目录。发现入口不代表已经登录或连接成功。</p><label class="field">Agent 后端<select id="backend-id">${result.harnesses.map((row) => `<option value="${row.id}" ${row.id === selectedId ? 'selected' : ''}>${escapeHtml(row.label)} · ${row.found ? '已发现入口' : row.status === 'invalid' ? '配置失效' : row.status === 'installed' ? '需要配置' : '未发现'}</option>`).join('')}</select></label><p class="hint" id="backend-status"></p><button type="button" id="rescan">扫描设置 / 重新检测</button><label class="field">已发现的入口<select id="backend-candidates"></select></label><label class="field">程序或安装目录<input id="backend-path" placeholder="粘贴完整路径，例如 C:\\安装目录\\程序.exe" autocomplete="off"></label><button type="button" id="browse-backend" ${result.canBrowse ? '' : 'hidden'}>浏览选择程序…</button><p class="hint">手动查找：右键桌面或开始菜单快捷方式 → 打开文件所在的位置；若仍是快捷方式，查看属性中的“目标”。复制程序文件完整路径，桌面版也可浏览选择。手动模式不会扫描安装目录。</p><details><summary>高级：启动参数</summary><label class="field">参数 JSON 数组<textarea id="backend-args" placeholder='留空自动推导；例如 ["--acp"]'></textarea></label><p class="hint">仅在自定义启动方式时填写。每个参数单独一项，不要填整条命令。Codex 会自动追加 app-server 参数。</p></details><button type="button" id="backend-auto">恢复自动选择</button>`, async () => {
      const args = $('#backend-args').value.trim();
      await api('/backends', { id: $('#backend-id').value, path: $('#backend-path').value, ...(args ? { args: JSON.parse(args) } : {}) });
      $('#modal').close(); await refresh(); if (state.current) await openConversation(state.current); toast('后端配置已保存，下次发送时使用；连接与登录尚未验证');
    }, '保存配置');
    function fields() {
      const row = result.harnesses.find((r) => r.id === $('#backend-id').value);
      $('#backend-status').textContent = [row.detail, row.selected && `来源：${row.selected.source}`, row.warning].filter(Boolean).join(' · ');
      $('#backend-candidates').innerHTML = '<option value="">选择自动发现的入口</option>' + row.candidates.map((c) => `<option value="${escapeHtml(c.path)}">${escapeHtml(c.source + ' · ' + c.path)}</option>`).join('');
      $('#backend-path').value = row.preference?.path || row.selected?.path || '';
      $('#backend-args').value = row.preference?.args ? JSON.stringify(row.preference.args) : '';
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
  showModal('成员推理设置', '<p>固定模型：' + escapeHtml(agent.modelName || agent.model || '后端默认') + '</p><p>工作区：' + escapeHtml(agent.workspace || '默认') + '</p><p id="effort-loading">正在读取模型能力…</p>', null);
  try {
    const data = await api('/models', { backend: agent.backend, model: agent.model });
    if (!$('#effort-loading')) return;
    const model = data.models.find(m => m.id === agent.model);
    if (!model?.efforts.length) { $('#effort-loading').textContent = '后端未提供可调整的推理档位。'; return; }
    showModal('成员推理设置', '<p>固定模型：' + escapeHtml(agent.modelName || agent.model) + '</p><p>工作区：' + escapeHtml(agent.workspace || '默认') + '</p><label class="field">推理强度<select name="effort">' + model.efforts.map(e => '<option value="' + escapeHtml(e) + '">' + escapeHtml(e) + '</option>').join('') + '</select></label><p class="hint">仅影响当前会话中的这位 Agent，从下一条回复生效。</p>', async form => {
      await api('/member-effort', { room: roomId, agent: agentId, effort: new FormData(form).get('effort') });
      await refresh(); $('#modal').close(); toast('推理强度已保存');
    }, '保存设置');
    const row = state.conversations.find(r => r.id === roomId);
    $('#modal-content [name="effort"]').value = row.efforts?.[agentId] || agent.effort || model.defaultEffort || model.efforts[0];
  } catch(error) { if ($('#effort-loading')) $('#effort-loading').textContent = error.message; }
}
function showMembers(mention = false) {
  const row = state.conversations.find((c) => c.id === state.current); if (!row) return;
  showModal(mention ? '提及 Agent' : '会话成员', `<div class="picker">${row.agentIds.map((id) => { const agent = state.agents.find((a) => a.id === id); const status = state.snapshot?.members.find((m) => m.id === id); return `<button type="button" class="pick-row" data-mention="${agent.id}">${avatar(agent)}<span>${escapeHtml(agent.label)}<small>${escapeHtml(agent.backend)} · ${escapeHtml(status?.error || (status?.status === 'running' ? '正在回复' : '点击提及'))}</small></span></button>`; }).join('')}</div><p class="hint">群聊记录对所有成员可见，各会话上下文互相独立。</p>`, null);
  if (!mention) {
    for (const id of row.agentIds) {
      const agent = state.agents.find(a => a.id === id);
      if (!agent.modelLocked) continue;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = agent.label + ' · 推理设置';
      button.onclick = () => void memberEffort(id, row.id); $('#modal-content').append(button);
    }
  }
  $('#modal-content').onclick = (event) => { const button = event.target.closest('[data-mention]'); if (!button) return; const agent = state.agents.find((a) => a.id === button.dataset.mention); $('#draft').value += '@' + agent.label + ' '; state.drafts[state.current] = $('#draft').value; $('#modal').close(); $('#draft').focus(); };
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
async function send() {
  const id = state.current; const text = $('#draft').value.trim(); const files = state.uploads[id] || [];
  if ((!text && !files.length) || $('#send').disabled) return;
  state.pending.add(id); updateActivity();
  // Clear immediately so an asynchronous failure can restore the draft safely.
  $('#draft').value = ''; state.drafts[id] = ''; state.uploads[id] = []; renderAttachments();
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
$('#draft').oninput = () => { state.drafts[state.current] = $('#draft').value; };
$('#draft').onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } };
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
  if (data.type === 'snapshot' && data.room === state.current) { state.snapshot = data.snapshot; renderMessages(); }
  if (data.type === 'message' && data.room !== state.current) { state.unread.add(data.room); renderList(); }
  if (data.type === 'pending') { if (data.pending) state.pending.add(data.room); else state.pending.delete(data.room); updateActivity(); }
  if (data.type === 'failure') { restoreDraft(data.room, data.text, data.attachments); toast('发送失败，内容已恢复到草稿：' + data.error); }
  if (data.type === 'stream') {
    const event = data.event;
    if (event.type === 'agent-start') state.live.set(event.liveId, { room: data.room, memberId: event.memberId, text: '' });
    if (event.type === 'delta') { const live = state.live.get(event.liveId); if (live) live.text += event.delta; }
    if (event.type === 'agent-end') { state.live.delete(event.liveId); if (event.error) toast('Agent 回复失败：' + event.error); }
    if (data.room === state.current) renderMessages();
  }
};
(async () => { try { await refresh(); applyTheme((await api('/theme')).theme); const id = localStorage.getItem('agent-room:selected'); if (state.conversations.some((row) => row.id === id)) await openConversation(id); } catch (error) { toast(error.message); } })();
