#!/usr/bin/env node
/**
 * UI test for the attachment surface in `public/room-ui.js`.
 *
 * The host side of uploads is covered by `attachments.cjs` (id minting, byte
 * fidelity, path stripping). What that cannot see is the wiring the user
 * actually touches, which is what this file drives against the shared DOM shim:
 *
 *   - does `＋` open the file picker, and does a change event upload and stage?
 *   - does the tray render a chip per file, with a thumbnail only for images?
 *   - does `×` un-stage a file, and does `send` post the STAGED IDS (never a path)?
 *   - is sending allowed when there is a file but no text, and does the server's
 *     two-rule guard (`text OR attachments`) hold on the client too?
 *   - on a failed send do the attachments survive, or does the user lose the files?
 *   - does drag-and-drop work, and is `dragover` cancelled (else the browser
 *     navigates away and the plugin looks like it crashed)?
 *   - does a paste carrying a file upload it, while one carrying only text does not?
 *   - when the host says uploads are off, is that honoured BEFORE the picker opens?
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
/**
 * The theme the stub host will report.
 *
 * Kept in its own variable rather than read from `stateResponse.theme` at call
 * time, because the real store is written by `POST /theme` and read back by
 * `GET /theme` — modelling that is what lets the sync test tell "the room
 * repainted" apart from "the room re-rendered the same values".
 */
let themeResponse = null;
/** Bytes the host will report for the next upload; the stub echoes the name. */
let uploadFailure = null;
let sendFailure = null;

const ok = (payload, status = 200) =>
  Promise.resolve({ ok: true, status, json: () => Promise.resolve(payload) });
const bad = (message, status = 500) =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve({ ok: false, error: message }) });

const fetchStub = (url, options = {}) => {
  const target = String(url);
  const method = options.method || 'GET';
  // The attach route is the only one whose body is raw bytes rather than JSON,
  // and recording it lets the test assert the bytes were sent unchanged.
  const raw = method === 'POST' && target.includes('/attach') ? options.body : null;
  let body = null;
  if (typeof options.body === 'string') {
    try {
      body = JSON.parse(options.body);
    } catch {
      body = options.body;
    }
  }
  calls.push({ url: target, method, raw, body, headers: options.headers || {} });

  if (target.includes('/state')) return ok(stateResponse);
  if (target.includes('/models')) return ok({ backends: ['codex'], models: [] });
  // `GET /theme` answers the current theme; `POST /theme` echoes it back, which
  // is what the real host does (the whole theme, so the caller adopts one shape).
  if (target.includes('/theme')) {
    if (method === 'POST' && body && body.theme) {
      themeResponse = { ...themeResponse, colors: { ...themeResponse.colors, ...(body.theme.colors || {}) } };
      if (body.theme.veil !== undefined) themeResponse.veil = body.theme.veil;
      if (body.theme.preset !== undefined) themeResponse.preset = body.theme.preset;
      if (body.theme.background !== undefined) themeResponse.background = body.theme.background;
    }
    return ok({ ok: true, theme: themeResponse, presets: stateResponse.themePresets });
  }
  if (target.includes('/attach')) {
    if (uploadFailure) {
      const message = uploadFailure;
      uploadFailure = null;
      return bad(message);
    }
    const query = new URLSearchParams(target.slice(target.indexOf('?') + 1));
    const name = query.get('name') || 'file';
    const type = query.get('type') || '';
    // The host mints the id; the browser must never choose or see a path.
    return ok({
      ok: true,
      attachment: {
        id: 'f' + calls.length,
        name,
        bytes: raw ? raw.length : 0,
        mediaType: type || 'application/octet-stream',
        isImage: type.startsWith('image/'),
      },
    });
  }
  if (target.includes('/say')) {
    if (sendFailure) {
      const message = sendFailure;
      sendFailure = null;
      return bad(message);
    }
    return ok({ ok: true, entry: { id: 'm1' }, delivered: [] });
  }
  return ok({ ok: true });
};

class EventSourceStub {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }
  close() {}
}

/** `URL.createObjectURL` is browser-only; the shim records instead of blobbing. */
function makeUrlStub() {
  const created = [];
  const revoked = [];
  let next = 0;
  return {
    created,
    revoked,
    api: {
      createObjectURL(file) {
        void file;
        next += 1;
        const url = `blob:room/${next}`;
        created.push(url);
        return url;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
  };
}

/**
 * A stand-in for `window` that can carry events.
 *
 * `room-ui.js` subscribes to `THEME_EVENT` on the global, so a sandbox whose
 * `window` is a plain object silently drops the subscription: `pullTheme` would
 * never run and the row→room half of the sync could break with a green suite.
 * This gives the test a real listener list to fire into.
 */
function makeWindowStub() {
  const listeners = new Map();
  return {
    confirm: () => true,
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(event) {
      // Copied first: a handler may unsubscribe while the event is being fired.
      for (const handler of [...(listeners.get(event.type) || [])]) handler(event);
    },
    CustomEvent: class CustomEvent {
      constructor(type) {
        this.type = type;
      }
    },
  };
}

function loadUi(doc, urlStub, win) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'room-ui.js'), 'utf8');
  const sandbox = {
    document: doc,
    window: win,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchStub,
    EventSource: EventSourceStub,
    URL: urlStub.api,
    module: { exports: {} },
  };
  // `room-ui.js` resolves its global as `window` in a browser, so the event
  // methods must be reachable there — the same object the test fires into.
  sandbox.window.document = doc;
  sandbox.globalThis = sandbox;
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'room-ui.js' });
  return sandbox.module.exports;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Uploads are awaited one at a time through a promise chain; give it a few turns. */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};

/** A stand-in for the browser `File` the picker/drop/paste would hand over. */
function makeFile(name, type, bytes) {
  const body = Buffer.alloc(bytes === undefined ? 8 : bytes, 7);
  return { name, type, size: body.length, _bytes: body };
}

function baseState(uploads) {
  return {
    snapshot: {
      roomId: 'ui',
      mode: 'chat',
      replyPolicy: 'addressed',
      connected: true,
      segmentMs: 30000,
      maxSegmentChars: 2500,
      members: [],
      log: [],
    },
    theme: {
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
    },
    themePresets: [{ id: 'midnight', label: '午夜', colors: {} }],
    uploads,
  };
}

/** Mount a room UI with a given host capability and hand back the handles. */
async function mountRoom(uploads) {
  const doc = new Document();
  const urlStub = makeUrlStub();
  const win = makeWindowStub();
  const ui = loadUi(doc, urlStub, win);
  stateResponse = baseState(uploads);
  themeResponse = { ...stateResponse.theme };
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const mounted = ui.mount(container, { base: '/agent-room', room: 'ui' });
  await settle();
  const el = (name) => container.querySelector(`[data-el="${name}"]`);
  const root = container.children.find((c) => c.classList.contains('ar-root'));
  const chips = () => {
    const tray = el('tray');
    return tray.children.filter((c) => c.classList.contains('ar-att'));
  };
  /**
   * Pick files the way the browser does: put them on the REAL input and dispatch
   * with that element as `target`.
   *
   * Passing a throwaway `{ files, value }` object would make the handler's
   * `event.target.value = ''` write to the discardable object, so the assertion
   * that the input was cleared would pass no matter what the code did.
   */
  const pick = (files) => {
    const input = el('file');
    input.files = files;
    // Browsers expose a fake path here, so "cleared" is distinguishable.
    input.value = 'C:\\fakepath\\' + (files[0] ? files[0].name : '');
    input.onchange({ target: input });
  };
  return { doc, ui, container, root, el, chips, pick, mounted, urlStub, win };
}

async function main() {
  // --- the picker, the tray and the staged id ---------------------------------
  {
    const room = await mountRoom({ enabled: true, maxBytes: 64 * 1024 * 1024, maxLabel: '64 MB' });
    const { el, chips, root, urlStub } = room;

    check('the attach control exists', !!el('attach'));
    check('the file input accepts several files at once', !!el('file') && 'multiple' in el('file').attributes, JSON.stringify(el('file') && el('file').attributes));
    check('the tray starts hidden', el('tray').hidden === true);

    // `＋` must go through the input rather than uploading on its own.
    let clicked = 0;
    el('file').click = () => {
      clicked += 1;
    };
    el('attach').onclick();
    check('＋ opens the file picker', clicked === 1, String(clicked));

    // A PNG and a plain text file: only the image may get a thumbnail.
    const png = makeFile('shot.png', 'image/png', 33);
    const txt = makeFile('notes.txt', 'text/plain', 12);
    calls.length = 0;
    room.pick([png, txt]);
    await settle();

    const posts = calls.filter((c) => c.url.includes('/attach'));
    check('each chosen file was uploaded', posts.length === 2, String(posts.length));
    check('the name travels in the query, encoded', posts[0].url.includes('name=shot.png'), posts[0].url);
    check('the media type is sent as the content-type', posts[0].headers['content-type'] === 'image/png', JSON.stringify(posts[0].headers));
    check('the raw bytes are the request body', posts[0].raw === png, String(posts[0].raw && posts[0].raw.name));
    check('the input is cleared so the same file can be picked twice', el('file').value === '', JSON.stringify(el('file').value));
    check('the files list is cleared too', !el('file').files || el('file').files.length === 0, JSON.stringify(el('file').files));

    check('the tray is now visible', el('tray').hidden === false);
    check('one chip per staged file', chips().length === 2, String(chips().length));
    const pngChip = chips()[0];
    check('the chip names the file', pngChip.textContent.includes('shot.png'), pngChip.textContent);
    check('the chip shows the size', /B|KB|MB/.test(pngChip.textContent), pngChip.textContent);
    check('an image chip gets a thumbnail', !!pngChip.children.find((c) => c.classList.contains('ar-att-thumb')));
    check('a non-image chip gets an icon instead', !!chips()[1].children.find((c) => c.classList.contains('ar-att-icon')));
    // Asserted from both directions: "the image has one" alone would pass even if
    // every chip got a thumbnail, which would mean rendering a broken `<img>`.
    check('a non-image chip gets NO thumbnail', !chips()[1].children.some((c) => c.classList.contains('ar-att-thumb')), JSON.stringify(chips()[1].children.map((c) => c.className)));
    check('the thumbnail is a local object URL', urlStub.created.length === 1, JSON.stringify(urlStub.created));

    // --- sending posts ids, not paths ----------------------------------------
    calls.length = 0;
    await el('send').onclick();
    await settle();
    const say = calls.find((c) => c.url.includes('/say'));
    check('send posted to /say', !!say, JSON.stringify(calls.map((c) => c.method + ' ' + c.url)));
    check('the say carried a list of ids', Array.isArray(say.body.attachments) && say.body.attachments.length === 2, JSON.stringify(say.body));
    check('every staged id was sent', say.body.attachments.every((id) => String(id).startsWith('f')), JSON.stringify(say.body.attachments));
    check(
      'NO filesystem path is ever sent to the server',
      !/[A-Za-z]:[\\/]|\/(?:Users|home|tmp)\//.test(JSON.stringify(say.body)),
      JSON.stringify(say.body),
    );
    check('the tray is emptied after a successful send', chips().length === 0, String(chips().length));
    check('the tray hides again', el('tray').hidden === true);
    check('the staged object URLs were released', urlStub.revoked.length === 1, JSON.stringify(urlStub.revoked));

    // --- a file with no text is still sendable -------------------------------
    // This is the client half of the server's rule: `say()` accepts a message
    // that is only attachments, so the button must not refuse it.
    room.pick([makeFile('only.png', 'image/png', 5)]);
    await settle();
    check('the send button is enabled with a file and no text', el('send').disabled === false);
    el('input').value = '   ';
    el('input').oninput();
    check('whitespace text does not disable a send that has a file', el('send').disabled === false);

    // --- removing a staged file ----------------------------------------------
    const before = chips().length;
    const removeButton = chips()[0].children.find((c) => c.classList.contains('ar-att-x'));
    check('the chip offers a remove control', !!removeButton);
    removeButton.onclick();
    check('removing unstages exactly one file', chips().length === before - 1, `${before} -> ${chips().length}`);
    check('the tray hides when the last file goes', el('tray').hidden === true);

    // --- a failed send must not cost the user the files ----------------------
    room.pick([makeFile('keep.png', 'image/png', 5)]);
    await settle();
    const staged = chips().length;
    check('a file is staged before the failing send', staged === 1, String(staged));
    sendFailure = 'room is gone';
    el('input').value = 'hello';
    await el('send').onclick();
    await settle();
    check('the failed send is surfaced', /room is gone/.test(el('err').textContent), el('err').textContent);
    check('the staged attachment survives a failed send', chips().length === 1, String(chips().length));
    check('the text survives a failed send too', el('input').value === 'hello', el('input').value);

    // --- an upload failure is attributed to the file -------------------------
    // An IMAGE, because only images mint an object URL: a failed non-image
    // upload would leave nothing to leak, and would pass even if the failure
    // path forgot to release the URL it created.
    uploadFailure = 'file too large';
    const revokedBefore = urlStub.revoked.length;
    room.pick([makeFile('big.png', 'image/png', 9)]);
    await settle();
    check('a failed upload names the file', /big\.png/.test(el('err').textContent), el('err').textContent);
    check('the failure reason is shown', /file too large/.test(el('err').textContent), el('err').textContent);
    check('a failed upload stages nothing', chips().length === 1, String(chips().length));
    check(
      'a failed upload releases the object URL it created',
      urlStub.revoked.length === revokedBefore + 1,
      `${revokedBefore} -> ${urlStub.revoked.length}`,
    );

    room.mounted.destroy();
  }

  // --- drag and drop ----------------------------------------------------------
  {
    const room = await mountRoom({ enabled: true, maxBytes: 1024, maxLabel: '0 MB' });
    const { root, el, chips } = room;

    // `dragover` MUST be cancelled: an uncancelled dragover makes the browser
    // navigate to the dropped file, which reads as the plugin crashing.
    let dragPrevented = 0;
    root.dispatchEvent({
      type: 'dragover',
      dataTransfer: { types: ['Files'], files: [] },
      preventDefault: () => {
        dragPrevented += 1;
      },
    });
    check('dragover is cancelled for a file drag', dragPrevented === 1, String(dragPrevented));
    check('dragover highlights the room', root.classList.contains('dragover'));

    calls.length = 0;
    root.dispatchEvent({
      type: 'drop',
      dataTransfer: { types: ['Files'], files: [makeFile('dropped.png', 'image/png', 5)] },
      preventDefault: () => {},
    });
    await settle();
    check('a drop uploads the file', calls.some((c) => c.url.includes('/attach')), JSON.stringify(calls.map((c) => c.url)));
    check('the dropped file is staged', chips().length === 1, String(chips().length));
    check('the drop clears the highlight', !root.classList.contains('dragover'));

    // A drag that is not files (dragging text) must be left alone.
    let textDragPrevented = 0;
    root.dispatchEvent({
      type: 'dragover',
      dataTransfer: { types: ['text/plain'], files: [] },
      preventDefault: () => {
        textDragPrevented += 1;
      },
    });
    check('a non-file drag is not cancelled', textDragPrevented === 0, String(textDragPrevented));

    // --- paste -------------------------------------------------------------
    calls.length = 0;
    el('input').dispatchEvent({
      type: 'paste',
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => makeFile('pasted.png', 'image/png', 5) }],
      },
      preventDefault: () => {},
    });
    await settle();
    check('a pasted image uploads', calls.some((c) => c.url.includes('/attach')), JSON.stringify(calls.map((c) => c.url)));
    check('the pasted file is staged', chips().length === 2, String(chips().length));

    // A paste with only text must reach the composer untouched.
    let textPasted = 0;
    calls.length = 0;
    el('input').dispatchEvent({
      type: 'paste',
      clipboardData: { items: [{ kind: 'string', getAsFile: () => null }] },
      preventDefault: () => {
        textPasted += 1;
      },
    });
    await settle();
    check('a text-only paste is not swallowed', textPasted === 0, String(textPasted));
    check('a text-only paste uploads nothing', !calls.some((c) => c.url.includes('/attach')));

    room.mounted.destroy();
  }

  // --- the host says uploads are unavailable ----------------------------------
  // The whole point of advertising `uploads` is to say so BEFORE the picker
  // opens, rather than after the user has chosen a file.
  {
    const room = await mountRoom({ enabled: false, maxBytes: 0, maxLabel: '0 MB' });
    const { el, root, chips } = room;

    check('the attach control is disabled when the host refuses uploads', el('attach').disabled === true);
    check('the file input is disabled too', el('file').disabled === true);
    check('the tooltip explains why, not just that it is off', /目录/.test(el('attach').title), el('attach').title);

    // Even if the input fires (a stale page, or a drop), nothing is uploaded
    // and the user is told, rather than the file vanishing.
    calls.length = 0;
    room.pick([makeFile('nope.png', 'image/png', 5)]);
    await settle();
    check('a change is not uploaded when disabled', !calls.some((c) => c.url.includes('/attach')), JSON.stringify(calls.map((c) => c.url)));
    check('the refusal is explained to the user', /目录/.test(el('err').textContent), el('err').textContent);

    calls.length = 0;
    root.dispatchEvent({
      type: 'drop',
      dataTransfer: { types: ['Files'], files: [makeFile('nope.png', 'image/png', 5)] },
      preventDefault: () => {},
    });
    await settle();
    check('a drop is not uploaded when disabled', !calls.some((c) => c.url.includes('/attach')), JSON.stringify(calls.map((c) => c.url)));
    check('nothing is staged when disabled', chips().length === 0, String(chips().length));

    // The cap is surfaced when uploads ARE available, so the user knows the
    // limit before hitting it.
    room.mounted.destroy();
    const room2 = await mountRoom({ enabled: true, maxBytes: 16 * 1024 * 1024, maxLabel: '16 MB' });
    check('the tooltip states the size limit', /16 MB/.test(room2.el('attach').title), room2.el('attach').title);
    check('the state is applied on first paint, not on interaction', room2.el('attach').disabled === false);
    room2.mounted.destroy();
  }

  // --- theme sync between the two entry points --------------------------------
  // The room panel and the DSH Settings row are separate mounts with a copy of
  // the theme each; `agent-room:theme` on the shared window is the whole
  // mechanism. `theme-row.cjs` covers the row's half (it re-reads when told).
  // This covers the room's half, which nothing did before: it must PULL when the
  // row saves, and it must ANNOUNCE when it saves itself. A one-way sync would
  // leave whichever surface the user was not touching showing a stale palette.
  {
    const room = await mountRoom({ enabled: true, maxBytes: 1024, maxLabel: '1 KB' });
    const { root, el, win } = room;

    check('the room panel subscribes to theme changes', (win.listeners.get('agent-room:theme') || []).length > 0, JSON.stringify([...win.listeners.keys()]));

    // The row saves a new colour and announces it. The room must re-read.
    calls.length = 0;
    themeResponse = { ...themeResponse, colors: { ...themeResponse.colors, '--ar-bg': '#0d1512' }, veil: 0.7 };
    win.dispatchEvent(new win.CustomEvent('agent-room:theme'));
    await settle();
    check('an announcement makes the room re-read the theme', calls.some((c) => c.method === 'GET' && c.url.includes('/theme')), JSON.stringify(calls.map((c) => c.method + ' ' + c.url)));
    check('the room repaints to the externally set colour', root.style.getPropertyValue('--ar-bg') === '#0d1512', root.style.getPropertyValue('--ar-bg'));

    // And the reverse: a save from the room's own panel must announce, or an
    // open Settings row keeps showing the old swatches.
    let announced = 0;
    win.addEventListener('agent-room:theme', () => {
      announced += 1;
    });
    el('showtheme').onclick();
    // The swatches carry no `data-el`; they are the colour inputs inside the
    // panel, reached by tag (the shim supports tag selectors).
    const swatch = el('themepanel').querySelector('input');
    check('the room panel exposes a colour control', !!swatch, String(el('themepanel').children.length));
    calls.length = 0;
    if (swatch && swatch.onchange) {
      swatch.value = '#123456';
      swatch.onchange({ target: { value: '#123456' } });
      await settle();
      check('saving from the room panel POSTs the theme', calls.some((c) => c.method === 'POST' && c.url.includes('/theme')), JSON.stringify(calls.map((c) => c.method + ' ' + c.url)));
      check('saving from the room panel announces the change', announced > 0, String(announced));
      check('the room repaints to its own saved colour', root.style.getPropertyValue('--ar-bg') === '#123456', root.style.getPropertyValue('--ar-bg'));
    }

    // A torn-down mount must not stay subscribed, or it keeps fetching and
    // repainting a detached root for the life of the page (a leak per tab
    // switch, since DSH mounts the tab body on demand).
    const before = (win.listeners.get('agent-room:theme') || []).length;
    room.mounted.destroy();
    const after = (win.listeners.get('agent-room:theme') || []).length;
    check('destroying the mount unsubscribes from theme changes', after === before - 1, `${before} -> ${after}`);
  }

  console.log('picker      ＋ opens the input; change uploads raw bytes with name in query');
  console.log('tray        one chip per file, thumbnail only for images, × unstages');
  console.log('send        posts staged IDS (never a path); file-only send is allowed');
  console.log('resilience  a failed send and a failed upload both keep the staged files');
  console.log('drop/paste  dragover cancelled, drop uploads, text-only paste is not swallowed');
  console.log('capability  a host with uploads off disables the control before the picker opens');
  console.log('theme sync  the room pulls on an outside change and announces its own');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
