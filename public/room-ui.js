/**
 * The room UI: a group-chat surface for the room engine.
 *
 * Deliberately framework-free and mount-anywhere, because the exact same code
 * runs in two hosts:
 *   - standalone (`public/index.html`) against a local HTTP server, and
 *   - inside DSH, mounted into the `sidebar.right.pane.tab` body.
 *
 * Nothing here talks to DSH: it speaks only the small JSON/SSE API in
 * `lib/server.cjs`, which is why the prototype is testable before it is a plugin.
 */
(function (global) {
  'use strict';

  const STYLE_ID = 'agent-room-style';

  /**
   * The window event both theme entry points use to say "the theme changed".
   *
   * The room UI and the DSH Settings row are mounted independently and neither
   * owns the other, so a shared event name is the whole coordination between
   * them. Exported so the client bundle cannot drift from it by typo.
   */
  const THEME_EVENT = 'agent-room:theme';

  const CSS = `
.ar-root{--ar-bg:#0f1117;--ar-panel:#171a22;--ar-line:#262b36;--ar-text:#e6e8ee;--ar-dim:#8b93a7;
  --ar-user:#3b82f6;--ar-accent:#f59e0b;--ar-veil:0.35;--ar-bg-image:none;
  height:100%;display:flex;flex-direction:column;background:var(--ar-bg);
  color:var(--ar-text);font:13px/1.55 ui-sans-serif,system-ui,"Segoe UI",sans-serif;overflow:hidden;
  position:relative}
.ar-root *{box-sizing:border-box}
/* The background is a separate layer rather than a \`background-image\` on
   .ar-root: a veil has to sit BETWEEN the picture and the text, and a
   pseudo-element is the only way to dim one without dimming the other. It is
   \`inset:0\` and \`z-index:0\` so every real child, which is positioned later in
   paint order, stays above it without each needing its own stacking rule. */
.ar-root::before{content:"";position:absolute;inset:0;z-index:0;pointer-events:none;
  background-image:var(--ar-bg-image);
  background-size:cover;background-position:center;background-repeat:no-repeat;
  opacity:1}
.ar-root::after{content:"";position:absolute;inset:0;z-index:0;pointer-events:none;
  background:var(--ar-bg);opacity:var(--ar-veil)}
.ar-root>[data-el],.ar-root>.ar-head,.ar-root>.ar-rooms,.ar-root>.ar-members,.ar-root>.ar-add,
.ar-root>.ar-log,.ar-root>.ar-foot{position:relative;z-index:1}
/* Only the transcript is see-through. The bars keep their opaque panels on
   purpose: they carry the controls, and controls drawn over an arbitrary
   user-supplied photograph stop being reliably readable. The background is
   therefore a backdrop for the conversation, which is also where the eye
   spends its time. */
.ar-log{background:transparent}
.ar-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--ar-line);
  background:var(--ar-panel);flex:0 0 auto;flex-wrap:wrap}
.ar-title{font-weight:600;font-size:13px;margin-right:2px}
.ar-sub{color:var(--ar-dim);font-size:11px}
.ar-spacer{flex:1 1 auto}
.ar-rooms{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:6px 10px;border-bottom:1px solid var(--ar-line);
  background:var(--ar-panel);flex:0 0 auto}
.ar-rooms .ar-rooms-label{color:var(--ar-dim);font-size:11px;margin-right:1px}
.ar-room{display:flex;align-items:center;gap:6px;border:1px solid var(--ar-line);background:var(--ar-bg);
  color:var(--ar-text);border-radius:999px;padding:2px 10px;font:inherit;font-size:11.5px;cursor:pointer;max-width:240px}
.ar-room:hover{border-color:#3a4256}
.ar-room.on{background:var(--ar-user);border-color:var(--ar-user);color:#fff;font-weight:600}
.ar-room .ar-room-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ar-room .ar-room-meta{color:var(--ar-dim);font-size:10.5px}
.ar-room.on .ar-room-meta{color:#dbeafe}
.ar-seg{display:flex;border:1px solid var(--ar-line);border-radius:7px;overflow:hidden}
.ar-seg button{background:transparent;border:0;color:var(--ar-dim);padding:4px 10px;cursor:pointer;font:inherit;font-size:12px}
.ar-seg button.on{background:var(--ar-user);color:#fff;font-weight:600}
.ar-btn{background:var(--ar-panel);border:1px solid var(--ar-line);color:var(--ar-text);border-radius:7px;
  padding:4px 9px;cursor:pointer;font:inherit;font-size:12px}
.ar-btn:hover{border-color:#3a4256}
.ar-btn:disabled{opacity:.45;cursor:default}
.ar-members{display:flex;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--ar-line);flex:0 0 auto;align-items:center}
.ar-chip{display:flex;align-items:center;gap:5px;border:1px solid var(--ar-line);border-radius:999px;
  padding:2px 9px;font-size:11.5px;cursor:pointer;background:var(--ar-panel)}
.ar-chip .ar-dot{width:7px;height:7px;border-radius:50%;background:#4b5567}
.ar-chip.thinking .ar-dot{background:var(--ar-accent);animation:ar-pulse 1s infinite}
.ar-chip.idle .ar-dot{background:#22c55e}
.ar-chip.error .ar-dot{background:#ef4444}
.ar-chip.cold .ar-dot{background:#4b5567}
@keyframes ar-pulse{50%{opacity:.35}}
.ar-chip .ar-meta{color:var(--ar-dim);font-size:10.5px}
.ar-chip .ar-model{color:var(--ar-dim);font-size:10.5px;border-bottom:1px dotted #3a4256}
.ar-chip .ar-model:hover{color:var(--ar-text)}
.ar-chip .ar-kill{color:var(--ar-dim);font-size:13px;line-height:1;padding:0 1px;border-radius:4px;opacity:0}
.ar-chip:hover .ar-kill{opacity:1}
.ar-chip .ar-kill:hover{color:#fca5a5}
.ar-add{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 10px;border-bottom:1px solid var(--ar-line);
  background:var(--ar-panel);flex:0 0 auto}
.ar-add[hidden]{display:none}
.ar-add input,.ar-add select{background:var(--ar-bg);color:var(--ar-text);border:1px solid var(--ar-line);
  border-radius:6px;padding:4px 7px;font:inherit;font-size:12px;outline:none}
.ar-add input:focus,.ar-add select:focus{border-color:var(--ar-user)}
.ar-add input.ar-id{width:96px}
.ar-add input.ar-label{width:96px}
.ar-add input.ar-persona{flex:1 1 200px;min-width:140px}
.ar-add .ar-addhint{color:var(--ar-dim);font-size:11px;flex:1 1 100%}
.ar-log{flex:1 1 auto;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:9px}
.ar-row{display:flex;flex-direction:column;gap:2px;max-width:100%}
.ar-who{font-size:11px;color:var(--ar-dim);display:flex;align-items:center;gap:6px}
.ar-who b{color:#a5b4fc;font-size:11.5px}
.ar-row.user .ar-who b{color:#60a5fa}
.ar-row.system .ar-who b{color:#f59e0b}
.ar-bubble{white-space:pre-wrap;word-break:break-word;padding:7px 10px;border-radius:9px;background:var(--ar-panel);
  border:1px solid var(--ar-line)}
.ar-row.user .ar-bubble{background:#1c2740;border-color:#2b3c63}
.ar-row.system .ar-bubble{background:transparent;border:1px dashed var(--ar-line);color:var(--ar-dim);font-size:12px}
.ar-row.live .ar-bubble{border-color:var(--ar-accent);border-style:dashed;color:#cbd5e1}
.ar-row.mentioned .ar-bubble{border-color:#4b5b8a}
.ar-row.private-message .ar-bubble{background:color-mix(in srgb,#9b72cf 18%,var(--ar-panel));border-color:#9b72cf}
.ar-mention{color:var(--ar-accent);font-weight:600}
.ar-tools{display:flex;flex-direction:column;gap:3px;margin-top:2px}
.ar-tool{font-size:11px;color:var(--ar-dim);font-family:ui-monospace,Consolas,monospace;
  border-left:2px solid var(--ar-line);padding-left:7px;white-space:pre-wrap;word-break:break-all}
.ar-tool.err{color:#fca5a5;border-color:#7f1d1d}
.ar-caret{display:inline-block;width:6px;height:13px;background:var(--ar-accent);vertical-align:-2px;
  animation:ar-blink 1s steps(2) infinite}
@keyframes ar-blink{50%{opacity:0}}
.ar-foot{flex:0 0 auto;border-top:1px solid var(--ar-line);background:var(--ar-panel);padding:8px 10px}
.ar-inputwrap{display:flex;gap:8px;align-items:flex-end}
.ar-input{flex:1 1 auto;resize:none;background:var(--ar-bg);color:var(--ar-text);border:1px solid var(--ar-line);
  border-radius:9px;padding:8px 10px;font:inherit;min-height:38px;max-height:160px;outline:none}
.ar-input:focus{border-color:var(--ar-user)}
.ar-hint{color:var(--ar-dim);font-size:11px;margin-top:5px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.ar-empty{color:var(--ar-dim);text-align:center;padding:22px 10px;font-size:12px}
.ar-err{color:#fca5a5;font-size:11.5px}
.ar-toggle{display:flex;align-items:center;gap:4px;color:var(--ar-dim);font-size:11px;cursor:pointer}

/* --- attachments ------------------------------------------------------- */
/* The tray sits above the composer and only exists while something is
   attached, so the common case (no attachment) costs no vertical space. */
.ar-tray{display:flex;gap:6px;flex-wrap:wrap;padding:0 0 7px}
.ar-tray[hidden]{display:none}
.ar-att{display:flex;align-items:center;gap:6px;max-width:210px;border:1px solid var(--ar-line);
  background:var(--ar-bg);border-radius:7px;padding:3px 6px;font-size:11px}
.ar-att.bad{border-color:#7f1d1d}
.ar-att .ar-att-thumb{width:26px;height:26px;border-radius:4px;object-fit:cover;flex:0 0 auto;
  background:var(--ar-panel);border:1px solid var(--ar-line)}
.ar-att .ar-att-icon{width:26px;height:26px;border-radius:4px;flex:0 0 auto;display:flex;align-items:center;
  justify-content:center;background:var(--ar-panel);border:1px solid var(--ar-line);font-size:12px;color:var(--ar-dim)}
.ar-att .ar-att-body{min-width:0;display:flex;flex-direction:column}
.ar-att .ar-att-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ar-att .ar-att-meta{color:var(--ar-dim);font-size:10px}
.ar-att .ar-att-x{border:0;background:transparent;color:var(--ar-dim);cursor:pointer;font:inherit;font-size:13px;
  line-height:1;padding:0 1px;border-radius:4px}
.ar-att .ar-att-x:hover{color:#fca5a5}
.ar-att.progress .ar-att-meta{color:var(--ar-accent)}
.ar-clip{border:1px solid var(--ar-line);background:var(--ar-bg);color:var(--ar-text);border-radius:9px;
  padding:0 10px;cursor:pointer;font:inherit;font-size:15px;height:38px;flex:0 0 auto}
.ar-clip:hover{border-color:var(--ar-user)}
.ar-clip:disabled{opacity:.45;cursor:default}
/* Dropping a file anywhere on the room is the gesture people reach for; the
   outline is the only feedback that the drop will land somewhere useful. */
.ar-root.dragover{outline:2px dashed var(--ar-user);outline-offset:-4px}
/* A bubble's own attachments: a thumbnail grid, then a chip per file. */
.ar-files{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.ar-bubble .ar-fileimg{max-width:190px;max-height:140px;border-radius:7px;border:1px solid var(--ar-line);
  display:block;cursor:pointer;background:var(--ar-panel)}
.ar-bubble .ar-file{display:flex;align-items:center;gap:5px;border:1px solid var(--ar-line);border-radius:6px;
  padding:2px 7px;font-size:11px;color:var(--ar-dim);max-width:220px}
.ar-bubble .ar-file b{color:var(--ar-text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* --- theme editor ------------------------------------------------------ */
.ar-theme{display:flex;flex-direction:column;gap:9px;padding:10px;border-bottom:1px solid var(--ar-line);
  background:var(--ar-panel);flex:0 0 auto;max-height:52%;overflow-y:auto}
.ar-theme[hidden]{display:none}
.ar-theme h4{margin:0;font-size:12px;font-weight:600}
.ar-theme .ar-theme-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ar-theme label{display:flex;align-items:center;gap:5px;color:var(--ar-dim);font-size:11px}
.ar-theme input[type=color]{width:34px;height:24px;padding:0;border:1px solid var(--ar-line);border-radius:5px;
  background:var(--ar-bg);cursor:pointer}
.ar-theme select,.ar-theme input[type=url],.ar-theme input[type=text]{background:var(--ar-bg);color:var(--ar-text);
  border:1px solid var(--ar-line);border-radius:6px;padding:4px 7px;font:inherit;font-size:12px;outline:none}
.ar-theme input[type=url]{flex:1 1 200px;min-width:140px}
.ar-theme select:focus,.ar-theme input:focus{border-color:var(--ar-user)}
.ar-theme .ar-theme-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ar-theme .ar-theme-note{color:var(--ar-dim);font-size:10.5px}
.ar-presets{display:flex;gap:5px;flex-wrap:wrap}
.ar-preset{border:1px solid var(--ar-line);border-radius:6px;padding:2px 8px;background:var(--ar-bg);
  color:var(--ar-text);font:inherit;font-size:11px;cursor:pointer}
.ar-preset:hover{border-color:var(--ar-user)}
.ar-preset.on{border-color:var(--ar-user);font-weight:600}
.ar-toggle-theme{border:1px solid var(--ar-line);background:var(--ar-panel);color:var(--ar-text);border-radius:7px;
  padding:4px 9px;cursor:pointer;font:inherit;font-size:12px}
.ar-toggle-theme.on{border-color:var(--ar-user)}
`;

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /** Mirror of the engine's decline marker, so the live bubble never flashes it. */
  const NO_ADDENDUM = /^[\s（(【\[]*无补充[\s）)】\]。.!！?？~～]*$/;

  function isNoAddendum(text) {
    return NO_ADDENDUM.test(String(text == null ? '' : text).trim());
  }

  /** `@name` is public emphasis: render it highlighted, never as a private channel. */
  function renderText(text, members) {
    let html = escapeHtml(text);
    const handles = new Set();
    for (const member of members) {
      handles.add(member.id);
      handles.add(member.label);
      if (member.aliases) for (const alias of member.aliases) handles.add(alias);
    }
    for (const handle of handles) {
      if (!handle) continue;
      const escaped = escapeHtml(handle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp('@' + escaped + '(?![\\w\\u4e00-\\u9fa5])', 'gi'), (m) => `<span class="ar-mention">${m}</span>`);
    }
    return html;
  }

  /**
   * Mount the room UI into `container`.
   * @returns {{destroy: function}}
   */
  function mount(container, options) {
    const doc = container.ownerDocument || document;
    ensureStyle(doc);
    const opts = options || {};
    const base = (opts.base || '').replace(/\/$/, '');
    /**
     * The room being shown. Mutable on purpose: the switcher changes it in
     * place, and every request that follows reads the current value. The mount
     * option is only the *starting* room.
     */
    let roomId = opts.room || 'default';
    /**
     * Told to the host whenever the user switches rooms, so the choice can be
     * persisted outside the UI (the DSH tab keeps it in `localStorage`). The
     * standalone page simply does not pass one.
     */
    const onRoomChange = typeof opts.onRoomChange === 'function' ? opts.onRoomChange : null;

    const root = doc.createElement('div');
    root.className = 'ar-root';
    root.innerHTML = `
      <div class="ar-head">
        <span class="ar-title">群聊</span>
        <span class="ar-sub" data-el="status">连接中…</span>
        <span class="ar-spacer"></span>
        <button class="ar-toggle-theme" data-el="showtheme" title="改这个房间的颜色和背景">外观</button>
        <div class="ar-seg" data-el="modes"></div>
      </div>
      <div class="ar-theme" data-el="themepanel" hidden></div>
      <div class="ar-rooms">
        <span class="ar-rooms-label">房间</span>
        <span data-el="rooms" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></span>
        <button class="ar-btn" data-el="new-room" title="另开一个房间（新的日志与成员列表）">+ 新建房间</button>
        <button class="ar-btn" data-el="delete-room" title="删除当前房间：回收进程并删除日志与成员文件">删除房间</button>
      </div>
      <div class="ar-members" data-el="members"></div>
      <div class="ar-add" data-el="addpanel" hidden>
        <input class="ar-id" data-el="add-id" placeholder="id（如 claude）" spellcheck="false">
        <input class="ar-label" data-el="add-label" placeholder="显示名（可选）" spellcheck="false">
        <select data-el="add-backend" title="这个群友跑在哪个后端上"></select>
        <select data-el="add-model" title="使用的模型"></select>
        <input class="ar-persona" data-el="add-persona" placeholder="人设：你擅长什么、该怎么回答（可选）" spellcheck="false">
        <button class="ar-btn" data-el="add-ok">添加</button>
        <button class="ar-btn" data-el="add-cancel">取消</button>
        <div class="ar-addhint" data-el="add-hint"></div>
      </div>
      <div class="ar-log" data-el="log"></div>
      <div class="ar-foot">
        <div class="ar-tray" data-el="tray" hidden></div>
        <div class="ar-inputwrap">
          <button class="ar-clip" data-el="attach" title="添加图片或文件（也可以直接拖进来，或粘贴剪贴板里的图片）">＋</button>
          <input type="file" data-el="file" multiple hidden>
          <input type="file" data-el="bgfile" accept="image/*" hidden>
          <textarea class="ar-input" data-el="input" rows="1"
            placeholder="发消息给房间… 用 @codex 点名（所有人可见）"></textarea>
          <button class="ar-btn" data-el="send">发送</button>
        </div>
        <div class="ar-hint">
          <span data-el="policy"></span>
          <label class="ar-toggle"><input type="checkbox" data-el="showtools"> 显示工具调用</label>
          <span data-el="err" class="ar-err"></span>
        </div>
      </div>
    `;
    container.appendChild(root);

    const el = (name) => root.querySelector(`[data-el="${name}"]`);
    const logEl = el('log');
    const inputEl = el('input');

    let snapshot = { members: [], log: [], mode: 'chat', connected: false };
    // Last `/rooms` read: what other rooms exist, for the switcher. Each entry
    // is `{ room, title, members, logFile }` as served by `GET /rooms`.
    let roomList = [];
    // Last `/models` read: which backends exist and what each one offers.
    // Needed before the roster can be edited (the add form is built from it).
    let catalog = { models: [], backends: [], harnesses: [] };
    let live = new Map();
    let showTools = false;
    let sending = false;
    let placeholder = null;
    let source = null;
    let destroyed = false;
    /**
     * Bumped on every connect() and on every room switch. An in-flight `/state`
     * read that comes back after the user has already switched rooms must be
     * dropped, or the old room's snapshot would be painted under the new room's
     * name — a race the UI cannot recover from by itself.
     */
    let generation = 0;
    /**
     * The theme as the host last reported it, and the presets it offered. Kept
     * as the single source of truth for the picker: the inputs render from this,
     * never from their own DOM state, so a rejected value visibly snaps back
     * instead of leaving the UI claiming a colour the room is not painting.
     */
    let theme = null;
    let presets = [];
    /** Files staged for the next message: `{id,name,bytes,mediaType,isImage,localUrl}`. */
    let pending = [];
    let uploading = 0;
    /**
     * What the host said it accepts for uploads. Read before, not after, the
     * user picks a file: the host can run with uploads switched off entirely
     * (`filesDir: null`), and a picker that opens and then fails with "uploads
     * are unavailable here" wastes the choice and looks broken. `null` means the
     * host did not say, in which case the button stays available — an older host
     * without the field still uploads fine.
     */
    let uploads = null;
    let showTheme = false;

    /** The `--ar-*` properties the host owns, mirrored from `lib/theme.cjs`. */
    const THEME_TOKENS = ['--ar-bg', '--ar-panel', '--ar-line', '--ar-text', '--ar-dim', '--ar-user', '--ar-accent'];
    const TOKEN_LABELS = {
      '--ar-bg': '背景',
      '--ar-panel': '面板',
      '--ar-line': '分隔线',
      '--ar-text': '正文',
      '--ar-dim': '次要文字',
      '--ar-user': '我/强调',
      '--ar-accent': '高亮',
    };

    /**
     * Paint a theme onto this room.
     *
     * Applied to `root` rather than to `document`: the room may be one tab of
     * several, and a theme written to the document would repaint the whole
     * harness — including chrome this plugin does not own. Writing custom
     * properties on the room's own element also means two mounted rooms (the
     * standalone page and the tab, or two tabs) cannot fight over one palette.
     *
     * Only names on `THEME_TOKENS` are written. The host already refuses
     * anything else, but a UI that trusted the host to be the only writer would
     * turn any future host change into a way to set arbitrary CSS from a
     * response body.
     */
    function applyTheme(next) {
      if (next) theme = next;
      const colors = (theme && theme.colors) || {};
      for (const token of THEME_TOKENS) {
        const value = colors[token];
        if (typeof value === 'string' && value.trim()) root.style.setProperty(token, value.trim());
      }
      const veil = theme && Number.isFinite(theme.veil) ? theme.veil : 0.35;
      root.style.setProperty('--ar-veil', String(veil));
      const background = theme && theme.background;
      if (background && background.kind === 'file') {
        // The version is what makes a replaced image actually replace: without
        // it the URL is unchanged and the browser serves the cached old one.
        root.style.setProperty('--ar-bg-image', `url("${base}/background?v=${background.version || 1}")`);
      } else if (background && background.kind === 'url') {
        root.style.setProperty('--ar-bg-image', `url("${background.value}")`);
      } else {
        root.style.setProperty('--ar-bg-image', 'none');
      }
    }

    function setError(message) {
      el('err').textContent = message || '';
    }

    function renderMembers() {
      const members = snapshot.members || [];
      const host = el('members');
      host.innerHTML = '';
      if (!members.length) {
        const empty = doc.createElement('span');
        empty.className = 'ar-sub';
        empty.textContent = '没有成员，点右边「+ 添加成员」';
        host.appendChild(empty);
      }
      for (const member of members) {
        const chip = doc.createElement('span');
        chip.className = 'ar-chip ' + (member.status || 'cold');
        chip.title = `model: ${member.model || 'agent default'}${member.backend ? '\nbackend: ' + member.backend : ''}${
          member.error ? '\nerror: ' + member.error : ''
        }\ntokens: ${member.tokens}\nqueued: ${member.queued || 0} 段${member.activeSegment ? '（正在读 ' + member.activeSegment + '）' : ''}${
          member.steered ? '\n插话(steer): ' + member.steered : ''
        }${member.preempted ? '\n被抢占: ' + member.preempted : ''}${member.shed ? '\n因积压丢弃: ' + member.shed : ''}`;
        if (member.error) chip.classList.add('error');

        const dot = doc.createElement('span');
        dot.className = 'ar-dot';
        const name = doc.createElement('span');
        name.textContent = '@' + member.id;
        chip.append(dot, name);

        // The model is the control, not a label: click it to re-point this
        // member. A member's model is the whole reason to have several members.
        const model = doc.createElement('span');
        model.className = 'ar-model';
        // `model` is null when the member was added with the field blank, which
        // means "whatever the agent defaults to" — say so instead of printing
        // "null" or a model name the backend never agreed to.
        model.textContent =
          (member.model || '默认模型') + (member.backend && member.backend !== 'codex' ? ` · ${member.backend}` : '');
        model.title = '点击切换这个群友使用的模型';
        model.onclick = (event) => {
          event.stopPropagation();
          beginModelEdit(chip, model, member);
        };
        chip.appendChild(model);

        if (member.tokens) {
          const meta = doc.createElement('span');
          meta.className = 'ar-meta';
          meta.textContent = `${Math.round(member.tokens / 1000)}k`;
          chip.appendChild(meta);
        }

        const kill = doc.createElement('span');
        kill.className = 'ar-kill';
        kill.textContent = '×';
        kill.title = `移除 @${member.id}`;
        kill.onclick = async (event) => {
          event.stopPropagation();
          if (!global.confirm(`把 @${member.id} 移出房间？`)) return;
          try {
            await post('/remove-member', { id: member.id });
          } catch (error) {
            setError(error.message);
          }
        };
        chip.appendChild(kill);

        // Clicking the chip still just inserts an @mention: @ is emphasis.
        chip.onclick = () => {
          inputEl.value = (inputEl.value + ' @' + member.id).trim() + ' ';
          inputEl.focus();
        };
        host.appendChild(chip);
      }

      const add = doc.createElement('button');
      add.className = 'ar-btn';
      add.textContent = '+ 添加成员';
      add.title = '拉一个新群友进来：可以再加一个 codex 会话，也可以接别家 harness';
      add.onclick = () => toggleAddPanel(true);
      host.appendChild(add);

      const titles = { chat: 'CHAT', work: 'WORK' };
      el('modes').innerHTML = '';
      for (const mode of ['chat', 'work']) {
        const button = doc.createElement('button');
        button.textContent = titles[mode];
        if (snapshot.mode === mode) button.className = 'on';
        button.title =
          mode === 'chat'
            ? '快问快答：最低推理档、只读沙箱，不能改文件'
            : '干活模式：高推理档、可读写文件与执行命令';
        button.onclick = () => post('/mode', { mode }).catch((error) => setError(error.message));
        el('modes').appendChild(button);
      }
      const policyLabels = {
        addressed: '@ 点名的人回答，没点名则全员回答',
        everyone: '每条消息全员都回答（@ 只是强调）',
        'mentioned-only': '只有被 @ 的人回答',
      };
      el('policy').textContent = policyLabels[snapshot.replyPolicy] || '';
      renderRooms();
    }

    /**
     * The room switcher.
     *
     * The current room is always shown, even mid-switch when `GET /rooms` has
     * not answered yet: a switcher that omits the room you are looking at reads
     * as "you are nowhere", and the entry is also the only way back if the list
     * comes back without it (a room created a moment ago, say).
     */
    function renderRooms() {
      const host = el('rooms');
      if (!host) return;
      const rows = roomList.slice();
      if (!rows.some((row) => row.room === roomId)) {
        rows.unshift({ room: roomId, title: snapshot.title || roomId, members: (snapshot.members || []).length });
      }
      host.innerHTML = '';
      for (const row of rows) {
        const button = doc.createElement('button');
        button.className = 'ar-room' + (row.room === roomId ? ' on' : '');
        button.title = `${row.room}${row.logFile ? '\n日志：' + row.logFile : ''}`;
        const name = doc.createElement('span');
        name.className = 'ar-room-name';
        // A room with no title is normal (one just created): show its id rather
        // than an empty chip, and never show the internal id twice.
        name.textContent = row.title && row.title !== row.room ? `${row.title} · ${row.room}` : row.room;
        const meta = doc.createElement('span');
        meta.className = 'ar-room-meta';
        meta.textContent = `${row.members || 0} 人`;
        button.append(name, meta);
        button.onclick = () => switchRoom(row.room);
        host.appendChild(button);
      }
    }

    async function loadRooms() {
      try {
        const response = await fetch(`${base}/rooms`, { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json();
        const details = Array.isArray(payload.details) ? payload.details : [];
        const ids = Array.isArray(payload.rooms) ? payload.rooms : [];
        // `details` is authoritative when present, but `rooms` is the key the
        // API has always guaranteed, so a payload without details still yields a
        // usable (id-only) switcher.
        roomList = details.length
          ? details
          : ids.map((id) => ({ room: id, title: id, members: 0, logFile: null }));
        renderRooms();
      } catch {}
    }

    /** Close the old stream before opening a new one, and re-read state. */
    async function switchRoom(next) {
      const key = next || 'default';
      if (key === roomId) {
        await connect();
        return;
      }
      roomId = key;
      if (onRoomChange) onRoomChange(roomId);
      // Everything on screen belongs to the previous room.
      live = new Map();
      snapshot = { members: [], log: [], mode: 'chat', connected: false };
      inputEl.value = '';
      setError('');
      renderMembers();
      renderLog();
      renderRooms();
      await connect();
      await loadRooms();
    }

    async function createRoom() {
      el('new-room').disabled = true;
      try {
        const payload = await rawPost('/new-room', {});
        await switchRoom(payload.room);
      } catch (error) {
        setError(error.message);
      } finally {
        el('new-room').disabled = false;
      }
    }

    async function deleteRoom() {
      if (!global.confirm(`删除房间「${roomId}」？这会回收它的进程并删除日志与成员文件，无法撤销。`)) return;
      el('delete-room').disabled = true;
      try {
        // `force` because a room with this very tab's SSE stream attached is
        // otherwise refused — and the stream is about to be torn down with it.
        await rawPost('/delete-room', { room: roomId, force: true });
        // Prefer a real room to land in; `default` is always a valid answer and
        // the server will simply create it on the next `/state` read.
        const remaining = roomList.map((row) => row.room).filter((id) => id !== roomId);
        await switchRoom(remaining[0] || 'default');
      } catch (error) {
        setError(error.message);
      } finally {
        el('delete-room').disabled = false;
      }
    }

    /** Swap a chip's model label for a select, and commit on change. */
    function beginModelEdit(chip, label, member) {
      const options = modelsFor(member.backend);
      if (!options.length) {
        // Not a transient failure: this backend publishes no model list, so
        // there is nothing to switch to. Say that, instead of "try again later".
        setError(`后端 ${member.backend || 'codex'} 没有提供模型列表，无法切换模型`);
        return;
      }
      const select = doc.createElement('select');
      for (const model of options) {
        const option = doc.createElement('option');
        option.value = model;
        option.textContent = model;
        if (model === member.model) option.selected = true;
        select.appendChild(option);
      }
      // A member whose model is not in the catalogue (or a backend that offers
      // none) must still show what it is running, or the select would silently
      // misrepresent the member. A null model means "the agent decides", which
      // is a real state and not a missing value: show it as such, as an
      // uncommittable first entry, rather than a blank or a fake name.
      if (!member.model || !options.includes(member.model)) {
        const option = doc.createElement('option');
        option.value = member.model || '';
        option.textContent = member.model || '默认模型（跟着 agent 走）';
        option.selected = true;
        select.appendChild(option);
      }
      chip.replaceChild(select, label);
      select.focus();
      let done = false;
      const commit = async () => {
        if (done) return;
        done = true;
        if (select.value !== member.model) {
          try {
            await post('/member', { id: member.id, model: select.value });
          } catch (error) {
            setError(error.message);
          }
        }
        renderMembers();
      };
      select.onchange = commit;
      select.onblur = commit;
      select.onclick = (event) => event.stopPropagation();
    }

    /** Models the given backend offers, from the last `/models` read. */
    function modelsFor(backend) {
      const rows = catalog.models || [];
      const names = rows.filter((row) => !backend || row.backend === backend).map((row) => row.model);
      return Array.from(new Set(names));
    }

    /** Fill the add-member form from the live catalogue. */
    function refreshAddForm() {
      const backends = catalog.backends && catalog.backends.length ? catalog.backends : ['codex'];
      const backendEl = el('add-backend');
      const previous = backendEl.value;
      backendEl.innerHTML = '';
      for (const backend of backends) {
        const option = doc.createElement('option');
        option.value = backend;
        // The label comes from the server's registry, so a harness is named
        // once — in `harnesses.cjs` — rather than in a second table here that
        // would drift the moment a harness is added. `detail` carries why an
        // offered-but-undetected harness is worth warning about.
        const row = (catalog.harnesses || []).find((entry) => entry.id === backend) || null;
        option.textContent = row ? row.label : backend;
        if (row && row.forced) option.textContent = `${row.label}（未检测到）`;
        if (row && row.detail) option.title = row.detail;
        backendEl.appendChild(option);
      }
      backendEl.value = backends.includes(previous) ? previous : backends[0];

      const modelEl = el('add-model');
      modelEl.innerHTML = '';
      const models = modelsFor(backendEl.value);
      // Blank model means "let the agent decide" — always offerable, and the
      // only option when this backend publishes no catalogue (the ACP case).
      const auto = doc.createElement('option');
      auto.value = '';
      auto.textContent = '默认模型（跟着 agent 走）';
      modelEl.appendChild(auto);
      for (const model of models) {
        const option = doc.createElement('option');
        option.value = model;
        option.textContent = model;
        modelEl.appendChild(option);
      }
      el('add-hint').textContent =
        backends.length > 1
          ? '同一个房间可以混装不同后端的群友：@ 是公开强调，所有人都能看到并旁听。'
          : `当前后端只有 ${backends[0] || 'codex'}。加一个群友 = 再加一个独立会话，可以配不同模型与人设；更多后端可在 设置 → 通用 中开启。`;
    }

    async function loadCatalog() {
      try {
        const response = await fetch(`${base}/models?room=${encodeURIComponent(roomId)}`, { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json();
        // Merge rather than replace: `/state` and `/models` each carry a piece of
        // this, and a response that happens to omit a field must not blank a
        // section the other one already filled in.
        catalog = {
          ...catalog,
          ...payload,
          harnesses: Array.isArray(payload.harnesses) && payload.harnesses.length ? payload.harnesses : catalog.harnesses,
        };
        refreshAddForm();
      } catch {}
    }

    function toggleAddPanel(show) {
      const panel = el('addpanel');
      panel.hidden = !show;
      if (show) {
        refreshAddForm();
        el('add-id').focus();
      }
    }

    async function submitAdd() {
      const id = el('add-id').value.trim();
      if (!id) {
        setError('请先填一个 id');
        return;
      }
      el('add-ok').disabled = true;
      try {
        const payload = await post('/members', {
          id,
          label: el('add-label').value.trim() || undefined,
          model: el('add-model').value || undefined,
          persona: el('add-persona').value.trim() || undefined,
          backend: el('add-backend').value || undefined,
        });
        const created = payload.member || {};
        el('add-id').value = '';
        el('add-label').value = '';
        el('add-persona').value = '';
        toggleAddPanel(false);
        setError('');
        if (created.id) {
          inputEl.value = (inputEl.value + ' @' + created.id).trim() + ' ';
          inputEl.focus();
        }
      } catch (error) {
        setError(error.message);
      } finally {
        el('add-ok').disabled = false;
      }
    }

    function renderLog() {
      if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
      placeholder = null;
      logEl.innerHTML = '';
      const records = (snapshot.log || []).slice();
      if (!records.length) {
        const empty = doc.createElement('div');
        empty.className = 'ar-empty';
        empty.textContent = '房间已就绪。发一条消息，所有 agent 都会听到。';
        logEl.appendChild(empty);
      }
      for (const record of records) appendRow(record);
      for (const [memberId, entry] of live) appendLive(memberId, entry);
      scrollToEnd();
    }

    function rowFor(record) {
      const row = doc.createElement('div');
      row.className = 'ar-row ' + (record.kind || 'agent');
      if (record.visibility === 'private') row.classList.add('private-message');
      const mine = (snapshot.members || []).find((m) => m.id === record.authorId);
      const who = record.kind === 'user' ? '你' : record.kind === 'system' ? '系统' : '@' + record.authorId;
      const time = record.ts ? new Date(record.ts).toLocaleTimeString() : '';
      row.innerHTML = `<div class="ar-who"><b>${escapeHtml(who)}</b><span>${escapeHtml(time)}</span>${
        mine && mine.model ? `<span class="ar-meta">${escapeHtml(mine.model)}</span>` : ''
      }</div>`;
      if (record.visibility === 'private') {
        const label = doc.createElement('div');
        label.className = 'ar-meta';
        label.textContent = '私聊 · ' + (record.authorLabel || who) + ' → ' + (record.recipientIds || []).map((id, i) => id === 'user' ? '用户' : ((snapshot.members || []).find(m => m.id === id)?.label || record.recipientLabels?.[i] || id)).join('、') + ' · 用户可见';
        row.appendChild(label);
      }
      const bubble = doc.createElement('div');
      bubble.className = 'ar-bubble';
      bubble.innerHTML = renderText(record.displayText || record.text, snapshot.members || []);
      const files = renderAttachments(record.attachments);
      if (files) bubble.appendChild(files);
      row.appendChild(bubble);
      return row;
    }

    /**
     * The pictures and files attached to one record.
     *
     * Images are shown, everything else is a chip: a transcript that rendered a
     * PDF or a 40 MB log inline would be unusable, while a thumbnail is the only
     * way to tell "this" from "the other one" when a message says "look at this".
     * Both link to `/attachment/<id>`, which serves the bytes back from the
     * store — a message attachment is never loaded from a path, because the
     * browser is not told any.
     */
    function renderAttachments(list) {
      if (!Array.isArray(list) || !list.length) return null;
      const wrap = doc.createElement('div');
      wrap.className = 'ar-files';
      for (const attachment of list) {
        if (!attachment || !attachment.id) continue;
        const href = `${base}/attachment/${encodeURIComponent(attachment.id)}`;
        if (attachment.isImage) {
          const link = doc.createElement('a');
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          const img = doc.createElement('img');
          img.className = 'ar-fileimg';
          img.src = href;
          img.alt = attachment.name || 'image';
          img.title = `${attachment.name || ''} · ${formatBytes(attachment.bytes)}`;
          // A file that vanished behind the room's back must degrade to its name
          // rather than showing a broken-image icon with no explanation.
          img.onerror = () => {
            const fallback = doc.createElement('span');
            fallback.className = 'ar-file';
            fallback.innerHTML = `<b>${escapeHtml(attachment.name || 'image')}</b><span>（已失效）</span>`;
            link.replaceWith(fallback);
          };
          link.appendChild(img);
          wrap.appendChild(link);
        } else {
          const link = doc.createElement('a');
          link.className = 'ar-file';
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.title = `${attachment.name || ''} · ${formatBytes(attachment.bytes)}`;
          link.innerHTML = `<span>📄</span><b>${escapeHtml(attachment.name || 'file')}</b><span>${escapeHtml(formatBytes(attachment.bytes))}</span>`;
          wrap.appendChild(link);
        }
      }
      return wrap.children.length ? wrap : null;
    }

    function appendRow(record) {
      logEl.appendChild(rowFor(record));
    }

    function appendLive(memberId, entry) {
      const row = doc.createElement('div');
      row.className = 'ar-row live';
      row.innerHTML = `<div class="ar-who"><b>@${escapeHtml(memberId)}</b><span>正在输入…</span></div>`;
      const bubble = doc.createElement('div');
      bubble.className = 'ar-bubble';
      // "(无补充)" is the decline marker the passive-turn prompt offers. It is
      // not room speech: the engine drops it before appending to the log, so
      // never let the streamed marker flash in the live bubble either.
      const shown = isNoAddendum(entry.text) ? '' : entry.text;
      bubble.innerHTML = shown
        ? renderText(shown, snapshot.members || []) + '<span class="ar-caret"></span>'
        : '<span class="ar-caret"></span>';
      row.appendChild(bubble);
      if (showTools && entry.tools.length) {
        const tools = doc.createElement('div');
        tools.className = 'ar-tools';
        for (const tool of entry.tools) {
          const line = doc.createElement('div');
          line.className = 'ar-tool' + (tool.type === 'error' ? ' err' : '');
          line.textContent = describeTool(tool);
          tools.appendChild(line);
        }
        row.appendChild(tools);
      }
      logEl.appendChild(row);
    }

    function describeTool(tool) {
      switch (tool.type) {
        case 'command':
          return `$ ${tool.command || ''}${tool.exitCode === undefined ? '' : `  → exit ${tool.exitCode}`}`;
        case 'fileChange':
          return `✎ 修改了 ${tool.changes} 个文件 (${tool.status || ''})`;
        case 'reasoning':
          return `… 思考：${(tool.text || '').replace(/\s+/g, ' ').slice(0, 160)}`;
        case 'error':
          return `! ${tool.message}`;
        case 'webSearch':
          return `⌕ ${tool.query}`;
        default:
          return `· ${tool.type}`;
      }
    }

    function scrollToEnd() {
      logEl.scrollTop = logEl.scrollHeight;
    }

    function applySnapshot(next) {
      snapshot = next;
      // The room's own view of itself is fresher than the last `/rooms` read,
      // so fold it back into the switcher's row for the current room.
      const own = roomList.find((row) => row.room === roomId);
      if (own) {
        if (next.title) own.title = next.title;
        own.members = (next.members || []).length;
      }
      renderMembers();
      renderLog();
      const status = el('status');
      if (!next.connected) status.textContent = '未连接';
      else status.textContent = `${(next.members || []).length} 个 agent · ${next.modeLabel || next.mode}`;
    }

    function handleEvent(message) {
      if (message.type === 'snapshot' || message.type === 'update') {
        applySnapshot(message.snapshot);
        return;
      }
      if (message.type === 'message') {
        if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
        placeholder = null;
        snapshot.log = (snapshot.log || []).concat([message.record]);
        appendRow(message.record);
        scrollToEnd();
        return;
      }
      if (message.type === 'stream') {
        const event = message.event || {};
        if (event.type === 'agent-start') {
          logEl.querySelector('.ar-empty')?.remove();
          live.set(event.memberId, { text: '', tools: [] });
          renderLog();
        } else if (event.type === 'delta') {
          const entry = live.get(event.memberId) || { text: '', tools: [] };
          entry.text += event.delta;
          live.set(event.memberId, entry);
          renderLog();
        } else if (event.type === 'item') {
          const entry = live.get(event.memberId) || { text: '', tools: [] };
          entry.tools.push(event.item);
          live.set(event.memberId, entry);
          if (showTools) renderLog();
        } else if (event.type === 'agent-end') {
          if (event.error) setError(`@${event.memberId}: ${event.error}`);
          live.delete(event.memberId);
          renderLog();
        }
        return;
      }
      if (message.type === 'log' && opts.onLog) opts.onLog(message.line);
    }

    async function connect() {
      const mine = ++generation;
      // The old stream must die before the new one is opened. Two live
      // EventSources would deliver two rooms' events into one log, and the
      // survivor would keep the previous room alive on the server besides.
      if (source) {
        source.close();
        source = null;
      }
      el('status').textContent = '连接中…';
      const query = `room=${encodeURIComponent(roomId)}`;
      try {
        const response = await fetch(`${base}/state?${query}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        // A switch may have happened while this read was in flight. Painting it
        // now would show the wrong room under the current name, so drop it —
        // the connect() that caused the switch is already on its way.
        if (mine !== generation) return;
        presets = Array.isArray(payload.themePresets) ? payload.themePresets : presets;
        if (payload.uploads && typeof payload.uploads === 'object') uploads = payload.uploads;
        // The harness rows ride along with the state so the add-member form can
        // name and describe its options on the very first paint, instead of
        // showing bare ids until `/models` comes back.
        if (Array.isArray(payload.harnesses)) catalog.harnesses = payload.harnesses;
        applyUploads();
        // The theme arrives with the state so the first frame is already painted
        // in the user's colours — fetching it separately would flash the default
        // palette on every reload.
        applyTheme(payload.theme || null);
        renderThemePanel();
        applySnapshot(payload.snapshot);
        // The harness rows arrived with this state; repaint the form so the
        // dropdown is named from the registry even if `/models` is slow or fails.
        refreshAddForm();
      } catch (error) {
        if (mine !== generation) return;
        el('status').textContent = '无法连接房间服务';
        setError(error.message);
        return;
      }
      if (mine !== generation) return;
      source = new EventSource(`${base}/events?${query}`);
      const liveSource = source;
      source.onmessage = (event) => {
        if (destroyed || liveSource !== source) return;
        try {
          handleEvent(JSON.parse(event.data));
        } catch (error) {
          setError('事件解析失败: ' + error.message);
        }
      };
      source.onerror = () => {
        if (destroyed || liveSource !== source) return;
        el('status').textContent = '连接中断，重试中…';
      };
    }

    /** POST without the implicit `room` — for routes that name their own room. */
    async function rawPost(path, body) {
      setError('');
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
      return payload;
    }

    async function post(path, body) {
      setError('');
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ room: roomId, ...body }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
      return payload;
    }

    /**
     * Upload one file and stage it for the next message.
     *
     * The bytes go up as the raw request body with the name and type in the
     * query string: it is our own `fetch`, so there is no form to negotiate, and
     * a `FormData` would only make the host parse an encoding we chose. The
     * local object URL is for the thumbnail only — it is revoked when the chip
     * goes away, so a long session of attaching pictures does not hold every
     * one of them in memory.
     */
    async function uploadFile(file) {
      uploading += 1;
      renderTray();
      const localUrl = file.type && file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      try {
        const query = `name=${encodeURIComponent(file.name || 'file')}&type=${encodeURIComponent(file.type || '')}`;
        const response = await fetch(`${base}/attach?${query}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          credentials: 'same-origin',
          body: file,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
        pending.push({ ...payload.attachment, localUrl });
      } catch (error) {
        if (localUrl) URL.revokeObjectURL(localUrl);
        setError(`「${file.name || 'file'}」上传失败：${error.message}`);
      } finally {
        uploading -= 1;
        renderTray();
      }
    }

    /** Stage every file from a picker, a drop or the clipboard. */
    function addFiles(files) {
      const list = Array.from(files || []);
      if (!list.length) return;
      // Sequential on purpose: the host enforces one size limit per request and
      // a burst of parallel uploads makes the progress state ambiguous, while a
      // queue keeps the error messages attributable to a specific file.
      void (async () => {
        for (const file of list) await uploadFile(file);
      })();
    }

    function dropAttachment(id) {
      const index = pending.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const [gone] = pending.splice(index, 1);
      if (gone && gone.localUrl) URL.revokeObjectURL(gone.localUrl);
      renderTray();
    }

    function renderTray() {
      const tray = el('tray');
      tray.innerHTML = '';
      const empty = !pending.length && !uploading;
      tray.hidden = empty;
      if (empty) return;
      for (const attachment of pending) {
        const chip = doc.createElement('span');
        chip.className = 'ar-att';
        const thumb = attachment.isImage && attachment.localUrl
          ? doc.createElement('img')
          : doc.createElement('span');
        if (thumb.tagName === 'IMG') {
          thumb.className = 'ar-att-thumb';
          thumb.src = attachment.localUrl;
          thumb.alt = '';
        } else {
          thumb.className = 'ar-att-icon';
          thumb.textContent = '📄';
        }
        const body = doc.createElement('span');
        body.className = 'ar-att-body';
        const name = doc.createElement('span');
        name.className = 'ar-att-name';
        name.textContent = attachment.name;
        name.title = attachment.name;
        const meta = doc.createElement('span');
        meta.className = 'ar-att-meta';
        meta.textContent = formatBytes(attachment.bytes);
        body.append(name, meta);
        const remove = doc.createElement('button');
        remove.className = 'ar-att-x';
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = '移除';
        remove.onclick = () => dropAttachment(attachment.id);
        chip.append(thumb, body, remove);
        tray.appendChild(chip);
      }
      if (uploading) {
        const chip = doc.createElement('span');
        chip.className = 'ar-att progress';
        chip.innerHTML = '<span class="ar-att-icon">…</span>';
        const body = doc.createElement('span');
        body.className = 'ar-att-body';
        const name = doc.createElement('span');
        name.className = 'ar-att-name';
        name.textContent = '上传中…';
        body.appendChild(name);
        chip.appendChild(body);
        tray.appendChild(chip);
      }
      // A message may be only attachments, so the button's enabled state must
      // follow the same rule `say()` does — otherwise the UI would refuse a send
      // the server would have accepted.
      el('send').disabled = sending || (!inputEl.value.trim() && !pending.length);
    }

    function formatBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * Reflect the host's upload capability on the composer.
     *
     * Disabling the button (and the file input) is the honest state when the host
     * runs without a files directory: there is nowhere to put the bytes, so the
     * only outcomes of opening a picker are a wasted dialog and an error. The
     * tooltip says why, because a disabled control with no explanation reads as a
     * bug.
     */
    function applyUploads() {
      const button = el('attach');
      const input = el('file');
      if (!button || !input) return;
      const allowed = !uploads || uploads.enabled !== false;
      button.disabled = !allowed;
      input.disabled = !allowed;
      if (!allowed) {
        button.title = '这个房间没有配置文件存放目录，无法上传';
        return;
      }
      const limit = uploads && uploads.maxLabel ? `，单个文件最大 ${uploads.maxLabel}` : '';
      button.title = `添加图片或文件（也可以直接拖进来，或粘贴剪贴板里的图片）${limit}`;
    }

    async function send() {
      const text = inputEl.value.trim();
      const attachments = pending.map((entry) => entry.id);
      // Same guard as the server: text or a file, either one is enough.
      if ((!text && !attachments.length) || sending || uploading) return;
      sending = true;
      el('send').disabled = true;
      setError('');
      try {
        await post('/say', { text, attachments });
        inputEl.value = '';
        inputEl.style.height = 'auto';
        for (const entry of pending) if (entry.localUrl) URL.revokeObjectURL(entry.localUrl);
        pending = [];
        renderTray();
      } catch (error) {
        // The attachments stay staged: a send that failed for an unrelated
        // reason (the room is gone, the host restarted) should not also cost the
        // user the files they picked.
        setError(error.message);
      } finally {
        sending = false;
        el('send').disabled = false;
        renderTray();
        inputEl.focus();
      }
    }

    /**
     * Build the appearance panel from the current theme.
     *
     * Rebuilt from `theme` on every change rather than mutated in place: a value
     * the host refuses must leave the input showing what the room is actually
     * painting, and re-rendering is the only way that stays true without tracking
     * which of two sources of truth won.
     */
    function renderThemePanel() {
      const panel = el('themepanel');
      panel.hidden = !showTheme;
      el('showtheme').classList.toggle('on', showTheme);
      if (!showTheme) return;
      panel.innerHTML = '';

      const title = doc.createElement('h4');
      title.textContent = '房间外观';
      panel.appendChild(title);

      const presetsRow = doc.createElement('div');
      presetsRow.className = 'ar-presets';
      for (const preset of presets) {
        const button = doc.createElement('button');
        button.className = 'ar-preset' + (theme && theme.preset === preset.id ? ' on' : '');
        button.type = 'button';
        button.textContent = preset.label;
        button.onclick = () => saveTheme({ preset: preset.id });
        presetsRow.appendChild(button);
      }
      panel.appendChild(presetsRow);

      const colorsRow = doc.createElement('div');
      colorsRow.className = 'ar-theme-row';
      for (const token of THEME_TOKENS) {
        const label = doc.createElement('label');
        label.textContent = TOKEN_LABELS[token] || token;
        const input = doc.createElement('input');
        input.type = 'color';
        input.value = toHexColor(theme && theme.colors && theme.colors[token]);
        input.title = `${TOKEN_LABELS[token] || token}（${token}）`;
        // `change`, not `input`: a colour picker fires `input` continuously while
        // the user drags, and saving on every frame would write the file dozens of
        // times per second.
        input.onchange = () => saveTheme({ colors: { [token]: input.value } });
        label.appendChild(input);
        colorsRow.appendChild(label);
      }
      panel.appendChild(colorsRow);

      const bgRow = doc.createElement('div');
      bgRow.className = 'ar-theme-row';
      const urlInput = doc.createElement('input');
      urlInput.type = 'url';
      urlInput.placeholder = '背景图 URL（http(s):// 或 / 开头的路径）';
      urlInput.value = theme && theme.background && theme.background.kind === 'url' ? theme.background.value : '';
      const applyUrl = doc.createElement('button');
      applyUrl.className = 'ar-btn';
      applyUrl.textContent = '用这个 URL';
      applyUrl.onclick = () => {
        const value = urlInput.value.trim();
        saveTheme({ background: value ? { kind: 'url', value } : null });
      };
      const pick = doc.createElement('button');
      pick.className = 'ar-btn';
      pick.textContent = '上传图片';
      pick.onclick = () => el('bgfile').click();
      const clear = doc.createElement('button');
      clear.className = 'ar-btn';
      clear.textContent = '清除背景';
      clear.onclick = () => saveTheme({ background: null });
      bgRow.append(urlInput, applyUrl, pick, clear);
      panel.appendChild(bgRow);

      const veilRow = doc.createElement('div');
      veilRow.className = 'ar-theme-row';
      const veilLabel = doc.createElement('label');
      veilLabel.textContent = '遮罩';
      const veil = doc.createElement('input');
      veil.type = 'range';
      veil.min = '0';
      veil.max = '0.95';
      veil.step = '0.05';
      veil.value = String(theme && Number.isFinite(theme.veil) ? theme.veil : 0.35);
      veil.style.flex = '0 0 130px';
      // The veil is a live preview while dragging — it costs no write, because
      // it is the same property `applyTheme` sets — and is persisted on release.
      veil.oninput = () => {
        root.style.setProperty('--ar-veil', veil.value);
      };
      veil.onchange = () => saveTheme({ veil: Number(veil.value) });
      const veilValue = doc.createElement('span');
      veilValue.className = 'ar-theme-note';
      veilValue.textContent = veil.value;
      veil.oninput = () => {
        root.style.setProperty('--ar-veil', veil.value);
        veilValue.textContent = veil.value;
      };
      veilLabel.append(veil, veilValue);
      veilRow.appendChild(veilLabel);
      panel.appendChild(veilRow);

      const actions = doc.createElement('div');
      actions.className = 'ar-theme-actions';
      const reset = doc.createElement('button');
      reset.className = 'ar-btn';
      reset.textContent = '恢复默认';
      reset.onclick = () => saveTheme({ preset: 'midnight', background: null, veil: 0.35 });
      const note = doc.createElement('span');
      note.className = 'ar-theme-note';
      note.textContent = '外观对所有房间生效，存在 DSH 配置目录里。';
      actions.append(reset, note);
      panel.appendChild(actions);
    }

    /**
     * A `#rrggbb` for `<input type=color>`, from whatever the theme holds.
     *
     * The picker only accepts hex, while a theme may legitimately hold `rgb()`
     * or `hsl()`. Falling back to the stylesheet's default keeps the control
     * usable in that case, and the value is only read back when the user actually
     * changes it — so a theme written in `hsl()` is not silently rewritten to hex
     * just by opening the panel.
     */
    function toHexColor(value) {
      const text = String(value == null ? '' : value).trim();
      if (/^#[0-9a-f]{6}$/i.test(text)) return text;
      if (/^#[0-9a-f]{3}$/i.test(text)) return '#' + text.slice(1).split('').map((c) => c + c).join('');
      const rgb = text.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
      if (rgb) {
        const hex = rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
        return '#' + hex;
      }
      return '#0f1117';
    }

    /** Send a partial theme change and adopt whatever the host answers with. */
    async function saveTheme(patch) {
      try {
        const payload = await rawPost('/theme', { theme: patch });
        theme = payload.theme;
        applyTheme();
        renderThemePanel();
        announceThemeChange();
      } catch (error) {
        setError('外观保存失败：' + error.message);
      }
    }

    /**
     * Tell the other theme entry points that the theme moved.
     *
     * There are two places a user can change the room's appearance — this panel
     * and the DSH Settings row — and neither is mounted by the other. Without a
     * signal, whichever one is not currently saving would keep showing the old
     * palette until a reload. A window event is the whole mechanism: both sides
     * already share one HTTP store, so all that is missing is "re-read now".
     */
    function announceThemeChange() {
      try {
        if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
          global.dispatchEvent(new global.CustomEvent(THEME_EVENT));
        }
      } catch {}
    }

    /**
     * Re-read the theme after another surface changed it.
     *
     * Guarded by `destroyed` because a mounted room may have been torn down
     * between the event and the response.
     */
    async function pullTheme() {
      try {
        const response = await fetch(`${base}/theme`, { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json();
        if (destroyed || !payload || !payload.theme) return;
        theme = payload.theme;
        if (Array.isArray(payload.presets) && payload.presets.length) presets = payload.presets;
        applyTheme();
        renderThemePanel();
      } catch {}
    }

    /** Upload the background image the theme panel picked. */
    async function uploadBackground(file) {
      if (!file) return;
      try {
        const query = `type=${encodeURIComponent(file.type || 'image/png')}`;
        const response = await fetch(`${base}/theme/background?${query}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'image/png' },
          credentials: 'same-origin',
          body: file,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
        theme = payload.theme;
        applyTheme();
        renderThemePanel();
        announceThemeChange();
      } catch (error) {
        setError('背景上传失败：' + error.message);
      }
    }

    el('send').onclick = send;
    el('new-room').onclick = () => createRoom();
    el('attach').onclick = () => el('file').click();
    el('file').onchange = (event) => {
      if (uploads && uploads.enabled === false) {
        event.target.value = '';
        setError('这个房间没有配置文件存放目录，无法上传');
        return;
      }
      addFiles(event.target.files);
      // Cleared so picking the same file twice in a row still fires a change.
      event.target.value = '';
    };
    el('showtheme').onclick = () => {
      showTheme = !showTheme;
      renderThemePanel();
    };
    el('bgfile').onchange = (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      void uploadBackground(file);
    };

    /**
     * Drag and drop, and paste.
     *
     * Both are wired on the room root rather than the composer because a drop on
     * the transcript is the same intention as a drop on the textarea, and a
     * `dragover` that is not cancelled makes the browser navigate away from the
     * harness to open the file — which would look like the plugin crashing.
     */
    root.addEventListener('dragover', (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
      event.preventDefault();
      // Still cancelled when uploads are off: letting the browser navigate away
      // to open the file would look like the plugin crashing.
      if (uploads && uploads.enabled === false) return;
      root.classList.add('dragover');
    });
    root.addEventListener('dragleave', (event) => {
      // Only when the pointer actually left the room, not on every child boundary.
      if (event.target === root || !root.contains(event.relatedTarget)) root.classList.remove('dragover');
    });
    root.addEventListener('drop', (event) => {
      if (!event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return;
      event.preventDefault();
      root.classList.remove('dragover');
      // A drop is not stopped by disabling the button, so the capability is
      // checked here too — otherwise the file would be silently swallowed.
      if (uploads && uploads.enabled === false) {
        setError('这个房间没有配置文件存放目录，无法上传');
        return;
      }
      addFiles(event.dataTransfer.files);
    });
    inputEl.addEventListener('paste', (event) => {
      const items = (event.clipboardData && event.clipboardData.items) || [];
      const files = [];
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (!files.length) return;
      // Only swallow the paste when it actually carried a file: a clipboard with
      // both an image and text should still paste the text into the composer.
      event.preventDefault();
      if (uploads && uploads.enabled === false) {
        setError('这个房间没有配置文件存放目录，无法上传');
        return;
      }
      addFiles(files);
    });
    el('delete-room').onclick = () => deleteRoom();
    el('showtools').onchange = (event) => {
      showTools = event.target.checked;
      renderLog();
    };
    el('add-ok').onclick = () => submitAdd();
    el('add-cancel').onclick = () => toggleAddPanel(false);
    el('add-backend').onchange = () => refreshAddForm();
    el('add-id').onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitAdd();
      }
    };
    el('add-persona').onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitAdd();
      }
    };
    inputEl.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    };
    inputEl.oninput = () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    };

    /**
     * React to a theme change made by the other entry point (the DSH Settings
     * row), and stop reacting when this mount goes away — otherwise a torn-down
     * mount would keep fetching and repainting its detached root.
     */
    if (typeof global.addEventListener === 'function') {
      global.addEventListener(THEME_EVENT, pullTheme);
    }

    const empty = doc.createElement('div');
    empty.className = 'ar-empty';
    empty.textContent = '正在连接房间…';
    logEl.appendChild(empty);
    placeholder = empty;

    connect();
    loadCatalog();
    loadRooms();

    return {
      destroy() {
        destroyed = true;
        // Bump the generation so any in-flight read drops itself, and close the
        // stream: a destroyed mount must not leave a subscription behind.
        generation += 1;
        if (source) source.close();
        if (typeof global.removeEventListener === 'function') {
          global.removeEventListener(THEME_EVENT, pullTheme);
        }
        for (const entry of pending) if (entry.localUrl) URL.revokeObjectURL(entry.localUrl);
        pending = [];
        root.remove();
      },
      get root() {
        return root;
      },
      get room() {
        return roomId;
      },
      refresh: connect,
      refreshRooms: loadRooms,
      switchRoom,
      /**
       * The theme surface, for a host that renders its own controls (the DSH
       * Settings row). Exposed as functions rather than as state so the host
       * cannot hold a stale copy of the theme: both reads go back to the same
       * store the room itself paints from.
       */
      getTheme: () => theme,
      setTheme: saveTheme,
      pullTheme,
    };
  }

  global.AgentRoomUI = { mount, renderText, THEME_EVENT };

  if (typeof module !== 'undefined' && module.exports) module.exports = { mount, renderText, THEME_EVENT };
})(typeof window !== 'undefined' ? window : globalThis);
