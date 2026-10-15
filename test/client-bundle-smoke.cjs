'use strict';
/**
 * Load `lib/client.js` the way the DSH browser shell does, with a stub
 * `__ModuleLoader__` and stub `require`, then drive `apply()` against a fake
 * Cordis client context. Catches export-shape mistakes (a missing `apply`,
 * a wrong bundle id) before the bundle is ever installed into a live profile.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const BUNDLE = join(__dirname, '..', 'lib', 'client.js');
const source = readFileSync(BUNDLE, 'utf8');

const loaded = [];
const sandbox = {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.document = {
  head: { appendChild() {} },
  createElement: () => ({ set src(v) {}, onload: null, onerror: null }),
};
sandbox.__ModuleLoader__ = {
  load(entry) {
    loaded.push(entry);
    const module = { exports: {} };
    const require = (id) => {
      if (id === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useRef: (v) => ({ current: v }),
          useState: (v) => [v, () => {}],
          useEffect: () => {},
        };
      }
      throw new Error('unexpected require("' + id + '")');
    };
    const exports = entry.factory(require);
    loaded[loaded.length - 1].result = exports;
  },
};

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: BUNDLE });

const problems = [];
if (loaded.length !== 1) problems.push(`expected 1 bundle, got ${loaded.length}`);
const entry = loaded[0];
if (!entry) {
  console.log('FAIL: bundle never called __ModuleLoader__.load');
  process.exit(1);
}
const pkg = require(join(__dirname, '..', 'package.json'));
if (entry.id !== pkg.name) problems.push(`bundle id "${entry.id}" !== package name "${pkg.name}"`);
const result = entry.result || {};
if (typeof result.apply !== 'function') problems.push('bundle has no apply()');
if (!Array.isArray(result.inject)) problems.push('bundle has no inject[]');
console.log('bundle id   :', entry.id);
console.log('exports     :', Object.keys(result).join(', '));
console.log('inject      :', JSON.stringify(result.inject));

// Drive apply() against a recording fake ctx.
const registrations = { tabs: [], slots: [], effects: [] };
let effectDisposers = 0;
const ctx = {
  effect(fn, label) {
    registrations.effects.push(label);
    const dispose = fn();
    if (typeof dispose === 'function') effectDisposers += 1;
    return dispose;
  },
  sidebarRightTabs: {
    register(definition) {
      registrations.tabs.push(definition);
      return () => {};
    },
  },
  slots: {
    inject(slotName, callback) {
      registrations.slots.push({ slotName, viaInject: true });
      return callback();
    },
    register(slot, component) {
      registrations.slots.push({ slotName: slot.name, key: slot.key, component: typeof component });
      return () => {};
    },
  },
};
try {
  result.apply(ctx);
} catch (error) {
  problems.push('apply() threw: ' + error.message);
}

console.log('\n--- registrations ---');
console.log('effects :', registrations.effects.join(' | '));
for (const tab of registrations.tabs) {
  console.log('tab type:', JSON.stringify({
    id: tab.id, kind: tab.kind, priority: tab.priority,
    guide: (tab.guide || []).map((g) => g.id + ':' + g.kind),
  }));
}
for (const slot of registrations.slots) {
  console.log('slot    :', JSON.stringify(slot));
}
if (!registrations.tabs.length) problems.push('no tab type registered');
if (!registrations.slots.some((s) => s.slotName === 'sidebar.right.pane.tab')) {
  problems.push('no sidebar.right.pane.tab body registered');
}
if (effectDisposers !== registrations.effects.length) {
  problems.push('an effect returned no disposer (would leak on unload)');
}

console.log('\nproblems:', problems.length ? problems : 'none');
process.exit(problems.length ? 1 : 0);
