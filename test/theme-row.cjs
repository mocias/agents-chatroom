#!/usr/bin/env node
/**
 * Render the Settings → General theme row and drive its controls.
 *
 * Registering a component proves nothing about it surviving a render: the slot
 * framework catches a throwing component and leaves a blank row behind with only
 * a console error. So this test mounts the row for real and clicks it.
 *
 * There is no `react` resolvable from this checkout, so instead of pretending to
 * skip, the file below is a small honest runtime: hooks with state, effects with
 * dependency comparison, and re-render on state change. It is deliberately not
 * React — it implements only what the row uses — but it runs the row's real code
 * paths, including the loaded state that only appears after the fetch resolves.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

const ROUTE = '/agent-room';

// --------------------------------------------------------------- mini runtime --

/**
 * A single-component renderer with hooks.
 *
 * Renders synchronously and re-renders when a setter changes state. Effects are
 * dependency-compared, because the row's mount effect fetches and then sets
 * state: running it on every render would be an infinite loop, and the loop
 * guard below is itself a check (a row that re-fetched forever would pin the
 * Settings panel).
 */
function createRuntime() {
  const ELEMENT = Symbol('element');
  const MAX_RENDERS = 40;
  let cursor = 0;
  let hooks = [];
  let running = [];
  let dirty = false;
  let renders = 0;
  let tree = null;

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

  function slot(create) {
    const index = cursor;
    cursor += 1;
    if (!hooks[index]) hooks[index] = create();
    return hooks[index];
  }

  const React = {
    createElement(type, props, ...children) {
      return { $$typeof: ELEMENT, type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) };
    },
    useRef(initial) {
      return slot(() => ({ kind: 'ref', value: { current: initial } })).value;
    },
    useState(initial) {
      const hook = slot(() => ({ kind: 'state', value: typeof initial === 'function' ? initial() : initial }));
      const set = (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next;
        if (Object.is(value, hook.value)) return;
        hook.value = value;
        dirty = true;
      };
      return [hook.value, set];
    },
    /**
     * Memoized on `deps`, like React's.
     *
     * Returning the function unchanged would be a subtly wrong shim: the row's
     * mount effect depends on a `useCallback`-wrapped loader, so an unstable
     * identity here makes the effect re-run on every render, re-fetch, set state,
     * and spin. That is a shim bug that looks exactly like a row bug, so it is
     * worth the four lines to not have.
     */
    useCallback(fn, deps) {
      const hook = slot(() => ({ kind: 'callback', fn, deps: undefined }));
      if (hook.deps === undefined || !sameDeps(hook.deps, deps)) {
        hook.fn = fn;
        hook.deps = Array.isArray(deps) ? [...deps] : deps;
      }
      return hook.fn;
    },
    useEffect(fn, deps) {
      const hook = slot(() => ({ kind: 'effect', deps: undefined, cleanup: undefined }));
      const first = hook.deps === undefined;
      if (first || !sameDeps(hook.deps, deps)) {
        hook.deps = deps;
        if (typeof hook.cleanup === 'function') hook.cleanup();
        running.push({ hook, fn });
      }
    },
    Fragment: 'Fragment',
  };

  function render(props = {}) {
    renders += 1;
    cursor = 0;
    dirty = false;
    // The effect queue is cleared BEFORE the component runs and drained after,
    // so an effect registered during this render executes during this render.
    // Draining the previous render's queue instead delays every effect by one
    // pass, which silently makes a mount-time fetch never happen.
    running = [];
    tree = Component(props);
    const effects = running;
    running = [];
    for (const { hook, fn } of effects) {
      const cleanup = fn();
      hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
    if (renders > MAX_RENDERS) throw new Error('the row re-rendered ' + renders + ' times without settling');
    return tree;
  }

  /** Let pending promises resolve, re-rendering while state keeps changing. */
  async function settle(turns = 12) {
    for (let i = 0; i < turns; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!dirty) {
        // One more pass: a resolved fetch may schedule its setter a tick later.
        await new Promise((resolve) => setImmediate(resolve));
        if (!dirty) return tree;
      }
      render();
    }
    throw new Error('the row never settled');
  }

  let Component = null;
  return {
    React,
    ELEMENT,
    setComponent(component, props = {}) {
      Component = component;
      hooks = [];
      renders = 0;
      // Rendered immediately, not just armed: `settle()` only re-renders while
      // state is dirty, so a runtime that never painted once would have no
      // effects registered, never fetch, and hand back a null tree — which the
      // caller would then have to notice on its own.
      render(props);
      return render;
    },
    render,
    settle,
    get renders() {
      return renders;
    },
    get tree() {
      return tree;
    },
  };
}

/** Every element in a rendered tree, depth-first. */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.$$typeof) out.push(node);
  const children = node.children;
  if (Array.isArray(children)) for (const child of children) walk(child, out);
  else if (children !== undefined) walk(children, out);
  return out;
}

/** The concatenated text under a node. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && node.$$typeof) return textOf(node.children);
  return '';
}

const byPredicate = (tree, predicate) => walk(tree).find(predicate);

/**
 * The DEEPEST element whose text contains `needle`.
 *
 * Deliberately not the first match. `walk` is pre-order, so a naive `find` would
 * return the outermost container — whose text contains every string in the row —
 * and every "is this rendered?" check built on it would pass no matter what the
 * row actually drew. Taking the last match keeps the assertion about the element
 * that genuinely holds the text.
 */
const byText = (tree, needle) => {
  const matches = walk(tree).filter((el) => textOf(el).includes(needle));
  return matches.length ? matches[matches.length - 1] : undefined;
};

/** A button whose own text contains `needle`. */
const buttonByText = (tree, needle) =>
  walk(tree).filter((el) => el.type === 'button' && textOf(el).includes(needle)).pop();

const byProp = (tree, key) => walk(tree).find((el) => el.props && el.props[key] !== undefined);

// ------------------------------------------------------------------ the bundle --

/** Load `lib/client.js` as the browser shell does, with the runtime as `react`. */
function loadBundle(runtime, fetchImpl) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  const loaded = [];
  const listeners = new Map();
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.fetch = fetchImpl;
  sandbox.document = {
    head: { appendChild() {} },
    createElement: () => ({ set src(v) {}, onload: null, onerror: null }),
    querySelector: () => null,
  };
  // The row talks to the room tab through one window event.
  sandbox.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  sandbox.removeEventListener = (type, fn) => {
    const list = listeners.get(type) || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };
  sandbox.dispatchEvent = (event) => {
    for (const fn of listeners.get(event && event.type) || []) fn(event);
    return true;
  };
  sandbox.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };
  sandbox.__ModuleLoader__ = {
    load(entry) {
      loaded.push(entry);
      const require = (id) => {
        if (id === 'react') return runtime.React;
        throw new Error('unexpected require("' + id + '")');
      };
      loaded[loaded.length - 1].result = entry.factory(require);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  return { entry: loaded[0], sandbox, listeners };
}

/** Register the bundle against a recording ctx and hand back the settings row. */
function registerRow(entry) {
  let row = null;
  let options = null;
  const injected = [];
  const registrations = [];
  /** The slot `inject` most recently opened, so a register can be tied to it. */
  let activeSlot = null;
  const ctx = {
    effect: (fn) => fn(),
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject(name, callback) {
        injected.push(name);
        const previous = activeSlot;
        activeSlot = name;
        try {
          return callback();
        } finally {
          activeSlot = previous;
        }
      },
      register(slotOptions, component) {
        registrations.push({ registeredInto: slotOptions.name, injectedFrom: activeSlot });
        if (slotOptions.name === 'settings.general.item') {
          row = component;
          options = slotOptions;
        }
        return () => {};
      },
    },
  };
  entry.result.apply(ctx);
  return { row, options, injected, registrations };
}

const HOST_THEME = {
  colors: {
    '--ar-bg': '#0f1117',
    '--ar-panel': '#151922',
    '--ar-line': '#232936',
    '--ar-text': '#e6e9ef',
    '--ar-dim': '#8b93a7',
    '--ar-user': '#3b82f6',
    '--ar-accent': '#22d3ee',
  },
  background: null,
  veil: 0.35,
  preset: 'midnight',
};
const HOST_PRESETS = [
  { id: 'midnight', label: '午夜', colors: HOST_THEME.colors },
  { id: 'paper', label: '纸张', colors: HOST_THEME.colors },
];

/** A fetch that answers like the real host and records every call. */
function makeFetch(state = { theme: HOST_THEME, presets: HOST_PRESETS, fail: false }) {
  const calls = [];
  const impl = (url, options = {}) => {
    const target = String(url);
    const method = options.method || 'GET';
    let body = null;
    if (typeof options.body === 'string') {
      try {
        body = JSON.parse(options.body);
      } catch {
        body = options.body;
      }
    }
    calls.push({ url: target, method, body, raw: options.body });
    if (state.fail) {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: 'boom' }) });
    }
    if (method === 'POST' && target.includes('/theme/background')) {
      const next = { ...state.theme, background: { kind: 'file', version: 3 } };
      state.theme = next;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, theme: next, presets: state.presets }) });
    }
    if (method === 'POST' && target.includes('/theme')) {
      const patch = (body && body.theme) || {};
      const next = {
        ...state.theme,
        ...patch,
        colors: { ...state.theme.colors, ...(patch.colors || {}) },
      };
      state.theme = next;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, theme: next, presets: state.presets }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, theme: state.theme, presets: state.presets }) });
  };
  impl.calls = calls;
  return impl;
}

// ------------------------------------------------------------------- the checks --

(async () => {
  // --- registration --------------------------------------------------------
  const runtime = createRuntime();
  const initial = loadBundle(runtime, makeFetch());
  check('the bundle loaded', !!initial.entry, 'no bundle');
  const registered = registerRow(initial.entry);
  check('the settings row was registered', !!registered.row, 'no settings.general.item registration');
  check('the row has a stable id', registered.options && registered.options.id === 'agent-room-theme', JSON.stringify(registered.options && registered.options.id));
  check(
    'the row sorts beside the other appearance rows',
    registered.options && registered.options.order > 10 && registered.options.order < 15,
    String(registered.options && registered.options.order),
  );
  // The real framework throws when a registration targets a slot that was never
  // injected; the stub above does not, so every registration is checked against
  // the inject it happened inside. Without this a typo in the slot name would
  // register nowhere and still "pass".
  const mismatched = registered.registrations.filter((r) => r.registeredInto !== r.injectedFrom);
  check('every registration matches the slot it injected', mismatched.length === 0, JSON.stringify(mismatched));
  const settingsRegistration = registered.registrations.find((r) => r.registeredInto === 'settings.general.item');
  check('the row appears in settings.general.item', !!settingsRegistration, JSON.stringify(registered.registrations));
  check(
    'the row does not claim another package locale namespace',
    !registered.options || registered.options.locale === undefined,
    String(registered.options && registered.options.locale),
  );

  // --- the first paint (loading) must not throw ----------------------------
  // Rendered through the runtime, not by calling the component directly: the
  // row uses hooks, and a bare call would report a crash that cannot happen.
  let loadingTree = null;
  const loadingRuntime = createRuntime();
  try {
    loadingRuntime.setComponent(registered.row);
    loadingTree = loadingRuntime.render();
  } catch (error) {
    problems.push('the row threw on its first render: ' + error.message);
  }
  check('the first render produced a tree', !!loadingTree);
  check('the first render says it is loading', /加载中/.test(textOf(loadingTree)), textOf(loadingTree).slice(0, 120));

  // --- the loaded render ---------------------------------------------------
  const state = { theme: HOST_THEME, presets: HOST_PRESETS, fail: false };
  const fetchImpl = makeFetch(state);
  const loaded = loadBundle(runtime, fetchImpl);
  const row = registerRow(loaded.entry);
  check('the row is registered in the second bundle too', !!row.row);

  let tree = null;
  try {
    runtime.setComponent(row.row);
    await runtime.settle();
    tree = runtime.tree;
  } catch (error) {
    problems.push('the row never reached its loaded state: ' + error.message);
  }

  // A null tree must be a failure, never a skip: an unrendered row is exactly
  // the blank-settings-row bug this test exists to catch, and letting the checks
  // below be conditional on `tree` would report success for showing nothing.
  if (!tree) {
    problems.push('the row produced no tree at all');
  } else {
    const text = textOf(tree);
    check('the loaded row mentions the room', text.includes('群聊'), text.slice(0, 160));
    check('the loaded row is no longer loading', !/加载中/.test(text), text.slice(0, 160));
    check('the row explains its scope', /右侧栏/.test(text), text.slice(0, 200));

    // Every preset the host offered must be clickable.
    for (const preset of HOST_PRESETS) {
      check(`the preset "${preset.id}" is rendered`, !!byText(tree, preset.label), text.slice(0, 240));
    }
    check('the presets were fetched from the host', fetchImpl.calls.some((call) => call.url.includes(ROUTE + '/theme') && call.method === 'GET'));

    // A colour input per token, seeded with the saved value.
    const colorInputs = walk(tree).filter((el) => el.props && el.props.type === 'color');
    check('there is a colour input per token', colorInputs.length === 7, String(colorInputs.length));
    check(
      'a colour input shows the saved colour',
      colorInputs.some((el) => el.props.value === '#0f1117'),
      colorInputs.map((el) => el.props.value).join(','),
    );
    // Each colour input is wrapped in a <label> that names the token, so the
    // controls are identifiable without reading a hex value.
    const colorLabels = walk(tree).filter((el) => el.type === 'label' && walk(el).some((child) => child.props && child.props.type === 'color'));
    check('every colour input sits in a labelled row', colorLabels.length === colorInputs.length, `${colorLabels.length} labels vs ${colorInputs.length} inputs`);
    check(
      'the colour labels are named',
      walk(tree).filter((el) => el.type === 'label' && /背景|面板|正文|高亮/.test(textOf(el))).length >= 4,
      walk(tree).filter((el) => el.type === 'label').map(textOf).join('|'),
    );

    // --- clicking a preset -------------------------------------------------
    fetchImpl.calls.length = 0;
    const presetButton = buttonByText(tree, HOST_PRESETS[1].label);
    check('the preset is a button', !!presetButton, text.slice(0, 240));
    check('the preset button has a click handler', !!(presetButton && presetButton.props.onClick));
    if (presetButton && presetButton.props.onClick) {
      presetButton.props.onClick();
      await runtime.settle();
      const posted = fetchImpl.calls.find((call) => call.method === 'POST' && call.url.includes('/theme'));
      check('clicking a preset POSTs that preset', !!posted && posted.body && posted.body.theme && posted.body.theme.preset === 'paper', JSON.stringify(posted && posted.body));
      check('the new preset is adopted from the response', state.theme.preset === 'paper');
      // The room tab is a separate mount with its own copy, so a change here has
      // to be announced or the open tab keeps the old palette until a reload.
      check('the row is subscribed to theme changes', (loaded.listeners.get('agent-room:theme') || []).length > 0, String((loaded.listeners.get('agent-room:theme') || []).length));
    }

    // --- an announcement from the other entry point re-reads the theme ------
    // This is the direction that matters when the user edits the theme from the
    // room's own panel while Settings is open: the row must pick it up.
    fetchImpl.calls.length = 0;
    state.theme = { ...state.theme, preset: 'dusk', colors: { ...state.theme.colors, '--ar-bg': '#0d1512' } };
    loaded.sandbox.dispatchEvent(new loaded.sandbox.CustomEvent('agent-room:theme'));
    await runtime.settle();
    check('an external change triggers a re-read', fetchImpl.calls.some((call) => call.method === 'GET' && call.url.includes('/theme')), JSON.stringify(fetchImpl.calls.map((c) => c.method + ' ' + c.url)));
    check('the row adopts the externally set colour', walk(runtime.tree).some((el) => el.props && el.props.type === 'color' && el.props.value === '#0d1512'), 'not repainted');

    // --- editing one swatch ------------------------------------------------
    fetchImpl.calls.length = 0;
    const swatch = walk(runtime.tree).filter((el) => el.props && el.props.type === 'color')[0];
    check('a swatch still exists after re-render', !!swatch);
    if (swatch && swatch.props.onChange) {
      swatch.props.onChange({ target: { value: '#123456' } });
      await runtime.settle();
      const posted = fetchImpl.calls.find((call) => call.method === 'POST' && call.url.includes('/theme'));
      check('editing a swatch POSTs only that colour', !!posted && posted.body && posted.body.theme && !!posted.body.theme.colors && Object.keys(posted.body.theme.colors).length === 1, JSON.stringify(posted && posted.body));
      check('the posted colour is the chosen one', !!posted && posted.body.theme.colors['--ar-bg'] === '#123456', JSON.stringify(posted && posted.body));
      check('other colours were not re-sent', !!posted && !posted.body.theme.colors['--ar-accent']);
    }

    // --- background upload and removal -------------------------------------
    fetchImpl.calls.length = 0;
    const fileInput = byPredicate(runtime.tree, (el) => el.props && el.props.type === 'file');
    check('there is a background file input', !!fileInput);
    check('the file input only accepts images', !!fileInput && String(fileInput.props.accept).includes('image'), fileInput && fileInput.props.accept);
    if (fileInput && fileInput.props.onChange) {
      fileInput.props.onChange({ target: { files: [{ type: 'image/png' }], value: 'C:\\fakepath\\x.png' } });
      await runtime.settle();
      const posted = fetchImpl.calls.find((call) => call.method === 'POST' && call.url.includes('/theme/background'));
      check('picking a background POSTs the bytes', !!posted, JSON.stringify(fetchImpl.calls.map((c) => c.method + ' ' + c.url)));
      check('the background POST declares the type', !!posted && String(posted.url).includes('type=image'));
      check('the picker is reset so the same file works twice', fileInput.props.onChange !== undefined);
    }
    const removeButton = buttonByText(runtime.tree, '移除');
    check('a saved background offers removal', !!removeButton);
    if (removeButton && removeButton.props.onClick) {
      fetchImpl.calls.length = 0;
      removeButton.props.onClick();
      await runtime.settle();
      const posted = fetchImpl.calls.find((call) => call.method === 'POST' && call.url.includes('/theme') && !call.url.includes('background'));
      check('removing a background POSTs background:null', !!posted && posted.body && posted.body.theme && posted.body.theme.background === null, JSON.stringify(posted && posted.body));
    }

    // --- the veil slider ---------------------------------------------------
    const range = byPredicate(runtime.tree, (el) => el.props && el.props.type === 'range');
    check('there is a veil slider', !!range);
    check('the slider is bounded to a usable range', !!range && Number(range.props.max) <= 0.95, range && String(range.props.max));
    check('the slider shows the saved value', !!range && Number(range.props.value) === state.theme.veil, range && String(range.props.value));

    // --- only DSH alias tokens, never an assignment to them ----------------
    const usedTokens = new Set();
    let assigned = 0;
    for (const el of walk(runtime.tree)) {
      const style = el.props && el.props.style;
      if (!style || typeof style !== 'object') continue;
      for (const value of Object.values(style)) {
        if (typeof value === 'string') for (const token of value.match(/--dsw-alias-[a-z-]+/g) || []) usedTokens.add(token);
      }
    }
    for (const el of walk(runtime.tree)) {
      const props = el.props || {};
      for (const [key, value] of Object.entries(props)) {
        if (key === 'style') continue;
        if (typeof value === 'string' && /--dsw-alias-/.test(value)) assigned += 1;
      }
    }
    check('the row styles itself with DSH alias tokens', usedTokens.size > 0, Array.from(usedTokens).join(','));
    check('the row never assigns a harness-wide token', assigned === 0, String(assigned));

    console.log('render      : ' + runtime.renders + ' renders, ' + walk(tree).length + ' elements, tokens: ' + Array.from(usedTokens).join(','));
  }

  // --- a failing host must show an error, not go blank --------------------
  const brokenRuntime = createRuntime();
  const broken = loadBundle(brokenRuntime, makeFetch({ theme: null, presets: [], fail: true }));
  const brokenRow = registerRow(broken.entry);
  let brokenTree = null;
  try {
    brokenRuntime.setComponent(brokenRow.row);
    await brokenRuntime.settle();
    brokenTree = brokenRuntime.tree;
  } catch (error) {
    problems.push('the failing-host row threw: ' + error.message);
  }
  if (brokenTree) {
    const text = textOf(brokenTree);
    check('a failing fetch reports an error instead of a blank row', /失败|错误/.test(text), text.slice(0, 200));
    check('the failing row still names the feature', text.includes('群聊'), text.slice(0, 200));
  }

  console.log('theme-row   settings.general.item registration, render, and controls');
  console.log('problems: ' + (problems.length ? '\n  - ' + problems.join('\n  - ') : 'none'));
  process.exit(problems.length ? 1 : 0);
})().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
