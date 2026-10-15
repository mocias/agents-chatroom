#!/usr/bin/env node
/**
 * UI test for the member-management surface in `public/room-ui.js`.
 *
 * There is no jsdom in this runtime, so this file ships the smallest DOM that
 * the room UI actually touches and drives the real UI code against it. That is
 * enough to answer the questions a browser would answer here:
 *
 *   - do member chips render, with the model as a separate clickable control?
 *   - does clicking a chip add an @mention (and NOT open an editor)?
 *   - does `×` remove a member through `POST /remove-member`?
 *   - does clicking the model swap in a select that commits `POST /member`?
 *   - does `+ 添加成员` reveal a form built from `GET /models`, with the backend
 *     picker selecting which backend's models the model picker offers?
 *   - does submitting the form `POST /members` with the persona?
 *
 * Networking is stubbed: no HTTP, no codex, no DSH.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { Document } = require('./dom-shim.cjs');

// ------------------------------------------------------------- test harness --

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

const calls = [];
let stateResponse = null;
let modelsResponse = null;
let nextError = null;

function jsonResponse(payload, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(payload),
  });
}

const fetchStub = (url, options = {}) => {
  const target = String(url);
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url: target, method: options.method || 'GET', body });

  if (nextError) {
    const message = nextError;
    nextError = null;
    return jsonResponse({ ok: false, error: message }, false);
  }
  if (target.includes('/state')) return jsonResponse(stateResponse);
  if (target.includes('/models')) return jsonResponse(modelsResponse);
  if (target.includes('/members')) {
    const created = { id: body.id, label: body.label || body.id, model: body.model || 'm-one', persona: body.persona || '', backend: body.backend || 'codex' };
    // A real server would make the new member visible in the next snapshot.
    stateResponse.snapshot.members.push({ ...created, status: 'cold', turns: 0, tokens: 0 });
    return jsonResponse({ ok: true, member: created });
  }
  if (target.includes('/member')) return jsonResponse({ ok: true, member: body });
  if (target.includes('/remove-member')) {
    stateResponse.snapshot.members = stateResponse.snapshot.members.filter((m) => m.id !== body.id);
    return jsonResponse({ ok: true, removed: { id: body.id } });
  }
  if (target.includes('/say')) return jsonResponse({ ok: true, entry: { id: 'm1', text: body.text }, delivered: [] });
  if (target.includes('/mode')) return jsonResponse({ ok: true, mode: body.mode });
  return jsonResponse({ ok: true });
};

/** A no-op EventSource: this test drives the UI through snapshots, not streams. */
class EventSourceStub {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }
  close() {}
}

function loadUi(doc) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'room-ui.js'), 'utf8');
  const sandbox = {
    document: doc,
    window: { confirm: () => confirmAnswer },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchStub,
    EventSource: EventSourceStub,
    module: { exports: {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'room-ui.js' });
  return sandbox.module.exports;
}

let confirmAnswer = true;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function membersSnapshot(members) {
  return {
    snapshot: {
      roomId: 'ui',
      mode: 'chat',
      replyPolicy: 'addressed',
      connected: true,
      segmentMs: 30000,
      maxSegmentChars: 2500,
      members: members.map((m) => ({
        status: 'idle', turns: 0, tokens: 0, queued: 0, segmentsSent: 0,
        steered: 0, preempted: 0, ...m,
      })),
      log: [],
    },
  };
}

async function main() {
  const doc = new Document();
  const ui = loadUi(doc);
  check('room-ui.js exports mount()', typeof ui.mount === 'function');

  stateResponse = membersSnapshot([
    { id: 'codex', label: 'Codex', model: 'gpt-5.6-sol', backend: 'codex' },
    { id: 'astra', label: 'Astra', model: 'gpt-6-astra', backend: 'codex' },
  ]);
  modelsResponse = {
    backends: ['codex', 'acp'],
    models: [
      { backend: 'codex', model: 'gpt-5.6-sol' },
      { backend: 'codex', model: 'gpt-6-astra' },
      { backend: 'acp', model: 'claude-sonnet' },
    ],
  };

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const mounted = ui.mount(container, { base: '/agent-room', room: 'ui' });
  await flush();
  await flush();

  const el = (name) => container.querySelector(`[data-el="${name}"]`);
  const chips = () => container.querySelector('[data-el="members"]').children.filter((c) => c.classList.contains('ar-chip'));
  const chipFor = (id) => chips().find((c) => c.textContent.includes('@' + id));

  // --- the roster renders, with the model as its own control -----------------
  check('two member chips rendered', chips().length === 2, String(chips().length));
  const codexChip = chipFor('codex');
  check('the chip names the member', !!codexChip && codexChip.textContent.includes('@codex'));
  check('the chip shows the model', !!codexChip && codexChip.textContent.includes('gpt-5.6-sol'), codexChip && codexChip.textContent);
  const modelEl = codexChip && codexChip.children.find((c) => c.classList.contains('ar-model'));
  check('the model is a distinct element (so it can be a control)', !!modelEl);
  check('the chip offers a remove affordance', !!codexChip && !!codexChip.children.find((c) => c.classList.contains('ar-kill')));
  check('the add-member button is present', container.textContent.includes('+ 添加成员') || !!container.querySelector('[data-el="members"]').children.find((c) => c.textContent.includes('添加成员')));

  // --- clicking the chip mentions; it does NOT open an editor ----------------
  codexChip.onclick();
  check('clicking a chip inserts an @mention', el('input').value.includes('@codex'), el('input').value);
  check('clicking a chip does not replace the model with a select', codexChip.children.includes(modelEl));

  // --- the add panel is built from the catalogue -----------------------------
  const addPanel = el('addpanel');
  check('the add panel starts hidden', addPanel.hidden === true);
  const addButton = container.querySelector('[data-el="members"]').children.find((c) => c.textContent.includes('添加成员'));
  addButton.onclick();
  check('the add panel opens', addPanel.hidden === false);
  const backendEl = el('add-backend');
  const modelPicker = el('add-model');
  check('the backend picker lists the backends in the catalogue', backendEl.children.map((o) => o.value).join(',') === 'codex,acp', backendEl.children.map((o) => o.value).join(','));
  // The first entry is always the blank "let the agent decide" option, then the
  // backend's catalogue. Codex members normally run an explicit model, but the
  // blank choice must exist because an ACP backend may publish no catalogue.
  check(
    'the model picker offers "agent default" then the first backend\'s models',
    modelPicker.children.map((o) => o.value).join(',') === ',gpt-5.6-sol,gpt-6-astra',
    modelPicker.children.map((o) => o.value).join(','),
  );
  check('the hint explains multi-harness rooms', /不同后端/.test(el('add-hint').textContent), el('add-hint').textContent);

  // Switching backend must re-point the model picker at that backend.
  backendEl.value = 'acp';
  backendEl.onchange();
  check('switching backend switches the model list', modelPicker.children.map((o) => o.value).join(',') === ',claude-sonnet', modelPicker.children.map((o) => o.value).join(','));
  backendEl.value = 'codex';
  backendEl.onchange();

  // --- submitting the form adds a member to the room -------------------------
  calls.length = 0;
  el('add-id').value = 'gemini';
  el('add-label').value = 'Gemini';
  el('add-persona').value = '你负责横向对比。';
  modelPicker.value = 'gpt-6-astra';
  await el('add-ok').onclick();
  await flush();

  const addCall = calls.find((c) => c.url.includes('/members') && c.method === 'POST');
  check('the form posted to /members', !!addCall, JSON.stringify(calls.map((c) => c.method + ' ' + c.url)));
  check('the id was sent', !!addCall && addCall.body.id === 'gemini', JSON.stringify(addCall && addCall.body));
  check('the persona was sent', !!addCall && addCall.body.persona === '你负责横向对比。', JSON.stringify(addCall && addCall.body));
  check('the model was sent', !!addCall && addCall.body.model === 'gpt-6-astra', JSON.stringify(addCall && addCall.body));
  check('the backend was sent', !!addCall && addCall.body.backend === 'codex', JSON.stringify(addCall && addCall.body));
  check('the form was cleared', el('add-id').value === '' && el('add-persona').value === '');
  check('the panel closed again', addPanel.hidden === true);

  // A failed add must be surfaced, not swallowed.
  calls.length = 0;
  el('add-id').value = 'codex';
  nextError = 'member already exists: codex';
  await el('add-ok').onclick();
  await flush();
  check('a rejected add shows the server message', /already exists/.test(el('err').textContent), el('err').textContent);

  // --- clicking the model swaps in a select that commits --------------------
  const astraChip = chipFor('astra');
  const astraModel = astraChip.children.find((c) => c.classList.contains('ar-model'));
  astraModel.onclick({ stopPropagation() {} });
  const select = astraChip.children.find((c) => c.tagName === 'SELECT');
  check('clicking the model opens a select', !!select);
  check('the select is pre-set to the current model', !!select && select.value === 'gpt-6-astra', select && select.value);
  calls.length = 0;
  select.value = 'gpt-5.6-sol';
  await select.onchange();
  await flush();
  const editCall = calls.find((c) => c.url.includes('/member') && c.method === 'POST');
  check('changing the model posted to /member', !!editCall, JSON.stringify(calls.map((c) => c.method + ' ' + c.url)));
  check('the edit carried the id and the new model', !!editCall && editCall.body.id === 'astra' && editCall.body.model === 'gpt-5.6-sol', JSON.stringify(editCall && editCall.body));
  check('the select did not leak into the chip', !chipFor('astra').children.some((c) => c.tagName === 'SELECT'));

  // --- removing a member ----------------------------------------------------
  calls.length = 0;
  confirmAnswer = false;
  const astraKill = chipFor('astra').children.find((c) => c.classList.contains('ar-kill'));
  await astraKill.onclick({ stopPropagation() {} });
  await flush();
  check('a declined removal posts nothing', !calls.some((c) => c.url.includes('/remove-member')), JSON.stringify(calls.map((c) => c.url)));

  confirmAnswer = true;
  await astraKill.onclick({ stopPropagation() {} });
  await flush();
  const removeCall = calls.find((c) => c.url.includes('/remove-member'));
  check('an accepted removal posts to /remove-member', !!removeCall, JSON.stringify(calls.map((c) => c.url)));
  check('the removal names the member', !!removeCall && removeCall.body.id === 'astra', JSON.stringify(removeCall && removeCall.body));

  // --- a member on a backend with no catalogue cannot be silently re-pointed --
  stateResponse = membersSnapshot([{ id: 'legacy', label: 'Legacy', model: 'gpt-9-unknown', backend: 'acp' }]);
  modelsResponse = { backends: ['codex'], models: [{ backend: 'codex', model: 'gpt-5.6-sol' }] };
  const doc2 = new Document();
  const ui2 = loadUi(doc2);
  const container2 = doc2.createElement('div');
  const mounted2 = ui2.mount(container2, { base: '/agent-room', room: 'ui2' });
  await flush();
  await flush();
  const legacyChip = container2.querySelector('[data-el="members"]').children.find((c) => c.classList.contains('ar-chip'));
  const legacyModel = legacyChip.children.find((c) => c.classList.contains('ar-model'));
  check('the chip still names the real model', legacyModel.textContent.includes('gpt-9-unknown'), legacyModel.textContent);
  legacyModel.onclick({ stopPropagation() {} });
  check('no select opens when the backend offers no models', !legacyChip.children.some((c) => c.tagName === 'SELECT'));
  check('the reason is stated, not "try again later"', /没有提供模型列表/.test(container2.querySelector('[data-el="err"]').textContent), container2.querySelector('[data-el="err"]').textContent);

  // A stale catalogue row must not leak across backends either.
  stateResponse = membersSnapshot([{ id: 'solo', label: 'Solo', model: 'gpt-9-unknown', backend: 'codex' }]);
  modelsResponse = { backends: ['codex'], models: [{ backend: 'codex', model: 'gpt-5.6-sol' }] };
  const doc3 = new Document();
  const ui3 = loadUi(doc3);
  const container3 = doc3.createElement('div');
  const mounted3 = ui3.mount(container3, { base: '/agent-room', room: 'ui3' });
  await flush();
  await flush();
  const soloChip = container3.querySelector('[data-el="members"]').children.find((c) => c.classList.contains('ar-chip'));
  soloChip.children.find((c) => c.classList.contains('ar-model')).onclick({ stopPropagation() {} });
  const soloSelect = soloChip.children.find((c) => c.tagName === 'SELECT');
  check('an off-catalogue model on a known backend is still offered', !!soloSelect && soloSelect.children.some((o) => o.value === 'gpt-9-unknown'));
  check('the select is pre-set to that off-catalogue model', !!soloSelect && soloSelect.value === 'gpt-9-unknown', soloSelect && soloSelect.value);
  check('the known-good models are still offered too', !!soloSelect && soloSelect.children.some((o) => o.value === 'gpt-5.6-sol'));

  // --- a member with no model at all must not render as "null" ----------------
  // Blank means "the agent decides". Printing the literal `null` would look like
  // a corrupted member, and silently filling in a real model name would claim a
  // choice the user never made.
  stateResponse = membersSnapshot([{ id: 'auto', label: 'Auto', model: null, backend: 'acp' }]);
  modelsResponse = { backends: ['codex', 'acp'], models: [{ backend: 'codex', model: 'gpt-5.6-sol' }] };
  const doc4 = new Document();
  const ui4 = loadUi(doc4);
  const container4 = doc4.createElement('div');
  const mounted4 = ui4.mount(container4, { base: '/agent-room', room: 'ui4' });
  await flush();
  await flush();
  const autoChip = container4.querySelector('[data-el="members"]').children.find((c) => c.classList.contains('ar-chip'));
  const autoModel = autoChip.children.find((c) => c.classList.contains('ar-model'));
  check('a model-less member does not render the literal "null"', !/null/.test(autoModel.textContent), autoModel.textContent);
  check('a model-less member says the default is in play', /默认|agent/i.test(autoModel.textContent), autoModel.textContent);
  check('the chip tooltip does not say "model: null"', !/model: null/.test(autoChip.title), autoChip.title);
  check('the add form always offers the "agent default" choice', (() => {
    container4.querySelector('[data-el="members"]').children.find((c) => c.textContent.includes('添加成员')).onclick();
    const picker = container4.querySelector('[data-el="add-model"]');
    return picker.children.some((o) => o.value === '') && /默认/.test(picker.children[0].textContent);
  })(), container4.querySelector('[data-el="add-model"]').children.map((o) => o.value + ':' + o.textContent).join('|'));

  mounted.destroy();
  mounted2.destroy();
  mounted3.destroy();
  mounted4.destroy();
  check('destroy() removes the UI', container.children.length === 0, String(container.children.length));

  console.log('roster      chips render, model + remove are separate controls');
  console.log('mention     clicking a chip inserts @id, does not open an editor');
  console.log('add form    built from GET /models, backend switch re-points the model list');
  console.log('add submit  POST /members with id/model/persona/backend, errors surfaced');
  console.log('re-model    click model -> select -> POST /member, select does not leak');
  console.log('remove      confirm-gated POST /remove-member');
  console.log('honesty     a model the catalogue lacks is shown, or the reason is stated');
  console.log('blank       a model-less member says "agent default", never "null"');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
