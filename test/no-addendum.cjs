#!/usr/bin/env node
/**
 * Regression test for the "(无补充)" decline marker.
 *
 * The passive-turn prompt offers "(无补充)" as the way to say "nothing to add".
 * Models echo it verbatim. It must NOT become a bubble in the shared room log:
 * a later agent reading the transcript would treat it as something a teammate
 * actually said.
 *
 * Pure unit test — no codex process, no network.
 */
'use strict';

const path = require('node:path');
const { isNoAddendum } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

const SHOULD_MATCH = [
  '无补充',
  '(无补充)',
  '（无补充）',
  ' (无补充) ',
  '无补充。',
  '(无补充)。',
  '无补充！',
  '【无补充】',
  '[无补充]',
  '无补充~',
];

const SHOULD_NOT_MATCH = [
  '',
  '我有补充：这个方案可行。',
  '无补充，但我还想说一句：需要先合并。',   // real content -> must post
  '@codex 无补充',
  '我无补充',
];

const problems = [];
for (const value of SHOULD_MATCH) {
  if (!isNoAddendum(value)) problems.push(`should be a decline marker but was not: ${JSON.stringify(value)}`);
}
for (const value of SHOULD_NOT_MATCH) {
  if (isNoAddendum(value)) problems.push(`should NOT be a decline marker: ${JSON.stringify(value)}`);
}

// The engine must drop it; the UI must not flash it. Both must agree.
//
// `public/room-ui.js` is a UMD-ish file loaded by a <script> tag in the browser.
// This package is `"type": "module"`, so a plain require() would treat the .js
// as ESM and hand back an empty namespace — load it in a vm with a CommonJS
// stub instead, mirroring test/client-bundle-smoke.cjs.
const fs = require('node:fs');
const vm = require('node:vm');

const uiPath = path.join(__dirname, '..', 'public', 'room-ui.js');
const uiSource = fs.readFileSync(uiPath, 'utf8');
const sandbox = { module: { exports: {} }, console, setTimeout, clearTimeout };
sandbox.exports = sandbox.module.exports;
vm.createContext(sandbox);
try {
  vm.runInContext(uiSource, sandbox, { filename: uiPath });
} catch (error) {
  problems.push(`room-ui.js failed to evaluate: ${error.message}`);
}
const uiMod = sandbox.module.exports;

if (!uiMod || typeof uiMod.mount !== 'function') {
  problems.push('room-ui.js did not export mount()');
}
if (!/isNoAddendum\(entry\.text\)/.test(uiSource)) {
  problems.push('room-ui.js does not guard the live bubble with isNoAddendum(entry.text)');
}

console.log('markers   :', SHOULD_MATCH.length, 'accepted');
console.log('keep-outs :', SHOULD_NOT_MATCH.length, 'rejected');
console.log('ui export :', uiMod && typeof uiMod.mount === 'function' ? 'mount ok' : 'MISSING mount');
console.log('problems  :', problems.length ? problems.join(' | ') : 'none');
process.exit(problems.length ? 1 : 0);
