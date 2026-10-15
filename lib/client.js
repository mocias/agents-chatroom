/**
 * Client half of the agent-room plugin.
 *
 * Registers ONE right-sidebar tab type and its body. The body does not
 * reimplement the room UI: it loads the host-served `/agent-room/app.js` bundle
 * and mounts it, so the standalone page and the DSH tab always render the same
 * component and there is exactly one copy of the UI code.
 *
 * Packaged as a `window.__ModuleLoader__.load` bundle because that is the only
 * shape a `dsh.client` entry may take; `id` MUST equal the package name or the
 * host silently drops the bundle.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-room',
  factory: (require) => {
    const React = require('react');

    const TAB_ID = 'dsh-agent-room';
    const ROUTE = '/agent-room';
    /** Where the last room the user opened is remembered across reloads. */
    const LAST_ROOM_KEY = 'agent-room:last';
    /** The `settings.general.item` row this plugin adds. */
    const SETTINGS_ROW_ID = 'agent-room-theme';
    /**
     * The window event the room UI and this row use to stay in sync.
     *
     * Must match `THEME_EVENT` in `public/room-ui.js`. The two are mounted
     * independently (the room only exists while its tab is open, the row only
     * while Settings is), so an event is the whole coordination: both edit one
     * HTTP-stored theme, and this is just "re-read it now".
     */
    const THEME_EVENT = 'agent-room:theme';
    /**
     * The colours the room stylesheet consumes, mirrored from `lib/theme.cjs`.
     *
     * Duplicated rather than imported because a client bundle may not require
     * another package's server module; the host refuses anything off this list,
     * so a drift here shows up as a token that silently will not save rather
     * than as anything unsafe.
     */
    const TOKENS = [
      ['--ar-bg', '背景'],
      ['--ar-panel', '面板'],
      ['--ar-line', '分隔线'],
      ['--ar-text', '正文'],
      ['--ar-dim', '次要文字'],
      ['--ar-user', '强调'],
      ['--ar-accent', '高亮'],
    ];

    /**
     * Which room this tab opens into.
     *
     * NOT the DSH session id. Deriving the room from `props.sessionId` made every
     * DSH session its own room, and every room owns harness processes, so opening
     * a few workspaces quietly started a codex app-server for each — the leak
     * R1 exists to remove. The session id survives only as a last-resort
     * fallback for an environment where `localStorage` is unavailable (opaque
     * origin, disabled storage, a test harness); `'default'` is the ordinary
     * answer when nothing has been remembered.
     *
     * Reading storage can throw rather than return null, so both calls are
     * guarded: a browser that refuses storage must not take the tab down.
     */
    function preferredRoom(props) {
      try {
        const remembered = window.localStorage.getItem(LAST_ROOM_KEY);
        if (remembered) return remembered;
      } catch {}
      return props.sessionId || props.tabId || 'default';
    }

    /** Remember the room the user switched to, so the next mount opens it. */
    function rememberRoom(room) {
      try {
        if (room) window.localStorage.setItem(LAST_ROOM_KEY, room);
      } catch {}
    }

    /** Inject the shared room UI once; resolve when `AgentRoomUI` is available. */
    let uiPromise = null;
    function loadRoomUi() {
      if (window.AgentRoomUI) return Promise.resolve(window.AgentRoomUI);
      if (uiPromise) return uiPromise;
      uiPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${ROUTE}/app.js`;
        script.async = true;
        script.onload = () => {
          if (window.AgentRoomUI) resolve(window.AgentRoomUI);
          else reject(new Error('agent-room UI loaded but exposed nothing'));
        };
        script.onerror = () => reject(new Error('cannot load ' + ROUTE + '/app.js'));
        document.head.appendChild(script);
      });
      return uiPromise;
    }

    /** Tab body: a thin host for the vanilla UI. */
    function RoomTab(props) {
      const host = React.useRef(null);
      const [error, setError] = React.useState(null);
      // The last room the user opened, not this DSH session. One room per DSH
      // session is the behaviour R1 removes; the switcher inside the UI is how
      // the room actually changes, and it reports back through `onRoomChange`
      // so the choice survives a reload.
      const [room, setRoom] = React.useState(() => preferredRoom(props));

      React.useEffect(() => {
        let mounted = null;
        let cancelled = false;
        loadRoomUi()
          .then((ui) => {
            if (cancelled || !host.current) return;
            mounted = ui.mount(host.current, {
              base: ROUTE,
              room,
              onRoomChange: (next) => {
                if (!next || next === room) return;
                rememberRoom(next);
                setRoom(next);
              },
            });
          })
          .catch((failure) => {
            if (!cancelled) setError(failure.message);
          });
        return () => {
          cancelled = true;
          if (mounted) mounted.destroy();
        };
      }, [room]);

      const style = { height: '100%', width: '100%', overflow: 'hidden' };
      if (error) {
        return React.createElement(
          'div',
          { style: { padding: 12, color: '#fca5a5', fontSize: 12 } },
          '群聊插件加载失败：' + error,
        );
      }
      return React.createElement('div', { ref: host, style, 'data-agent-room': room });
    }

    /**
     * The Settings → General row for the room's appearance.
     *
     * This is the second entry point for the same theme the room's own panel
     * edits; both read and write one HTTP store, so the only thing that has to be
     * coordinated is "the other one just changed it", which the shared
     * `THEME_EVENT` does.
     *
     * The row deliberately does NOT set `--dsw-alias-*`: those are the harness's
     * own chrome tokens, and a room's palette leaking into the rest of DSH would
     * be a theming feature turning into an unlabelled global skin. The host
     * enforces the same boundary, so this is a second line of defence rather
     * than the only one.
     */
    function ThemeRow(props) {
      const [state, setState] = React.useState({ loading: true, theme: null, presets: [], error: null });
      const [busy, setBusy] = React.useState(false);
      // A ref, not state: the listeners below are installed once and must see the
      // current theme without being torn down and re-added on every swatch edit.
      const latest = React.useRef(null);
      latest.current = state.theme;

      const request = React.useCallback(async (path, options) => {
        const response = await fetch(ROUTE + path, { credentials: 'same-origin', ...options });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
        return payload;
      }, []);

      const adopt = React.useCallback((payload) => {
        setState((prev) => ({
          loading: false,
          theme: payload.theme || prev.theme,
          presets: payload.presets && payload.presets.length ? payload.presets : prev.presets,
          error: null,
        }));
      }, []);

      const load = React.useCallback(async () => {
        try {
          const payload = await request('/theme');
          setState((prev) => ({ ...prev, loading: false, theme: payload.theme, presets: payload.presets || [], error: null }));
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: error.message }));
        }
      }, [request]);

      /** Save a partial change. The host answers with the whole theme, which is adopted as-is. */
      const save = React.useCallback(
        async (patch) => {
          setBusy(true);
          try {
            adopt(await request('/theme', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: patch }) }));
            // Tell the room tab, which is a different mount with its own copy.
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              window.dispatchEvent(new window.CustomEvent(THEME_EVENT));
            }
          } catch (error) {
            setState((prev) => ({ ...prev, error: error.message }));
          } finally {
            setBusy(false);
          }
        },
        [adopt, request],
      );

      React.useEffect(() => {
        load();
        // The room's own panel can change the theme while this row is open.
        const onExternalChange = () => load();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener(THEME_EVENT, onExternalChange);
          return () => window.removeEventListener(THEME_EVENT, onExternalChange);
        }
        return undefined;
      }, [load]);

      const uploadBackground = React.useCallback(
        async (event) => {
          const file = event.target.files && event.target.files[0];
          // Reset immediately: picking the same file twice must fire twice.
          event.target.value = '';
          if (!file) return;
          setBusy(true);
          try {
            const query = '?type=' + encodeURIComponent(file.type || 'image/png');
            adopt(await request('/theme/background' + query, { method: 'POST', headers: { 'content-type': file.type || 'image/png' }, body: file }));
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              window.dispatchEvent(new window.CustomEvent(THEME_EVENT));
            }
          } catch (error) {
            setState((prev) => ({ ...prev, error: error.message }));
          } finally {
            setBusy(false);
          }
        },
        [adopt, request],
      );

      const theme = state.theme;
      const colors = (theme && theme.colors) || {};
      const background = (theme && theme.background) || null;

      const rowStyle = {
        color: 'var(--dsw-alias-label-primary)',
        padding: '16px 0',
        fontSize: 14,
        lineHeight: '22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      };
      const labelStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' };
      const swatchRow = { display: 'flex', flexWrap: 'wrap', gap: 10 };
      const swatch = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 };
      const inputStyle = { width: 34, height: 24, padding: 0, border: '1px solid var(--dsw-alias-separator-primary)', borderRadius: 4, background: 'transparent' };
      const buttonStyle = (active) => ({
        padding: '3px 10px',
        fontSize: 12,
        borderRadius: 6,
        cursor: busy ? 'default' : 'pointer',
        border: '1px solid var(--dsw-alias-separator-primary)',
        background: active ? 'var(--dsw-alias-bg-elevated)' : 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        opacity: busy ? 0.6 : 1,
      });

      if (state.loading) {
        return React.createElement('div', { style: rowStyle }, 'Agent 群聊外观：加载中…');
      }
      if (!theme) {
        return React.createElement(
          'div',
          { style: rowStyle },
          React.createElement('div', null, 'Agent 群聊外观'),
          React.createElement('div', { style: { ...labelStyle, color: '#fca5a5' } }, '读取失败：' + (state.error || '未知错误')),
        );
      }

      // The hex the picker needs. A saved value may be rgb()/hsl(), which an
      // <input type="color"> cannot show; those fall back to a neutral swatch
      // rather than silently reporting black as if it were the stored colour.
      const toHex = (value) => {
        const text = String(value || '').trim();
        if (/^#[0-9a-f]{6}$/i.test(text)) return text;
        if (/^#[0-9a-f]{3}$/i.test(text)) return '#' + text[1] + text[1] + text[2] + text[2] + text[3] + text[3];
        const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(text);
        if (rgb) {
          return '#' + [1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('');
        }
        return '#000000';
      };

      const isFileBackground = background && background.kind === 'file';
      const isUrlBackground = background && background.kind === 'url';

      return React.createElement(
        'div',
        { style: rowStyle, 'data-agent-room-theme': '' },
        React.createElement('div', { style: { fontWeight: 600 } }, 'Agent 群聊外观'),
        React.createElement('div', { style: labelStyle }, '只影响右侧栏的 Agent 群聊，不改变 DSH 其他界面。'),

        // --- presets ---------------------------------------------------------
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          state.presets.map((preset) =>
            React.createElement(
              'button',
              {
                key: preset.id,
                type: 'button',
                style: buttonStyle(theme.preset === preset.id),
                disabled: busy,
                onClick: () => save({ preset: preset.id }),
              },
              preset.label || preset.id,
            ),
          ),
        ),

        // --- per-token colours ----------------------------------------------
        React.createElement(
          'div',
          { style: swatchRow },
          TOKENS.map(([token, label]) =>
            React.createElement(
              'label',
              { key: token, style: swatch, title: token },
              React.createElement('input', {
                type: 'color',
                style: inputStyle,
                value: toHex(colors[token]),
                disabled: busy,
                // `change`, not `input`: a picker fires `input` on every frame of
                // the drag, which would POST the theme dozens of times a second.
                onChange: (event) => save({ colors: { [token]: event.target.value } }),
              }),
              label,
            ),
          ),
        ),

        // --- background ------------------------------------------------------
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement('span', { style: labelStyle }, '背景图'),
          React.createElement(
            'label',
            { style: buttonStyle(false) },
            '选择图片',
            React.createElement('input', {
              type: 'file',
              accept: 'image/*',
              style: { display: 'none' },
              disabled: busy,
              onChange: uploadBackground,
            }),
          ),
          isFileBackground || isUrlBackground
            ? React.createElement(
                'button',
                { type: 'button', style: buttonStyle(false), disabled: busy, onClick: () => save({ background: null }) },
                '移除',
              )
            : null,
          isUrlBackground
            ? React.createElement('span', { style: { ...labelStyle, fontSize: 11 } }, background.value.length > 48 ? background.value.slice(0, 48) + '…' : background.value)
            : null,
          React.createElement('span', { style: labelStyle }, '遮罩'),
          React.createElement('input', {
            type: 'range',
            min: 0,
            max: 0.95,
            step: 0.05,
            value: theme.veil,
            disabled: busy,
            style: { width: 120 },
            // Live local preview while dragging, persist once on release.
            onChange: (event) => {
              const veil = Number(event.target.value);
              setState((prev) => ({ ...prev, theme: { ...prev.theme, veil } }));
            },
            onMouseUp: (event) => save({ veil: Number(event.target.value) }),
            onKeyUp: (event) => save({ veil: Number(event.target.value) }),
          }),
          React.createElement('span', { style: labelStyle }, String(Math.round((theme.veil || 0) * 100)) + '%'),
        ),

        state.error ? React.createElement('div', { style: { fontSize: 12, color: '#fca5a5' } }, state.error) : null,
      );
    }

    function apply(ctx) {
      // Static type declaration: `id` is the key used by both the tab body and
      // the title slot, and must also be unique across every registered type.
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: 'agentroom',
            priority: 'extension',
            title: () => '群聊',
            guide: [
              {
                id: 'open',
                order: 30,
                title: () => 'Agent 群聊',
                description: () => '和其他 AI agent 在同一个房间里公开对话，用 @ 点名。',
              },
            ],
          }),
        'agent-room: tab type',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                // The slot framework passes the hosting session id in. It is no
                // longer the room key — the room is remembered per browser and
                // switched from inside the UI — but it stays available as the
                // fallback for an environment with no usable storage.
                inject: (sessionId) => ({ sessionId }),
              },
              RoomTab,
            ),
          ),
        'agent-room: tab body',
      );
      ctx.effect(
        () =>
          ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              {
                name: 'settings.general.item',
                id: SETTINGS_ROW_ID,
                // Between appearance(10)/font-size(11) and developer-tools(15):
                // it is a visual preference like the two above it, so it belongs
                // beside them rather than after the diagnostics.
                order: 12,
                // No `locale`, deliberately. That option hands the component a
                // `t` seat bound to a namespace this plugin would have to
                // register, and this row's copy is Chinese like the rest of the
                // plugin; claiming another package's namespace to get an unused
                // `t` would be worse than not having one.
              },
              ThemeRow,
            ),
          ),
        'agent-room: appearance settings row',
      );
    }

    const inject = ['slots', 'sidebarRightTabs'];

    return { apply, inject, name: 'dsh-agent-room' };
  },
});

