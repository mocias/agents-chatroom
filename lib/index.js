/**
 * Host half of the agent-room plugin.
 *
 * Runs entirely inside the DSH host process:
 *   - a prefix HTTP route on `ctx.webServer` serves the room API and the UI,
 *   - the room engine spawns codex app-servers (and any configured ACP harness)
 *     as child processes of this host, and stops them when a room is reaped or
 *     when the plugin unloads.
 *
 * It deliberately owns NO model-facing tool and no Remote namespace: the room is
 * driven from the browser over the routes registered here.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { canonicalBackend, harnessIds, detectHarnesses } = require(join(here, 'harnesses.cjs'));

export const name = 'dsh-agent-room';

export const inject = ['webServer'];

// No `Config` export on purpose: this package does not depend on a schema
// library, and the loader treats a missing Config as the ordinary `absent`
// state. Every key below is read defensively from the row's `config:` block.

const STATIC = {
  '/index.html': { file: join(here, '..', 'public', 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: join(here, '..', 'public', 'room-ui.js'), type: 'text/javascript; charset=utf-8' },
};

/**
 * Where a UI-edited roster lives.
 *
 * The point of persisting it is surviving a DSH restart, so it belongs under the
 * profile, not in the plugin directory (which is replaced on reinstall) and not
 * in the room's cwd (which is whatever the session happens to be working on).
 * An unwritable location degrades to in-memory rosters rather than failing.
 */
function defaultRoomsDir(fallback) {
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (!profileDir) return join(fallback, '.agent-room-rooms');
  return join(profileDir, 'agent-room-rooms');
}

/**
 * R2: one fixed working directory per harness (backend), shared by every room.
 *
 * A "workspace" means nothing more to a harness than a `cwd` string, so this is
 * a lookup table: `member.backend` -> directory. All codex members share one
 * directory, all DSH members share another, all Qoder members a third; a room
 * does not get its own.
 *
 * Two obligations attach to the directories, which is why this function exists
 * instead of a straight pass-through of the config value:
 *
 *   1. **Every directory must exist before it is used.** ACP's `session/new` is
 *      given `{ cwd }` and rejects a path that is not there, and it must be
 *      absolute; codex is happier with the same guarantee. So every directory in
 *      the returned table has been `mkdirSync`-ed.
 *   2. **Every backend must resolve to something.** A backend missing from the
 *      config falls back to `<profile>/agent-room-workspace/<backend>` rather
 *      than being left without a cwd — a missing entry would silently drop that
 *      member back to the host's working directory, which is the behaviour R2
 *      removes.
 *
 * The table is read from config only: no UI, no runtime switching, no per-room
 * or per-member override. An unwritable directory is a warning and not a
 * failure — the member then fails loudly at its first turn, which is better than
 * the plugin refusing to load.
 */
function resolveWorkspaceDirs(config, roomsDir, logger) {
  const configured = config.workspaceDirs && typeof config.workspaceDirs === 'object' ? config.workspaceDirs : {};
  // Every harness this build knows how to run, plus any extra pool the
  // configuration declares. Resolved in this order so an explicit entry always
  // wins over a fallback. Driven by the registry rather than a literal list, so
  // adding a harness there is enough to give it a directory here.
  const backends = harnessIds();
  for (const name of Object.keys(configured)) if (!backends.includes(name)) backends.push(name);
  if (config.backends && typeof config.backends === 'object') {
    for (const name of Object.keys(config.backends)) if (!backends.includes(name)) backends.push(name);
  }
  if (typeof config.backend === 'string' && config.backend && !backends.includes(config.backend)) {
    backends.push(config.backend);
  }

  const dirs = {};
  for (const backend of backends) {
    // A pre-registry config may still name the old protocol key; fold it onto
    // the harness it meant so `workspaceDirs.acp` keeps working.
    const canonical = canonicalBackend(backend);
    const value = configured[backend] !== undefined ? configured[backend] : configured[canonical];
    const dir =
      typeof value === 'string' && value.trim()
        ? value.trim()
        : join(roomsDir, '..', 'agent-room-workspace', canonical);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      logger?.warn?.(`agent-room: cannot use workspace dir ${dir} for ${backend}: ${error.message}`);
    }
    dirs[backend] = dir;
    if (!(canonical in dirs)) dirs[canonical] = dir;
  }
  return dirs;
}

/**
 * File a harness session where that harness's own GUI will show it.
 *
 * Two harnesses, two completely different notions of "workspace":
 *
 *   - **codex** has a `project`, and the engine files those itself
 *     (`codex-pool.cjs#syncProject`) because it can be done over the app-server
 *     RPC the pool already speaks.
 *   - **DSH/ACP** has a real workspace row in `ctx.workspaceRegistry`, which
 *     only exists in the host process. That is this function's job.
 *
 * A DSH workspace is keyed by its canonical path and a session may only be
 * attached when its stored header `cwd` resolves to exactly that path, so both
 * halves are one directory per harness: the same `workspaceDirs.acp` the engine
 * hands the ACP child as `session/new { cwd }`.
 *
 * Nothing here is fatal. The service may be absent (a profile without
 * `dsh-web-app`), the directory may be unwritable, or the session may be
 * invisible to this profile's session store; in every case this function
 * resolves without attaching and the caller logs whatever it cannot do. Grouping
 * is a convenience layered on top of the room, never a precondition for it.
 *
 * Exported for the offline test: the real call site is `apply` below, and the
 * test drives this same function rather than a copy of its logic.
 */
export function createSessionFiler(ctx, workspaceDirs) {
  /**
   * Looked up per call rather than at apply time, and deliberately NOT declared
   * in `inject`: a hard dependency on `workspaceRegistry` would stop this whole
   * plugin from loading in any profile that does not bundle `dsh-web-app` — the
   * room itself would go down to gain a grouping convenience. The lookup also
   * happens long after apply (the first session is however long the user takes
   * to type), so a service still starting when this plugin loaded is ready by
   * the time anything asks for it.
   */
  const available = () => {
    const found = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null;
    return found && typeof found.create === 'function' ? found : null;
  };
  /** One promise per directory, so the first session creates the row once. */
  const workspaces = new Map();
  const workspaceFor = (dir) => {
    if (!workspaces.has(dir)) {
      const found = available();
      if (!found) return Promise.resolve(null);
      // `create` is idempotent by canonical path and its title only applies on
      // the first create, so a second DSH process (or a plugin reload) adopting
      // an existing row is the normal case, not an error.
      workspaces.set(
        dir,
        Promise.resolve(found.create(dir, 'agent-room (DSH)')).catch((error) => {
          workspaces.delete(dir);
          throw error;
        }),
      );
    }
    return workspaces.get(dir);
  };

  return async function file(event) {
    // Only a DSH-hosted ACP session can be adopted by a DSH workspace row: the
    // registry catalogs *this* harness's sessions, and Qoder's sessions are not
    // in it. The harness id is what decides, not the protocol, which is why this
    // checks for `dsh` rather than for "any ACP backend".
    if (canonicalBackend(event.backend) !== 'dsh' || !event.sessionId) return;
    const dir = workspaceDirs[canonicalBackend(event.backend)] || event.cwd;
    if (!dir) return;
    const workspace = await workspaceFor(dir);
    if (!workspace || typeof workspace.attachSession !== 'function') return;
    // Safe immediately: `dsh-acp` flushes the session header to disk before it
    // answers `session/new`, so by the time the engine holds this id the header
    // the registry validates against is already stored.
    await workspace.attachSession(event.sessionId);
    ctx.logger?.info?.(`agent-room: filed session ${event.sessionId} into workspace ${dir}`);
  };
}

export function apply(ctx, config = {}) {
  const { RoomApi } = require(join(here, '..', 'lib', 'server.cjs'));
  const { defaultFilesDir, defaultThemeDir } = require(join(here, '..', 'lib', 'attachments.cjs'));

  const routePrefix = (config.routePrefix || '/agent-room').replace(/\/$/, '');
  const staticFiles = {};
  for (const [suffix, entry] of Object.entries(STATIC)) {
    try {
      staticFiles[suffix] = { body: readFileSync(entry.file, 'utf8'), type: entry.type };
    } catch (error) {
      ctx.logger?.warn?.(`agent-room: cannot read ${entry.file}: ${error.message}`);
    }
  }

  const cwd = config.cwd || process.cwd();
  const roomsDir = config.roomsDir || defaultRoomsDir(cwd);
  try {
    mkdirSync(roomsDir, { recursive: true });
  } catch (error) {
    ctx.logger?.warn?.(`agent-room: cannot use rooms dir ${roomsDir}: ${error.message}`);
  }

  /**
   * R2's per-harness directories. Created here, at load time, so that the first
   * turn of the first member does not discover that its cwd is missing.
   */
  const workspaceDirs = resolveWorkspaceDirs(config, roomsDir, ctx.logger);

  const fileSession = createSessionFiler(ctx, workspaceDirs);

  /**
   * Uploads and the theme live under the profile beside the rooms, and both are
   * created here so an unwritable location is one warning at load rather than a
   * surprise at the user's first drag-and-drop. A `null` disables the feature
   * cleanly: the routes answer 400 and the UI hides the controls, which is the
   * right behaviour on a read-only install.
   *
   * Derived from the RESOLVED `roomsDir`, not from `config.roomsDir`. Deriving
   * from the config value (as an earlier draft did) made both `null` on every
   * ordinary install — no config, no explicit path — so uploads and theming were
   * silently dead everywhere except the tests that passed a `roomsDir` in.
   */
  const filesDir = config.filesDir !== undefined ? config.filesDir : defaultFilesDir(roomsDir);
  const themeDir = config.themeDir !== undefined ? config.themeDir : defaultThemeDir(roomsDir);
  for (const dir of [filesDir, themeDir]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      ctx.logger?.warn?.(`agent-room: cannot use ${dir}: ${error.message}`);
    }
  }

  const api = new RoomApi({
    cwd,
    /**
     * Where an opened harness session gets filed. The ACP side needs the DSH
     * host for this (a workspace row lives in `workspaceRegistry`), so the
     * callback is created here and the engine only announces events.
     */
    onSession: fileSession,
    members: Array.isArray(config.members) && config.members.length ? config.members : undefined,
    replyPolicy: config.replyPolicy || 'addressed',
    codexPath: config.codexPath || undefined,
    roomsDir,
    /**
     * R2: the fixed per-backend working directories, already created. Passed as
     * one object because the engine looks up a member's cwd by `member.backend`.
     */
    workspaceDirs,
    /**
     * The codex project that collects this harness's threads. Named after the
     * harness rather than a room, because the user asked for one workspace per
     * harness holding every conversation it has had. `null` disables it.
     */
    projectName: config.projectName,
    /**
     * R3 delivery knobs, forwarded only when configured so the engine's own
     * defaults stay in charge otherwise. Each is passed through verbatim —
     * including an explicit `0`, which means "off" and must not be mistaken for
     * "not configured".
     */
    segmentMs: config.segmentMs,
    maxSegmentChars: config.maxSegmentChars,
    maxQueuedSegments: config.maxQueuedSegments,
    queueStallMs: config.queueStallMs,
    /**
     * Extra pools, by harness name. The codex app-server is built in; an ACP
     * harness is described here (`{ qoder: { agentCommand, agentArgs, env } }`)
     * and is only spawned if a member actually names that harness. Omitted
     * entirely, every ACP harness still falls back to the launch line this
     * machine's own install implies — see `harnesses.cjs`.
     */
    backends: config.backends || undefined,
    backend: config.backend || undefined,
    /**
     * Room reaping. A room id is any string a client picks — since R1 the tab
     * remembers its own room in localStorage and mints new ones on demand — and
     * each live room owns harness processes, so rooms nobody watches must not
     * live forever. `idleRoomTtlMs: 0` disables it.
     */
    idleRoomTtlMs: config.idleRoomTtlMs,
    maxRooms: config.maxRooms,
    title: 'Agent Room',
    /**
     * Where uploaded files and the theme document live. Passed explicitly (both
     * may be `null` to disable that feature) rather than letting `RoomApi` derive
     * them, because the directories are created here — `apply` is the only place
     * that knows the plugin loaded successfully and has a logger to complain to.
     */
    filesDir,
    themeDir,
    maxUploadBytes: config.maxUploadBytes,
  });

  // The UI bundle and its API share one prefix route; the handler strips the
  // prefix before matching, so `/agent-room/state` and `/state` both work.
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: routePrefix,
    handler: (request, response) => {
      void api.handle(request, response, { prefix: routePrefix, staticFiles }).then((handled) => {
        if (handled) return;
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('agent-room: not found');
      });
    },
  });

  ctx.effect(
    () => () => {
      dispose();
      void api.dispose();
    },
    'agent-room: routes and engine',
  );

  ctx.logger?.info?.(
    `agent-room ready at ${routePrefix} (cwd=${cwd}, rosters=${roomsDir}, ` +
      `files=${filesDir || 'off'}, theme=${themeDir || 'off'}, ` +
      `workspaces=${Object.entries(workspaceDirs)
        .map(([backend, dir]) => `${backend}=${dir}`)
        .join(', ')}, ` +
      // Logged at load so a support question ("why is Qoder missing from the
      // form?") is answerable from the log rather than from a UI screenshot.
      `harnesses=${detectHarnesses()
        .map((row) => `${row.id}:${row.found ? 'yes' : 'no'}`)
        .join(' ')})`,
  );
}

