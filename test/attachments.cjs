#!/usr/bin/env node
/**
 * Attachments end to end: upload -> store -> say -> what each audience sees.
 *
 * The feature exists because a room's agents are child processes whose only way
 * to receive an image is a filesystem path, while a browser must never be given
 * one. That asymmetry is the thing under test, and it has three parts:
 *
 *   1. the store turns uploaded bytes into a path a harness can open,
 *   2. a record carries that path to the ENGINE and to the members' transcripts,
 *   3. every response the CLIENT reads has the path stripped out.
 *
 * Part 3 is the security-relevant half: a route that forgot to strip would hand
 * every browser that can reach the room a map of the disk.
 *
 * No codex, no HTTP: a stub room records what the engine was handed, and the
 * real `RoomApi` drives the routes through fake request/response objects.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { RoomApi } = require('../lib/server.cjs');
const { AttachmentStore, cleanName, storageExtension } = require('../lib/attachments.cjs');
const { AgentRoom } = require('../lib/room.cjs');

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

/** Recursively look for an absolute path anywhere in a value. */
function findPath(value, seen = new Set()) {
  if (typeof value === 'string') return /(?:^|["'\s])[A-Za-z]:[\\/]/.test(value) || value.includes('/agent-room-files/');
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => findPath(child, seen));
}

// ---------------------------------------------------------- the store's rules --

check('a name is reduced to its basename', cleanName('../../etc/passwd') === 'passwd', cleanName('../../etc/passwd'));
check('a windows path is reduced too', cleanName('C:\\Users\\x\\shot.png') === 'shot.png', cleanName('C:\\Users\\x\\shot.png'));
check('a control character is stripped from a name', !cleanName('a\u0000b\u001fc.png').includes('\u0000'), JSON.stringify(cleanName('a\u0000b\u001fc.png')));
check('an empty name gets a fallback', cleanName('', 'file') === 'file');
check('an overlong name is truncated', cleanName('x'.repeat(500)).length <= 180);
check('a plain extension is kept', storageExtension('shot.PNG', 'image/png') === '.png', storageExtension('shot.PNG', 'image/png'));
check('an unknown extension falls back to .bin', storageExtension('x.weird', 'application/octet-stream') === '.bin');
check('a nameless image still gets an image extension', storageExtension('blob', 'image/png') === '.png', storageExtension('blob', 'image/png'));
check('a no-extension executable-ish name is not honoured', storageExtension('x.exe', 'application/octet-stream') === '.bin', storageExtension('x.exe', 'application/octet-stream'));

/**
 * The standalone probe servers must not write into the package they ship from.
 *
 * `lib/index.js` derives the upload and theme directories from the rooms
 * directory's PARENT. Both `test/serve.cjs` and `test/serve-nofiles.cjs` used to
 * default `roomsDir` to `<package>/.rooms`, so every manual probe dropped
 * `agent-room-files/` (real uploaded screenshots) and `agent-room-theme/`
 * (a `theme.json` plus `assets/background.*`) into the plugin's own source tree —
 * observed in practice: nine uploaded files and a stray SVG background had
 * accumulated there. Nothing reads them; they are pure probe residue sitting in
 * a deliverable.
 *
 * Asserted by SOURCE, because the defect is a default value: a behavioural test
 * would have to spawn the server and leave the very pollution it checks for.
 */
const pkgRoot = path.join(__dirname, '..');
for (const file of ['serve.cjs', 'serve-nofiles.cjs']) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  check(
    `${file} does not default its data dir into the package`,
    !/roomsDir:\s*process\.env\.AGENT_ROOM_DIR\s*\|\|\s*path\.join\(__dirname,\s*'\.\.'/.test(source),
    'roomsDir still defaults under __dirname/..',
  );
  check(
    `${file} defaults its data dir to a temp location`,
    /os\.tmpdir\(\)/.test(source),
    'no os.tmpdir() default found',
  );
}
// And the tree itself must be clean right now, so a future run cannot start from
// an already-polluted package and hide the problem.
for (const dir of ['.rooms', 'agent-room-files', 'agent-room-theme']) {
  check(`the package does not contain a stray ${dir}/`, !fs.existsSync(path.join(pkgRoot, dir)), path.join(pkgRoot, dir));
}

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-files-'));
try {
  const store = new AttachmentStore({ dir: storeDir, maxBytes: 1024 });
  const saved = store.save(Buffer.from('hello'), 'note.txt', 'text/plain');
  check('a text file saves', saved.ok === true, saved.error);
  check('the stored name keeps only the basename', path.basename(saved.attachment.path).startsWith(saved.attachment.id), saved.attachment.path);
  check('a text file is not an image', saved.attachment.isImage === false);
  check('the bytes are on disk', fs.readFileSync(saved.attachment.path, 'utf8') === 'hello');

  const img = store.save(Buffer.from('89504e47', 'hex'), 'shot.png', 'image/png');
  check('an image saves and is flagged', img.attachment.isImage === true);

  check('an oversized upload is refused', store.save(Buffer.alloc(2048), 'big.bin', 'application/octet-stream').ok === false);
  check('an empty upload is refused', store.save(Buffer.alloc(0), 'empty.txt', 'text/plain').ok === false);
  check('a disabled store refuses everything', new AttachmentStore({ dir: null }).save(Buffer.from('x'), 'a.txt', 'text/plain').ok === false);

  // Two uploads of the same name must not collide: an earlier message still
  // refers to its own file.
  const again = store.save(Buffer.from('hello2'), 'note.txt', 'text/plain');
  check('a second upload of the same name gets its own file', again.attachment.path !== saved.attachment.path);
  check('the first file is untouched', fs.readFileSync(saved.attachment.path, 'utf8') === 'hello');

  // A restarted process has an empty index but the same directory.
  const cold = new AttachmentStore({ dir: storeDir, maxBytes: 1024 });
  const found = cold.lookup(saved.attachment.id);
  check('a cold store finds a file written by another process', !!found, 'not found');
  check('the recovered path is the original one', !!found && found.path === saved.attachment.path);
  check('an unknown id resolves to nothing', cold.lookup('fdeadbeef') === null);
  check('a path-traversal id resolves to nothing', cold.lookup('../../etc/passwd') === null);

  const read = cold.read(saved.attachment.id);
  check('the stored bytes read back', !!read && read.buffer.toString('utf8') === 'hello');
} finally {
  fs.rmSync(storeDir, { recursive: true, force: true });
}

// ------------------------------------------------------- the engine's transcript --

/**
 * What a member is actually told about an attachment.
 *
 * `_formatRecord` is the single place a record becomes a member's text, so this
 * is where "the agent can open the file" is decided. An image must be named as
 * an image and a plain file as a file — a member that thinks a PNG is text will
 * try to read it and get gibberish.
 */
const room = new AgentRoom({ id: 't', members: [{ id: 'codex' }], prewarm: false, workspaceDirs: {} });
const attachments = [
  { id: 'f1', name: 'shot.png', bytes: 2048, mediaType: 'image/png', isImage: true, path: '/tmp/files/f1.png' },
  { id: 'f2', name: 'notes.md', bytes: 12, mediaType: 'text/markdown', isImage: false, path: '/tmp/files/f2.md' },
];
const member = room.members[0];
const record = room.append({ authorId: 'user', text: '看这个', mentions: [], attachments });
check('the record keeps its attachments', record.attachments.length === 2);
const line = room._formatRecord(member, record);
check('the transcript names the image path', line.includes('/tmp/files/f1.png'), line);
check('the transcript names the file path', line.includes('/tmp/files/f2.md'), line);
check('an image is labelled as an image', /图片/.test(line), line);
check('a plain file is labelled as a file', /文件/.test(line), line);
check('the user text is still there', line.includes('看这个'));
check('unusable attachment entries are dropped', room.append({ authorId: 'user', text: 'x', attachments: [{}, null, { id: 'f3' }] }).attachments.length === 0);

// The segment is what a turn is built from, so it must carry the structured
// entries too (codex needs them to hand the model an image).
const segmentRoom = new AgentRoom({ id: 's', members: [{ id: 'codex' }], prewarm: false, workspaceDirs: {} });
const segMember = segmentRoom.members[0];
segmentRoom._capture({ seq: 1, id: 'm1', ts: new Date().toISOString(), authorId: 'user', text: 'hi', kind: 'user', mentions: [], attachments });
check('the segment carries the structured attachments', segMember.segments[0].attachments.length === 2, String(segMember.segments[0].attachments.length));

// A message that is ONLY a file must still produce a readable record.
const onlyAttachments = room.append({ authorId: 'user', text: '', mentions: [], attachments: [attachments[1]] });
check('an attachment-only record still has text', !!onlyAttachments.text, JSON.stringify(onlyAttachments.text));
check('the placeholder names the file', onlyAttachments.text.includes('notes.md'), onlyAttachments.text);

// ---------------------------------------------------------------- the routes --

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-api-'));
const roomsDir = path.join(dir, 'rooms');
/** Records what `say` was handed, so the route's wiring is checkable. */
const said = [];
class StubRoom {
  constructor(config) {
    this.id = config.id;
    this.title = config.title;
    this.log = [];
    this.logSeq = 0;
  }
  snapshot() {
    return { roomId: this.id, title: this.title, log: this.log, members: [], busy: [] };
  }
  on() {}
  off() {}
  emit() {}
  async connect() {}
  async dispose() {}
  async say(text, options = {}) {
    said.push({ text, attachments: options.attachments || [] });
    const entry = {
      seq: ++this.logSeq,
      id: 'm' + this.logSeq,
      text: text || '（附件）',
      attachments: options.attachments || [],
    };
    this.log.push(entry);
    return { entry, delivered: [], served: [] };
  }
}

const api = new RoomApi({ roomsDir, createRoom: (config) => new StubRoom(config), idleRoomTtlMs: 0 });

/** Drive one request through the real handler with fake req/res objects. */
function request(method, url, body, contentType) {
  return new Promise((resolve) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    req.headers = { 'content-type': contentType || 'application/json' };
    const chunks = [];
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers || {};
      },
      end(payload) {
        if (payload) chunks.push(Buffer.from(payload));
        const raw = Buffer.concat(chunks);
        resolve({
          status: this.status,
          headers: this.headers,
          // Both shapes are offered so a test can assert on bytes without the
          // lossy `binary` string round trip a PNG would not survive.
          raw,
          body: raw.toString('utf8'),
        });
      },
    };
    api
      .handle(req, res, { prefix: '/agent-room', staticFiles: {} })
      .then((handled) => {
        if (!handled) resolve({ status: 404, headers: {}, raw: Buffer.alloc(0), body: 'unhandled' });
      })
      .catch((error) => resolve({ status: 500, headers: {}, raw: Buffer.alloc(0), body: 'FATAL ' + error.message }));
    if (body) req.push(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    req.push(null);
  });
}

const json = (result) => {
  try {
    return JSON.parse(result.body);
  } catch {
    return { parseError: result.body.slice(0, 200) };
  }
};

(async () => {
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

    // --- upload -------------------------------------------------------------
    const up = await request('POST', '/agent-room/attach?name=shot.png&type=image/png', png, 'application/octet-stream');
    const upJson = json(up);
    check('upload answers 200', up.status === 200, String(up.status) + ' ' + up.body.slice(0, 200));
    check('upload returns an id', !!upJson.attachment && !!upJson.attachment.id);
    check('upload flags the image', upJson.attachment && upJson.attachment.isImage === true);
    check('upload remembers the name', upJson.attachment && upJson.attachment.name === 'shot.png');
    check('upload remembers the size', upJson.attachment && upJson.attachment.bytes === png.length);
    check('the upload response does NOT leak a path', !findPath(upJson), up.body.slice(0, 300));
    const id = upJson.attachment.id;

    // A binary body must survive byte-for-byte: a UTF-8 round trip would corrupt it.
    const stored = api.attachments.read(id);
    check('the uploaded bytes are stored unchanged', !!stored && stored.buffer.equals(png));

    // --- a name that tries to escape is defanged -----------------------------
    const evil = await request('POST', '/agent-room/attach?name=' + encodeURIComponent('../../evil.sh') + '&type=text/plain', Buffer.from('x'), 'text/plain');
    const evilJson = json(evil);
    check('a traversal name is stored under a generated name', !!evilJson.attachment && evilJson.attachment.name === 'evil.sh', JSON.stringify(evilJson.attachment));
    check('the traversal name does not escape the store', !!evilJson.attachment && api.attachments.lookup(evilJson.attachment.id).path.startsWith(api.attachments.dir));
    check('no path is leaked for it either', !findPath(evilJson));

    // --- serving ------------------------------------------------------------
    const served = await request('GET', `/agent-room/attachment/${id}`);
    check('an attachment is served', served.status === 200, String(served.status));
    check('the served bytes are the upload', served.raw.equals(png));
    check('the served type is the upload type', served.headers['content-type'] === 'image/png', served.headers['content-type']);
    check('serving is nosniff', served.headers['x-content-type-options'] === 'nosniff');
    check('an unknown attachment is a 404', (await request('GET', '/agent-room/attachment/fnope')).status === 404);

    /**
     * The serve route must not let the CLIENT decide how the browser reads the
     * bytes.
     *
     * `/attachment/<id>` is same-origin with the harness, so honouring the
     * uploaded `mediaType` made this a stored-XSS primitive: a `.html` upload
     * reported as `text/html` was served as an HTML document and its script ran
     * in the harness's own origin (proven in Chromium — `document.title` became
     * `EXECUTED`). `nosniff` does not help: it stops the browser *guessing* a
     * type, not honouring a declared one.
     */
    const scripted = Buffer.from('<!doctype html><script>document.title="pwned"</script>');
    for (const [what, type] of [
      ['html', 'text/html'],
      ['xhtml', 'application/xhtml+xml'],
      ['svg', 'image/svg+xml'],
      ['xml', 'text/xml'],
      ['a javascript type', 'application/javascript'],
      ['a made-up type', 'application/x-nonsense'],
    ]) {
      const up = await request('POST', '/agent-room/attach?name=' + encodeURIComponent('x.' + what) + '&type=' + encodeURIComponent(type), scripted, type);
      const upJson = json(up);
      check(`${what}: upload is accepted`, !!upJson.attachment, up.body.slice(0, 120));
      if (!upJson.attachment) continue;
      // The chip still shows what the user picked; only SERVING is narrowed.
      const back = await request('GET', `/agent-room/attachment/${upJson.attachment.id}`);
      check(`${what}: is NOT served as its own scriptable type`, back.headers['content-type'] === 'application/octet-stream', back.headers['content-type']);
      check(`${what}: the bytes are still intact for the agent`, back.raw.equals(scripted));
    }
    // A stored name cannot break out of the quoted filename either.
    const quoteName = await request('POST', '/agent-room/attach?name=' + encodeURIComponent('a"b.html') + '&type=text/plain', Buffer.from('x'), 'text/plain');
    const quoteJson = json(quoteName);
    if (quoteJson.attachment) {
      const back = await request('GET', `/agent-room/attachment/${quoteJson.attachment.id}`);
      check('a quote in the name cannot add a header parameter', !/filename="[^"]*"[^;]/.test(back.headers['content-disposition'] || ''), back.headers['content-disposition']);
    }

    // --- say carries it to the engine ---------------------------------------
    const say = await request('POST', '/agent-room/say', { room: 'r1', text: '看这个', attachments: [id] });
    const sayJson = json(say);
    check('say answers 200', say.status === 200, say.body.slice(0, 200));
    check('the engine was handed the resolved attachment', said.length === 1 && said[0].attachments.length === 1, JSON.stringify(said.map((s) => s.attachments.length)));
    check('the engine was handed a real path', said.length === 1 && path.isAbsolute(said[0].attachments[0].path), JSON.stringify(said[0] && said[0].attachments[0]));
    check('the say response does NOT leak a path', !findPath(sayJson), say.body.slice(0, 300));

    // An attachment-only message must be accepted.
    said.length = 0;
    const bare = await request('POST', '/agent-room/say', { room: 'r1', attachments: [id] });
    check('an attachment-only say is accepted', bare.status === 200 && said.length === 1, bare.body.slice(0, 200));
    check('an empty say with no attachments is still a no-op', (await request('POST', '/agent-room/say', { room: 'r1', text: '' })).status === 200);

    // An unknown id must be dropped, not fail the message.
    said.length = 0;
    const mixed = await request('POST', '/agent-room/say', { room: 'r1', text: 'hi', attachments: ['fnope', id, id] });
    check('an unknown attachment id does not fail the send', mixed.status === 200, mixed.body.slice(0, 200));
    check('duplicate ids are collapsed', said.length === 1 && said[0].attachments.length === 1, JSON.stringify(said[0] && said[0].attachments.length));

    // --- the state the browser reads ----------------------------------------
    const state = await request('GET', '/agent-room/state?room=r1');
    const stateJson = json(state);
    check('state reports the log', Array.isArray(stateJson.snapshot.log) && stateJson.snapshot.log.length > 0);
    check('state does NOT leak a path in the log', !findPath(stateJson.snapshot.log), JSON.stringify(stateJson.snapshot.log).slice(0, 300));
    check('state reports the theme', !!stateJson.theme && !!stateJson.theme.colors);
    check('state offers the presets', Array.isArray(stateJson.themePresets) && stateJson.themePresets.length > 0);
    check('state reports upload capability', !!stateJson.uploads && stateJson.uploads.enabled === true);

    /**
     * The other half of the capability: a host with no files directory must say
     * so in `/state`, because that flag is the only thing that stops the browser
     * from offering a picker that cannot succeed. `filesDir: null` is how the
     * plugin disables uploads, and the UI now reads this field — so the flag
     * being wrong would silently disable (or wrongly enable) the attach button.
     */
    const offApi = new RoomApi({
      roomsDir,
      createRoom: (config) => new StubRoom(config),
      idleRoomTtlMs: 0,
      filesDir: null,
    });
    const offRes = await new Promise((resolve) => {
      const req = new Readable({ read() {} });
      req.method = 'GET';
      req.url = '/agent-room/state?room=r1';
      req.headers = { 'content-type': 'application/json' };
      const chunks = [];
      const res = {
        status: 0,
        headers: {},
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers || {};
        },
        end(payload) {
          if (payload) chunks.push(Buffer.from(payload));
          resolve({ status: this.status, body: Buffer.concat(chunks).toString('utf8') });
        },
      };
      offApi.handle(req, res, { prefix: '/agent-room', staticFiles: {} }).catch(() => {});
      req.push(null);
    });
    const offJson = JSON.parse(offRes.body);
    check('a host with no files dir reports uploads disabled', offJson.uploads && offJson.uploads.enabled === false, offRes.body.slice(0, 160));
    const offUpload = await new Promise((resolve) => {
      const req = new Readable({ read() {} });
      req.method = 'POST';
      req.url = '/agent-room/attach?name=x.png&type=image/png';
      req.headers = { 'content-type': 'image/png' };
      const chunks = [];
      const res = {
        status: 0,
        headers: {},
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers || {};
        },
        end(payload) {
          if (payload) chunks.push(Buffer.from(payload));
          resolve({ status: this.status, body: Buffer.concat(chunks).toString('utf8') });
        },
      };
      offApi.handle(req, res, { prefix: '/agent-room', staticFiles: {} }).catch(() => {});
      req.push(Buffer.from('89504e47', 'hex'));
      req.push(null);
    });
    check('an upload to a disabled host is refused', offUpload.status === 400, String(offUpload.status) + ' ' + offUpload.body.slice(0, 120));

    // --- the theme routes ---------------------------------------------------
    const themed = await request('POST', '/agent-room/theme', { theme: { preset: 'paper' } });
    const themedJson = json(themed);
    check('the theme route accepts a preset', themed.status === 200 && themedJson.theme.preset === 'paper', themed.body.slice(0, 200));
    const reread = json(await request('GET', '/agent-room/state?room=r1'));
    check('the new theme is what /state now reports', reread.theme.preset === 'paper');

    const hostile = await request('POST', '/agent-room/theme', { theme: { colors: { '--ar-bg': 'red;}html{display:none}' } } });
    check('a hostile colour is refused over HTTP', json(hostile).theme.colors['--ar-bg'] !== 'red;}html{display:none}', hostile.body.slice(0, 200));

    const bg = await request('POST', '/agent-room/theme/background?type=image/png', png, 'image/png');
    check('a background upload is accepted', bg.status === 200 && json(bg).theme.background.kind === 'file', bg.body.slice(0, 200));
    const bgGet = await request('GET', '/agent-room/background');
    check('the background is served', bgGet.status === 200, String(bgGet.status));
    check('with a nosniff header', bgGet.headers['x-content-type-options'] === 'nosniff');
    check('a refused background type is a 400', (await request('POST', '/agent-room/theme/background?type=text/plain', png, 'text/plain')).status === 400);

    /**
     * An SVG background is served as `image/svg+xml` so it can be painted, and
     * that also makes it a scriptable document in the harness's own origin if
     * the URL is opened directly — verified in Chromium, where its
     * `document.title` became `PWNED`. It must therefore carry a CSP that
     * neutralises script; the image still has to render as a background.
     */
    const scriptedSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>document.title="PWNED"</script><rect width="8" height="8"/></svg>');
    const bgSvg = await request('POST', '/agent-room/theme/background?type=' + encodeURIComponent('image/svg+xml'), scriptedSvg, 'image/svg+xml');
    check('an svg background is accepted', bgSvg.status === 200, bgSvg.body.slice(0, 160));
    const bgSvgGet = await request('GET', '/agent-room/background');
    check('the svg background is still typed as svg so it paints', bgSvgGet.headers['content-type'] === 'image/svg+xml', bgSvgGet.headers['content-type']);
    const csp = bgSvgGet.headers['content-security-policy'] || '';
    check('the svg background carries a sandbox CSP', /sandbox/.test(csp), csp);
    check('the svg background CSP blocks script', /script-src\s+'none'|default-src\s+'none'/.test(csp), csp);
    check('the svg background is nosniff', bgSvgGet.headers['x-content-type-options'] === 'nosniff');
    check('the svg bytes are intact', bgSvgGet.raw.equals(scriptedSvg));
    // Put the non-svg background back so the later assertions see a png.
    await request('POST', '/agent-room/theme/background?type=image/png', png, 'image/png');

    // --- a disabled store ---------------------------------------------------
    const noStore = new RoomApi({ roomsDir, filesDir: null, createRoom: (config) => new StubRoom(config), idleRoomTtlMs: 0 });
    const disabled = await new Promise((resolve) => {
      const req = new Readable({ read() {} });
      req.method = 'POST';
      req.url = '/agent-room/attach?name=a.txt&type=text/plain';
      req.headers = {};
      const res = {
        status: 0,
        writeHead(status) {
          this.status = status;
        },
        end(payload) {
          resolve({ status: this.status, body: String(payload || '') });
        },
      };
      noStore.handle(req, res, { prefix: '/agent-room', staticFiles: {} });
      req.push(Buffer.from('x'));
      req.push(null);
    });
    check('uploads are refused when the store is disabled', disabled.status === 400, disabled.body.slice(0, 200));
    await noStore.dispose();
  } finally {
    await api.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('attachments upload, store, transcript paths, and the client/engine split');
  console.log('problems: ' + (problems.length ? '\n  - ' + problems.join('\n  - ') : 'none'));
  process.exit(problems.length ? 1 : 0);
})();
