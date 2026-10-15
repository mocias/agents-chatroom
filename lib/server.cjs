'use strict';
/**
 * HTTP + SSE front door for the room engine.
 *
 * Deliberately plain `node:http`: the same handler is mounted two ways —
 * standalone here (`test/serve.cjs`) and inside DSH through
 * `ctx.webServer.register({ kind: 'prefix', path: '/agent-room', handler })`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { AgentRoom, MODES } = require('./room.cjs');
const { AttachmentStore, defaultFilesDir, defaultThemeDir, IMAGE_MEDIA_TYPES, serveMediaType } = require('./attachments.cjs');
const { ThemeStore, PRESETS, IMAGE_EXTENSIONS } = require('./theme.cjs');
const { HarnessStore, defaultHarnessDir, detectHarnesses, harnessIds } = require('./harnesses.cjs');

/**
 * How long a room nobody is watching may stay alive.
 *
 * A room owns live harness processes, and a room id is just a string a client
 * chooses — including typos, one-off probes and throwaway test ids. Without a
 * reaper every distinct id ever asked for keeps its codex app-server for the
 * life of the DSH process, which is how ten stray `codex.exe` accumulated from
 * ids like `leadprobe`.
 */
const DEFAULT_IDLE_ROOM_TTL_MS = 30 * 60 * 1000;

/**
 * A room id for `POST /new-room`.
 *
 * Deliberately NOT derived from anything the caller owns — in particular not
 * from a DSH session id. A session-derived id means one room per DSH session,
 * which means one harness process per DSH session, which is exactly the leak
 * this endpoint exists to break. The timestamp half keeps ids sortable by
 * creation; the random half keeps two clients that click "new room" in the same
 * millisecond apart.
 */
function newRoomId() {
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `room-${stamp}-${noise}`;
}

/** The two files a room may own on disk. Kept together so delete/close agree. */
function roomDiskFiles(roomsDir, key) {
  if (!roomsDir) return [];
  return [path.join(roomsDir, `${key}.log.jsonl`), path.join(roomsDir, `${key}.members.json`)];
}

/**
 * Headers that make a user-supplied image inert as a *document*.
 *
 * A background may legitimately be an SVG — it is the one upload type that can
 * carry script, and it is served with its real `image/svg+xml` type so it can be
 * painted. As a CSS `background-image` (and as an `<img>`) that script never
 * runs, but the URL is same-origin and guessable, so opening it directly made
 * the harness's own origin run the author's script — verified in Chromium
 * (`document.title` became `PWNED`).
 *
 * `sandbox` puts the document in an opaque origin and blocks script, which
 * neutralises the direct-navigation case, while `default-src 'none'` stops it
 * pulling in anything external. The image still paints: an SVG of plain shapes
 * needs no external resources. Re-verified after the change — an SVG background
 * under these headers still renders, and its script does not run.
 */
const INERT_IMAGE_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'x-content-type-options': 'nosniff',
};

function readJsonBody(request, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('invalid JSON body: ' + error.message));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Read a request body as raw bytes.
 *
 * Uploads must NOT go through `readJsonBody`: a PNG is not UTF-8, and any
 * round-trip through a string would corrupt it. The limit is enforced while
 * streaming rather than after buffering, so an oversized upload is refused and
 * its socket destroyed instead of being fully read into memory first — the
 * difference between a rejected request and a memory-exhaustion bug.
 */
function readBinaryBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    request.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (limitBytes && size > limitBytes) {
        done = true;
        reject(new Error(`request body too large (limit ${Math.round(limitBytes / (1024 * 1024))} MB)`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  response.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  response.end(body);
}

/**
 * Owns the live rooms and exposes them over HTTP.
 *
 * One room per `roomId` so several DSH workspaces can each hold their own
 * group chat without seeing each other's logs.
 */
class RoomApi {
  constructor(options = {}) {
    this.rooms = new Map();
    /**
     * Per-room bookkeeping that outlives the room object itself conceptually:
     * when it was last touched, and how many SSE streams are attached. Kept
     * beside `rooms` because it must not leak into `snapshot()` — the UI has no
     * business knowing about reaping, and tests must not have to stub it.
     */
    this.roomMeta = new Map();
    this.defaults = options;
    this.roomsDir = options.roomsDir || null;
    this.version = options.version || 0;
    /**
     * Fields the room engine owns but this layer still has to report and pass
     * through. Read here once, defensively, so a caller that passes none of them
     * (every existing test does exactly that) keeps the old behaviour and a
     * caller that passes all of them gets them forwarded verbatim — including
     * `undefined`, which means "engine default" rather than "off".
     */
    this.workspaceDirs = options.workspaceDirs || null;
    /**
     * The codex project name every room files its threads under, or `undefined`
     * to let the engine default apply. Not defaulted here: the engine owns that
     * default, and two defaults in two layers is how they drift apart.
     */
    this.projectName = options.projectName;
    this.segmentMs = options.segmentMs;
    this.maxSegmentChars = options.maxSegmentChars;
    this.maxQueuedSegments = options.maxQueuedSegments;
    this.queueStallMs = options.queueStallMs;
    /**
     * Room reaping. `idleRoomTtlMs <= 0` disables it entirely (a long-lived
     * embedding that would rather hold rooms than pay cold starts).
     *
     * The cap is deliberately **soft**: at capacity this reclaims rooms that are
     * already past their TTL, and if none qualify it creates the room anyway and
     * says so. A hard cap would evict a room somebody is mid-conversation in,
     * and an idle room is the only kind that is actually a leak — an in-use room
     * is not.
     */
    this.idleRoomTtlMs = options.idleRoomTtlMs === undefined ? DEFAULT_IDLE_ROOM_TTL_MS : options.idleRoomTtlMs;
    this.maxRooms = options.maxRooms === undefined ? 16 : options.maxRooms;
    this.sweepIntervalMs = options.sweepIntervalMs === undefined ? 60000 : options.sweepIntervalMs;
    /**
     * How to build a room. Overridable so the HTTP layer can be tested against a
     * stubbed engine — the routes are the contract here, and spawning a real
     * harness to check that `POST /members` parses a body would be absurd.
     */
    this.createRoom = options.createRoom || ((config) => new AgentRoom(config));
    /**
     * Called once per session a room opens, with `{roomId, memberId, backend,
     * sessionId, cwd, model, label}`. The engine emits it because filing a
     * session is host business — the codex side wants a codex project, the ACP
     * side wants a DSH workspace row — and the engine must stay runnable with no
     * host at all (every offline test does exactly that).
     */
    this.onSession = options.onSession || null;
    /**
     * Uploads: the bytes a user attaches to a room message, stored where the
     * room's agents can read them by path.
     *
     * The store lives beside the room logs (under the profile) rather than in a
     * room's own directory, because an attachment's path is baked into that
     * room's JSONL history the moment the message is appended. Deleting a room
     * deletes its files; the pictures its history referred to must survive, or a
     * remaining reference would point at nothing.
     */
    this.filesDir = options.filesDir === undefined ? defaultFilesDir(this.roomsDir) : options.filesDir;
    this.maxUploadBytes = options.maxUploadBytes === undefined ? 64 * 1024 * 1024 : options.maxUploadBytes;
    this.attachments = options.attachments || new AttachmentStore({
      dir: this.filesDir,
      maxBytes: this.maxUploadBytes,
      logger: (line) => this._broadcastLog(line),
    });
    /**
     * The room's colours and background, one document for the whole install.
     *
     * Theme is a user preference, not room state: the same colours should follow
     * the user from room to room, and a new room should not start un-themed.
     * Stored under the profile beside the rooms so a plugin reinstall (which
     * replaces the plugin directory) cannot lose it.
     */
    this.theme = options.theme && typeof options.theme.get === 'function'
      ? options.theme
      : new ThemeStore({
          dir: options.themeDir === undefined ? defaultThemeDir(this.roomsDir) : options.themeDir,
          theme: options.theme || null,
          logger: (line) => this._broadcastLog(line),
        });
    /**
     * Which harnesses the add-member form offers. Install-wide like the theme,
     * and stored the same way for the same reason: it is a user preference about
     * this machine's installs, not state belonging to any one room.
     */
    this.harnesses = options.harnesses && typeof options.harnesses.get === 'function'
      ? options.harnesses
      : new HarnessStore({
          dir: options.harnessDir === undefined ? defaultHarnessDir(this.roomsDir) : options.harnessDir,
          logger: (line) => this._broadcastLog(line),
        });
    this.sweepTimer = null;
    this._startSweeper();
  }

  /**
   * Detection is cached briefly because it touches the filesystem and PATH.
   *
   * The settings row and the add-member form both ask for it, and each `GET` on
   * either route would otherwise re-walk PATH. The cache is short enough that
   * installing a harness and clicking "重新检测" feels immediate.
   */
  _detections(maxAgeMs = 5000) {
    const now = Date.now();
    if (this._detectionCache && now - this._detectionCache.at < maxAgeMs) return this._detectionCache.rows;
    const rows = detectHarnesses();
    this._detectionCache = { at: now, rows };
    return rows;
  }

  /**
   * The harness names the add-member dropdown should offer for this room.
   *
   * The union of two lists that answer different questions and are both needed:
   *
   *   - what the USER enabled (a preference about this machine's installs), and
   *   - what this ROOM is wired to (a live pool or a `backends` config entry).
   *
   * A room whose config names a harness must always be able to add a member on
   * it, even when the user has switched to a manual list that omits it —
   * otherwise a hand-written config becomes unreachable from the only UI that
   * can use it. Conversely the enabled list supplies harnesses the room has
   * never touched, which is the whole point of the auto-detection setting.
   *
   * Registry order is preserved so the dropdown is stable (codex first), rather
   * than following insertion order into a Set.
   */
  _offeredBackends(room) {
    const wanted = new Set(this.harnesses.effective(this._detections()));
    for (const name of room.backends()) wanted.add(name);
    const known = harnessIds().filter((id) => wanted.has(id));
    const unknown = Array.from(wanted).filter((id) => !known.includes(id));
    return [...known, ...unknown];
  }

  /**
   * Push a log line to every live room stream.
   *
   * The theme and the attachment store are install-wide, but their diagnostics
   * are only useful inside whichever room the user has open, so they go out on
   * the same channel as the rest. Best-effort: a store with no rooms watching
   * has nowhere to send, and that is not an error.
   */
  _broadcastLog(line) {
    for (const room of this.rooms.values()) {
      try {
        room.emit('log', line);
      } catch {}
    }
  }

  _startSweeper() {
    if (!this.idleRoomTtlMs || this.idleRoomTtlMs <= 0 || !this.sweepIntervalMs || this.sweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle();
    }, this.sweepIntervalMs);
    // Never hold the process open just to reap idle rooms.
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /** Mark a room as still wanted. Every route that reaches a room calls this. */
  _touch(key, now = Date.now()) {
    const meta = this.roomMeta.get(key);
    if (meta) meta.lastUsed = now;
  }

  get(roomId) {
    return this.rooms.get(roomId);
  }

  /**
   * Drop a room and everything it owns **in memory**.
   *
   * Refuses while the room is doing something — a member mid-turn, or a live SSE
   * stream attached — because stopping the pools under a running turn would
   * leave the caller waiting on a reply that can never come. The TTL sweeper
   * simply tries again next tick; `/close-room` reports the refusal.
   *
   * This is the RECYCLE half of the lifecycle and it deliberately leaves the
   * room's files alone: `<key>.log.jsonl` and `<key>.members.json` survive, so a
   * recycled room comes back with its history and roster intact (that is the
   * whole point of R1's persistence). `/delete-room` is the other half: it calls
   * this and then unlinks those files. Never fold the unlink in here — the idle
   * reaper calls this, and a reaper that deleted a room's history whenever the
   * user closed the tab would be a data-loss bug, not a cleanup.
   */
  async closeRoom(roomId, options = {}) {
    const key = roomId || 'default';
    const room = this.rooms.get(key);
    if (!room) return false;
    const meta = this.roomMeta.get(key);
    if (!options.force) {
      if (meta && meta.subscribers > 0) return false;
      if (this._roomBusy(room)) return false;
    }
    this.rooms.delete(key);
    this.roomMeta.delete(key);
    try {
      await room.dispose();
    } catch {}
    return true;
  }

  _roomBusy(room) {
    try {
      const snapshot = room.snapshot();
      return Array.isArray(snapshot && snapshot.busy) && snapshot.busy.length > 0;
    } catch {
      // A room whose snapshot throws is not safe to reap silently.
      return true;
    }
  }

  /**
   * Reap rooms that nobody has touched for `idleRoomTtlMs`.
   *
   * `now` is injectable so a test can advance the clock instead of waiting half
   * an hour.
   */
  async sweepIdle(now = Date.now()) {
    if (!this.idleRoomTtlMs || this.idleRoomTtlMs <= 0) return [];
    const reaped = [];
    for (const [key, meta] of Array.from(this.roomMeta)) {
      if (now - meta.lastUsed < this.idleRoomTtlMs) continue;
      if (await this.closeRoom(key)) reaped.push(key);
    }
    return reaped;
  }

  /**
   * What `GET /rooms` answers.
   *
   * `rooms` must stay a flat array of ids: it is the shape the reaper test and
   * anything else watching for leaks reads, and an object-shaped entry there
   * would silently break `.includes(id)`. The richer per-room rows the switcher
   * needs therefore live beside it in `details`, one entry per id in `rooms` and
   * in the same order, so the two can be zipped without a lookup.
   */
  stats() {
    const details = [];
    for (const [key, room] of this.rooms) {
      let snapshot = null;
      try {
        snapshot = room.snapshot();
      } catch {
        // A room whose snapshot throws is still a live room: report it with the
        // little we know rather than dropping it from the leak count.
      }
      details.push({
        room: key,
        title: (snapshot && snapshot.title) || (room && room.title) || key,
        members: Array.isArray(snapshot && snapshot.members) ? snapshot.members.length : 0,
        logFile: (room && room.logFile) || (this.roomsDir ? path.join(this.roomsDir, `${key}.log.jsonl`) : null),
      });
    }
    return {
      rooms: Array.from(this.rooms.keys()),
      details,
      idleRoomTtlMs: this.idleRoomTtlMs,
      maxRooms: this.maxRooms,
      roomCount: this.rooms.size,
    };
  }

  async ensure(roomId, overrides = {}) {
    const key = roomId || 'default';
    const existing = this.rooms.get(key);
    if (existing) {
      this._touch(key);
      return existing;
    }
    await this._reclaimForCapacity();
    const room = this.createRoom({
      id: key,
      title: overrides.title || this.defaults.title || 'Agent Room',
      cwd: overrides.cwd || this.defaults.cwd || process.cwd(),
      members: overrides.members || this.defaults.members,
      replyPolicy: overrides.replyPolicy || this.defaults.replyPolicy,
      maxRelayHops: this.defaults.maxRelayHops,
      codexPath: this.defaults.codexPath,
      /**
       * Where a UI-edited member list lives. Defaulting per room keeps two
       * workspaces from overwriting each other's rosters.
       */
      rosterFile: this.roomsDir ? path.join(this.roomsDir, `${key}.members.json`) : null,
      /**
       * Where the public log is appended as JSONL. R1's whole point is that a
       * recycled room comes back with its history, so the file lives beside the
       * roster and is keyed the same way — one room, one pair of files.
       */
      logFile: this.roomsDir ? path.join(this.roomsDir, `${key}.log.jsonl`) : null,
      /**
       * R2: per-backend working directories. Passed straight through — the
       * engine decides what a member's cwd is; this layer only carries the
       * configuration and creates the directories (`lib/index.js`).
       */
      workspaceDirs: this.workspaceDirs || undefined,
      /**
       * The codex project every room's threads are filed under. Forwarded even
       * when `undefined`, because the engine's own default is the interesting
       * one; a host that wants the group named after its deployment passes a
       * string, and `null` turns grouping off.
       */
      projectName: this.projectName,
      /**
       * R3 delivery knobs. Forwarded verbatim, `undefined` included: the engine
       * has defaults and a `0` here is a meaningful value ("never segment"),
       * so this layer must not helpfully substitute anything.
       */
      segmentMs: this.segmentMs,
      maxSegmentChars: this.maxSegmentChars,
      maxQueuedSegments: this.maxQueuedSegments,
      queueStallMs: this.queueStallMs,
      backend: overrides.backend || this.defaults.backend,
      backends: overrides.backends || this.defaults.backends,
    });
    this.rooms.set(key, room);
    this.roomMeta.set(key, { lastUsed: Date.now(), createdAt: Date.now(), subscribers: 0 });
    if (typeof this.onSession === 'function') {
      // The engine announces every session it opens; the host files it. Bound to
      // this room so a listener that throws (a missing workspace service, an
      // unwritable store) cannot break the room that is merely trying to start.
      room.on('session', (event) => {
        try {
          void Promise.resolve(this.onSession({ ...event, roomId: event.roomId || key })).catch((error) => {
            this._sessionError(key, error);
          });
        } catch (error) {
          this._sessionError(key, error);
        }
      });
    }
    await room.connect();
    return room;
  }

  /** A session that could not be filed is a log line, never a failed room. */
  _sessionError(key, error) {
    const room = this.rooms.get(key);
    const message = error && error.message ? error.message : String(error);
    if (room && typeof room.emit === 'function') room.emit('log', `filing session failed: ${message}`);
  }

  /**
   * Make room for one more room, preferring already-stale ones.
   *
   * Returns nothing and, when every room is in use, creates nothing: the caller
   * goes on to create its room regardless. That is the soft-cap behaviour
   * described in the constructor.
   */
  async _reclaimForCapacity(now = Date.now()) {
    // `idleRoomTtlMs: 0` means "never reap", and that includes this: the cap is
    // just a second way of reaping, so a deployment that asked to hold every
    // room must not lose one here. Capacity then genuinely does not limit.
    if (!this.idleRoomTtlMs || this.idleRoomTtlMs <= 0) return;
    if (!this.maxRooms || this.maxRooms <= 0) return;
    if (this.rooms.size < this.maxRooms) return;
    for (const [key, meta] of Array.from(this.roomMeta)) {
      if (now - meta.lastUsed < this.idleRoomTtlMs) continue;
      if (await this.closeRoom(key)) return;
    }
  }

  list() {
    return Array.from(this.rooms.values()).map((room) => room.snapshot());
  }

  /**
   * What the theme picker needs to offer the presets.
   *
   * Sent from here rather than hardcoded in each UI so the standalone page and
   * the DSH tab cannot disagree about what "forest" is.
   */
  presetList() {
    return Object.entries(PRESETS).map(([id, preset]) => ({
      id,
      label: preset.label,
      colors: preset.colors,
    }));
  }

  /**
   * Turn the ids a client sent into stored attachments.
   *
   * Ids that do not resolve are dropped rather than failing the whole message: a
   * file removed behind the room's back should cost that one attachment, not the
   * text the user is trying to send. Duplicates are collapsed, since a client
   * that double-adds the same file means it once.
   */
  _resolveAttachments(list) {
    if (!Array.isArray(list) || !list.length) return [];
    const seen = new Set();
    const resolved = [];
    for (const entry of list) {
      const id = typeof entry === 'string' ? entry : entry && entry.id;
      if (!id || seen.has(id)) continue;
      const found = this.attachments.lookup(id);
      if (!found) {
        this._broadcastLog(`attachment ${id} is no longer available`);
        continue;
      }
      seen.add(id);
      resolved.push(found);
    }
    return resolved;
  }

  /**
   * One attachment as the CLIENT may see it.
   *
   * The filesystem path is deliberately absent. It is an install-local absolute
   * path, the client has no use for it (it renders chips and previews by URL),
   * and shipping it to every browser that can reach this route would hand out a
   * map of the disk for no benefit. Members receive paths inside their own
   * transcripts, which is a different audience — see `subscribe` and `_publicSnapshot`,
   * which apply this to every record on its way out.
   */
  _publicAttachment(attachment) {
    if (!attachment) return null;
    return {
      id: attachment.id,
      name: attachment.name,
      bytes: attachment.bytes,
      mediaType: attachment.mediaType,
      isImage: !!attachment.isImage,
    };
  }

  /**
   * A room record with its attachment paths removed.
   *
   * Every record leaves this layer through here: the live `message` event, the
   * `snapshot`/`update` snapshots, and the per-request `/state` answer. There is
   * exactly one such boundary on purpose — the engine must keep the real paths
   * (it hands them to the harnesses), so the place that decides what a browser
   * may see has to be the place the browser is actually served from.
   */
  _publicRecord(record) {
    if (!record || !Array.isArray(record.attachments) || !record.attachments.length) return record;
    return { ...record, attachments: record.attachments.map((entry) => this._publicAttachment(entry)).filter(Boolean) };
  }

  /** A snapshot whose log carries no filesystem paths. */
  _publicSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.log)) return snapshot;
    return { ...snapshot, log: snapshot.log.map((record) => this._publicRecord(record)) };
  }

  async dispose() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const room of this.rooms.values()) {
      try {
        await room.dispose();
      } catch {}
    }
    this.rooms.clear();
    this.roomMeta.clear();
  }

  /** Live event stream for one room as Server-Sent Events. */
  subscribe(room, request, response, webRoot) {
    // An attached stream is proof somebody is watching: it both protects the
    // room from the reaper and keeps its `lastUsed` fresh. Browsers reconnect
    // EventSource on their own, so a dropped stream re-touches within seconds.
    const meta = this.roomMeta.get(room.id);
    if (meta) {
      meta.subscribers += 1;
      meta.lastUsed = Date.now();
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // SSE is not gzipped by the host server, so no flush gymnastics are needed.
    response.write('retry: 2000\n\n');

    const push = (event) => {
      response.write('data: ' + JSON.stringify(event) + '\n\n');
    };
    push({ type: 'snapshot', snapshot: this._publicSnapshot(room.snapshot()) });

    const onUpdate = (snapshot) => push({ type: 'update', snapshot: this._publicSnapshot(snapshot) });
    const onMessage = (record) => push({ type: 'message', record: this._publicRecord(record) });
    const onStream = (event) => push({ type: 'stream', event });
    const onLog = (line) => push({ type: 'log', line });

    room.on('update', onUpdate);
    room.on('message', onMessage);
    room.on('stream', onStream);
    room.on('log', onLog);

    const keepAlive = setInterval(() => response.write(': ping\n\n'), 20000);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepAlive);
      if (meta) {
        meta.subscribers = Math.max(0, meta.subscribers - 1);
        meta.lastUsed = Date.now();
      }
      room.off('update', onUpdate);
      room.off('message', onMessage);
      room.off('stream', onStream);
      room.off('log', onLog);
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
  }

  /**
   * Route one request. Returns true when handled.
   *
   * `options.staticFiles` maps a suffix (e.g. `/app.js`) to { body, type }.
   */
  async handle(request, response, options = {}) {
    const url = new URL(request.url, 'http://localhost');
    // The host strips its own prefix before delegating; standalone we accept both.
    let pathname = url.pathname;
    const prefix = options.prefix;
    if (prefix && pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length) || '/';
    if (!pathname.startsWith('/')) pathname = '/' + pathname;

    const method = request.method || 'GET';

    try {
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const file = options.staticFiles && options.staticFiles['/index.html'];
        sendText(response, 200, file ? file.body : '<!doctype html><title>agent-room</title>', 'text/html; charset=utf-8');
        return true;
      }

      if (method === 'GET' && pathname === '/app.js') {
        const file = options.staticFiles && options.staticFiles['/app.js'];
        if (!file) return sendText(response, 404, 'not found'), true;
        sendText(response, 200, file.body, file.type || 'text/javascript; charset=utf-8');
        return true;
      }

      if (method === 'GET' && pathname === '/state') {
        const roomId = url.searchParams.get('room') || 'default';
        const room = await this.ensure(roomId);
        sendJson(response, 200, {
          snapshot: this._publicSnapshot(room.snapshot()),
          modes: Object.keys(MODES),
          policies: ['addressed', 'everyone', 'mentioned-only'],
          /**
           * The theme travels with the state so the UI paints correctly on its
           * FIRST frame. Fetching it separately would mean the room renders in
           * the default colours and then repaints — a visible flash of the wrong
           * theme on every reload, for no gain.
           */
          theme: this.theme.get(),
          themePresets: this.presetList(),
          /**
           * Which harnesses this machine has, and which the user wants offered.
           * Sent with the state so the add-member form is correct on its first
           * open — the alternative is a dropdown that fills in a beat later.
           */
          harnesses: this.harnesses.rows(this._detections()),
          uploads: {
            enabled: this.attachments.enabled,
            maxBytes: this.maxUploadBytes,
            maxLabel: `${Math.round(this.maxUploadBytes / (1024 * 1024))} MB`,
          },
        });
        return true;
      }

      if (method === 'GET' && pathname === '/events') {
        const roomId = url.searchParams.get('room') || 'default';
        const room = await this.ensure(roomId);
        this.subscribe(room, request, response, options);
        return true;
      }

      /**
       * Say something in a room, optionally with files attached.
       *
       * The client sends attachment IDS, never paths: a path from the wire would
       * let a caller name any file on the machine and have the room's agents read
       * it. The store is the only thing that can turn an id into a path, and it
       * only ever resolves ids it handed out (or a file it already owns).
       */
      if (method === 'POST' && pathname === '/say') {
        const body = await readJsonBody(request);
        const room = await this.ensure(body.room || 'default');
        const attachments = this._resolveAttachments(body.attachments);
        const result = await room.say(body.text, {
          authorId: body.authorId,
          authorLabel: body.authorLabel,
          attachments,
        });
        sendJson(response, 200, {
          ok: true,
          /**
           * The record as the CLIENT may see it. The engine's copy carries the
           * real filesystem paths (its members need them); this response goes to
           * a browser, so it goes through the same boundary as the SSE stream.
           */
          entry: this._publicRecord(result.entry),
          delivered: result.delivered,
          attachments: attachments.map((entry) => this._publicAttachment(entry)),
        });
        return true;
      }

      /**
       * The room's theme: read it, or change part of it.
       *
       * `PATCH`-like semantics rather than a full replace: the UI's colour
       * pickers each send one token, and a replace-shaped route would make every
       * swatch drag re-send (and be at the mercy of a stale copy of) the whole
       * theme, including the background it is not touching.
       */
      if (method === 'GET' && pathname === '/theme') {
        sendJson(response, 200, { ok: true, theme: this.theme.get(), presets: this.presetList() });
        return true;
      }

      if (method === 'POST' && pathname === '/theme') {
        const body = await readJsonBody(request);
        const theme = this.theme.update(body.theme || body);
        sendJson(response, 200, { ok: true, theme });
        return true;
      }

      /**
       * Store one uploaded file and answer with its id.
       *
       * The body is the raw bytes with the name and type in the query string,
       * not a multipart form: the client is our own `fetch`, so there is nothing
       * to negotiate, and multipart would mean writing a parser whose only job is
       * to undo an encoding we chose. `POST /say` then refers to the file by the
       * id this returns.
       */
      if (method === 'POST' && pathname === '/attach') {
        if (!this.attachments.enabled) {
          sendJson(response, 400, { ok: false, error: 'uploads are unavailable here' });
          return true;
        }
        const name = url.searchParams.get('name') || 'file';
        const mediaType = url.searchParams.get('type') || '';
        const buffer = await readBinaryBody(request, this.maxUploadBytes);
        const saved = this.attachments.save(buffer, name, mediaType);
        if (!saved.ok) {
          sendJson(response, 400, { ok: false, error: saved.error });
          return true;
        }
        sendJson(response, 200, { ok: true, attachment: this._publicAttachment(saved.attachment) });
        return true;
      }

      /**
       * Serve one stored attachment back.
       *
       * Needed for exactly one case: a background image the user uploaded, which
       * the browser fetches as a URL. Message attachments are shown as chips
       * rather than rendered, but a background is by definition displayed, so it
       * must be reachable — and it is served from the store, so the theme never
       * has to name a path the browser could use to read something else.
       *
       * `nosniff` alone is NOT the defence here, and the earlier version of this
       * comment was wrong to imply it was: `nosniff` stops the browser *guessing*
       * a type, not honouring a declared one. The defence is `serveMediaType`,
       * which never returns a scriptable type — see its note.
       */
      if (method === 'GET' && pathname.startsWith('/attachment/')) {
        const id = decodeURIComponent(pathname.slice('/attachment/'.length));
        const found = this.attachments.read(id);
        if (!found) {
          sendText(response, 404, 'not found');
          return true;
        }
        const { attachment, buffer } = found;
        response.writeHead(200, {
          // NOT `attachment.mediaType`: that value is what the client claimed at
          // upload, and this route is same-origin with the harness, so honouring
          // it let an uploaded `.html` be served as an HTML document whose
          // script ran with the harness's own session (verified in Chromium).
          // `serveMediaType` narrows it to inert types and answers
          // `application/octet-stream` (a download) for everything else.
          'content-type': serveMediaType(attachment.mediaType),
          'content-length': buffer.length,
          'cache-control': 'private, max-age=31536000, immutable',
          // `encodeURIComponent` escapes the header-relevant characters in a
          // user-supplied name — `"` to `%22` and `\` to `%5C`, so it cannot
          // close the quoted filename and append parameters, and newline/CR to
          // `%0A`/`%0D`, so it cannot split the header. It escapes strictly more
          // than a `["\\]` replace does. The name here is only a download hint.
          'content-disposition': `inline; filename="${encodeURIComponent(attachment.name)}"`,
          'x-content-type-options': 'nosniff',
        });
        response.end(buffer);
        return true;
      }

      /**
       * The background image, as a stable URL.
       *
       * Separate from `/attachment/<id>` because the theme refers to a background
       * by generation, not by upload id: replacing the image must change the URL
       * so a cached one is not shown stale, and the theme document itself stores
       * no path. `?v=` is that generation, and is ignored here — its only job is
       * to be different.
       */
      if (method === 'GET' && pathname === '/background') {
        const file = this.theme.backgroundFile();
        if (!file) {
          sendText(response, 404, 'no background');
          return true;
        }
        let buffer;
        try {
          buffer = await fs.promises.readFile(file);
        } catch (error) {
          sendText(response, 404, 'no background');
          return true;
        }
        const ext = path.extname(file).toLowerCase();
        const type = Object.entries(IMAGE_EXTENSIONS).find(([, value]) => value === ext);
        response.writeHead(200, {
          'content-type': type ? type[0] : 'application/octet-stream',
          'content-length': buffer.length,
          'cache-control': 'private, max-age=31536000, immutable',
          // An SVG background is served as `image/svg+xml` so it can be painted,
          // which also makes it a scriptable document if opened directly.
          ...INERT_IMAGE_HEADERS,
        });
        response.end(buffer);
        return true;
      }

      /**
       * Upload a background image.
       *
       * Same raw-bytes shape as `/attach`, but it lands in the theme's own
       * asset directory rather than the general file store: a background is not
       * a message attachment, and letting it accumulate one file per experiment
       * in the attachment store would make "the current background" a matter of
       * remembering which upload id was last chosen.
       */
      if (method === 'POST' && pathname === '/theme/background') {
        const mediaType = url.searchParams.get('type') || '';
        const buffer = await readBinaryBody(request, 16 * 1024 * 1024);
        const saved = this.theme.saveBackground(buffer, mediaType);
        if (!saved.ok) {
          sendJson(response, 400, { ok: false, error: saved.error });
          return true;
        }
        sendJson(response, 200, { ok: true, theme: saved.theme });
        return true;
      }

      if (method === 'POST' && pathname === '/mode') {
        const body = await readJsonBody(request);
        const room = await this.ensure(body.room || 'default');
        room.setMode(body.mode);
        sendJson(response, 200, { ok: true, mode: room.mode });
        return true;
      }

      if (method === 'POST' && pathname === '/policy') {
        const body = await readJsonBody(request);
        const room = await this.ensure(body.room || 'default');
        const policy = room.setReplyPolicy(body.policy);
        sendJson(response, 200, { ok: true, replyPolicy: policy });
        return true;
      }

      /**
       * R1: 「清空本房间」is gone.
       *
       * Its semantics were "wipe this room's log and reset every thread", which
       * is a destructive in-place reset nobody could undo and which left the
       * harness processes running anyway. "Start over" is now delete the room
       * and make a new one (`/delete-room` + `/new-room`), so this route is a
       * tombstone: it answers 410 with the replacement spelled out, instead of
       * 404, so an old client learns what to do rather than what it got wrong.
       *
       * The engine side went further: `room.newConversation()` no longer exists
       * either. An in-place reset had to fight the segment buffers, the members'
       * read cursors and the on-disk log, and getting it wrong would silently
       * drop text people had already typed. Deleting the room deletes all of
       * that at once, which is why the route and the method died together.
       */
      if (method === 'POST' && pathname === '/new-conversation') {
        sendJson(response, 410, {
          ok: false,
          error: 'new-conversation has been removed; delete the room and create a new one instead',
        });
        return true;
      }

      /**
       * R1: create a room.
       *
       * A new room id is generated rather than reused from a session, because a
       * session-derived id is one room — and one set of harness processes — per
       * DSH session. Passing `room` explicitly is still allowed (and is what the
       * UI does when it hands back an existing id): an id that already exists is
       * reported as `existed: true` and NOT re-`connect()`ed, so a double click
       * cannot start a second harness behind the same room.
       */
      if (method === 'POST' && pathname === '/new-room') {
        const body = await readJsonBody(request);
        const requested = typeof body.room === 'string' ? body.room.trim() : '';
        const key = requested || newRoomId();
        const existed = this.rooms.has(key);
        const room = await this.ensure(key, { title: body.title });
        sendJson(response, 200, { ok: true, room: key, title: room && room.title, existed });
        return true;
      }

      /**
       * R1: delete a room — processes, memory AND files.
       *
       * The difference from `/close-room` in one line: this one is destructive
       * and irreversible, that one is a recycle. `closeRoom` refuses a busy room
       * or one with a live SSE stream; `force: true` is the documented way
       * through, and a delete that silently refused would leave the user with a
       * room they cannot get rid of, so the UI always sends it.
       *
       * File deletion is best-effort and ENOENT-tolerant: a room that never wrote
       * a log, or whose files a previous delete already removed, is still a
       * successful delete. Only a genuine filesystem error surfaces.
       */
      if (method === 'POST' && pathname === '/delete-room') {
        const body = await readJsonBody(request);
        const key = body.room || url.searchParams.get('room') || 'default';
        const force = body.force === true || url.searchParams.get('force') === '1';
        const deleted = await this.closeRoom(key, { force });
        const files = [];
        for (const file of roomDiskFiles(this.roomsDir, key)) {
          try {
            await fs.promises.unlink(file);
            files.push(path.basename(file));
          } catch (error) {
            if (error && error.code !== 'ENOENT') throw error;
          }
        }
        sendJson(response, 200, { ok: true, deleted, room: key, files });
        return true;
      }

      if (method === 'POST' && pathname === '/interrupt') {
        const body = await readJsonBody(request);
        const room = await this.ensure(body.room || 'default');
        const stopped = await room.interruptAll();
        sendJson(response, 200, { ok: true, stopped });
        return true;
      }

      if (method === 'GET' && pathname === '/models') {
        const room = await this.ensure(url.searchParams.get('room') || 'default');
        sendJson(response, 200, {
          available: room.availableModels,
          backends: this._offeredBackends(room),
          models: room.modelsByBackend(),
          harnesses: this.harnesses.rows(this._detections()),
          members: room.members.map((member) => ({
            id: member.id,
            model: member.model,
            label: member.label,
            backend: member.backend,
            error: member.error,
          })),
        });
        return true;
      }

      /** The harness registry, its detection result, and the user's selection. */
      if (method === 'GET' && pathname === '/harnesses') {
        // `?refresh=1` is the settings row's "重新检测" button. Without it the
        // short cache above applies, which is what keeps the form cheap.
        if (url.searchParams.get('refresh')) this._detectionCache = null;
        sendJson(response, 200, { harnesses: this.harnesses.rows(this._detections(0)) });
        return true;
      }

      if (method === 'POST' && pathname === '/harnesses') {
        const body = await readJsonBody(request);
        const enabled = this.harnesses.update(body);
        this._detectionCache = null;
        sendJson(response, 200, { ok: true, enabled, harnesses: this.harnesses.rows(this._detections(0)) });
        return true;
      }

      /**
       * Add a teammate.
       *
       * `backend` picks which harness the new member runs on: the default codex
       * app-server is one pool, and an ACP harness is another. The member joins
       * at its first turn — nothing is spawned here — so adding several members
       * to look at them is free.
       */
      if (method === 'POST' && pathname === '/members') {
        const body = await readJsonBody(request);
        const room = await this.ensure(body.room || 'default');
        const member = await room.addMember({
          id: body.id,
          label: body.label,
          model: body.model,
          persona: body.persona,
          backend: body.backend,
        });
        sendJson(response, 200, { ok: true, member: room.toConfig(member) });
        return true;
      }

      /** Re-point a member: model, persona, display name. */
      if (method === 'POST' && pathname === '/member') {
        const body = await readJsonBody(request);
        const room = await this.ensure(body.room || 'default');
        if (body.model) room.setMemberModel(body.id, body.model);
        if (body.persona !== undefined) room.setMemberPersona(body.id, body.persona);
        if (body.label) room.setMemberLabel(body.id, body.label);
        const member = room.members.find((m) => m.id === body.id);
        sendJson(response, 200, { ok: true, member: member ? room.toConfig(member) : null });
        return true;
      }

      if (method === 'POST' && pathname === '/remove-member') {
        const body = await readJsonBody(request);
        const room = await this.ensure(body.room || 'default');
        const removed = await room.removeMember(body.id);
        sendJson(response, 200, { ok: true, removed: room.toConfig(removed) });
        return true;
      }

      /**
       * Which rooms are live, and how the reaper is configured.
       *
       * Exists because a room costs real processes: without this the only way to
       * see a leaked room was to count `codex.exe` in the task manager.
       */
      if (method === 'GET' && pathname === '/rooms') {
        sendJson(response, 200, this.stats());
        return true;
      }

      /**
       * Recycle one room now: stop its harness processes and forget its log.
       *
       * **Files are kept.** This is the difference from `/delete-room`: a
       * recycled room's `<room>.log.jsonl` and `<room>.members.json` stay on
       * disk, so the next `/state?room=<room>` reads the history and roster back
       * and the user finds the conversation where they left it. Deleting a room
       * (`/delete-room`) is what removes the files.
       *
       * `?force=1` reaps even a busy room or one with an open event stream — the
       * escape hatch a user needs when a turn is wedged, since the alternative is
       * restarting DSH.
       */
      if (method === 'POST' && pathname === '/close-room') {
        const body = await readJsonBody(request);
        const key = body.room || url.searchParams.get('room') || 'default';
        const force = body.force === true || url.searchParams.get('force') === '1';
        const closed = await this.closeRoom(key, { force });
        sendJson(response, 200, { ok: true, closed, room: key });
        return true;
      }

      return false;
    } catch (error) {
      sendJson(response, 500, { ok: false, error: (error && error.message) || String(error) });
      return true;
    }
  }
}

module.exports = { RoomApi, readJsonBody, readBinaryBody, sendJson, sendText };
