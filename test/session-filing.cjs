#!/usr/bin/env node
/**
 * Filing a harness's conversations under one workspace.
 *
 * The user asked for one workspace **per harness**, holding every conversation
 * that harness ever had. Each harness spells "workspace" differently, and this
 * test holds down both spellings:
 *
 *   - **codex** groups threads into a *project*, and the only public API that
 *     can assign a thread to a project is `project/import`. It cannot be grown
 *     in place: the same `idempotencyKey` replays a cached answer and attaches
 *     nothing new, a fresh key mints a *second* project with the same name, and
 *     `project/update` takes no thread list at all. So the pool must rotate —
 *     import the complete set under a new key and delete the project it
 *     replaced. Scenario 1–4 pin that down, including the union across rooms
 *     (a room that imported only its own members would rotate away everyone
 *     else's threads).
 *
 *   - **ACP/DSH** files a session into a real `workspaceRegistry` row, which
 *     only exists in the host process. Scenario 5 drives `lib/index.js` with a
 *     fake host and checks the two things that make it work: the row is created
 *     for the harness's own directory, and each session id the engine announces
 *     is attached to it.
 *
 * Zero codex: the app-server is `test/stub-app-server.cjs`, a local script.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { CodexThreadPool } = require(path.join(__dirname, '..', 'lib', 'codex-pool.cjs'));

const STUB = path.join(__dirname, 'stub-app-server.cjs');
const ROOT = path.join(__dirname, '..');
const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

const spawnStub = (binary, args, options) => spawn(process.execPath, [STUB], options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scenario 0 + 1: what the store looks like before and after the first sync.
 *
 * Two pools share one `STUB_STATE_FILE`, because that is the real topology: two
 * rooms are two app-server processes reading codex's single store. It is also
 * the only way to prove the union is read back from the store rather than kept
 * in the pool's own memory.
 */
async function makePool(stateFile, projectName, projectRoot) {
  const previous = process.env.STUB_STATE_FILE;
  process.env.STUB_STATE_FILE = stateFile;
  try {
    const pool = new CodexThreadPool({
      codexPath: process.execPath,
      cwd: ROOT,
      log: () => {},
      projectName,
      projectRoot,
    });
    pool.spawnChild = spawnStub;
    await pool.start();
    return pool;
  } finally {
    if (previous === undefined) delete process.env.STUB_STATE_FILE;
    else process.env.STUB_STATE_FILE = previous;
  }
}

/** A thread that has spoken — the only kind `project/import` accepts. */
async function speak(pool, key, text) {
  const thread = await pool.openThread(key, { model: 'stub-model', cwd: ROOT, sandbox: 'read-only' });
  await pool.runTurn(key, { text });
  return thread.id;
}

async function threadMap(pool) {
  const listed = await pool.request('thread/list', { limit: 500 });
  const out = new Map();
  for (const thread of (listed && listed.data) || []) out.set(thread.id, thread.projectId || null);
  return out;
}

async function projectNames(pool, name) {
  const listed = await pool.request('project/list', { limit: 200 });
  return ((listed && listed.data) || []).filter((project) => project.name === name);
}

async function scenarioCodex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-grouping-'));
  const stateFile = path.join(dir, 'store.json');
  const root = path.join(dir, 'codex-workspace');
  const NAME = 'agent-room';
  const pools = [];
  try {
    // --- a thread that has not spoken cannot be grouped ---------------------
    const first = await makePool(stateFile, NAME, root);
    pools.push(first);
    const silent = await first.openThread('silent', { model: 'stub-model', cwd: root, sandbox: 'read-only' });
    let refused = null;
    try {
      await first.syncProject([silent.id]);
    } catch (error) {
      refused = error;
    }
    check(
      's1 an unspoken thread is refused, as the real store refuses it',
      refused && /thread not found/.test(refused.message),
      refused ? refused.message : '(no error)',
    );

    // --- the first real sync mints the group --------------------------------
    const a1 = await speak(first, 'alpha', 'hello');
    const a2 = await speak(first, 'beta', 'hi');
    const projectId = await first.syncProject([a1, a2]);
    check('s2 the first sync returns a project id', typeof projectId === 'string' && projectId.length > 0, String(projectId));
    let groups = await projectNames(first, NAME);
    check('s3 the group exists and is the only one with that name', groups.length === 1, JSON.stringify(groups.map((p) => p.id)));
    let map = await threadMap(first);
    check('s4 both spoken threads are in the group', map.get(a1) === projectId && map.get(a2) === projectId, JSON.stringify([map.get(a1), map.get(a2)]));
    check('s5 the unspoken thread stayed out of the group', map.get(silent.id) === null, String(map.get(silent.id)));
    check(
      's6 the project names the harness workspace as its root',
      groups[0].roots && groups[0].roots.some((entry) => entry.path === root),
      JSON.stringify(groups[0].roots),
    );

    // --- syncing the same set again must not churn the project --------------
    const again = await first.syncProject([a1, a2]);
    check('s7 a repeat sync adopts the existing group instead of rotating', again === projectId, `${again} vs ${projectId}`);
    groups = await projectNames(first, NAME);
    check('s8 the repeat sync did not mint a duplicate', groups.length === 1, String(groups.length));

    // --- a second room adds its thread WITHOUT losing the first room's -------
    const second = await makePool(stateFile, NAME, root);
    pools.push(second);
    const b1 = await speak(second, 'gamma', 'good evening');
    const rotated = await second.syncProject([b1]);
    check('s9 a rotation mints a new project id', typeof rotated === 'string' && rotated !== projectId, String(rotated));
    map = await threadMap(second);
    check(
      's10 the other room\'s threads survived the rotation (union, not replacement)',
      map.get(a1) === rotated && map.get(a2) === rotated && map.get(b1) === rotated,
      JSON.stringify([map.get(a1), map.get(a2), map.get(b1)]),
    );
    groups = await projectNames(second, NAME);
    check('s11 exactly one group remains after the rotation', groups.length === 1 && groups[0].id === rotated, JSON.stringify(groups.map((p) => p.id)));
    check(
      's12 the replaced project was deleted, not left as a duplicate',
      !groups.some((project) => project.id === projectId),
      JSON.stringify(groups.map((p) => p.id)),
    );

    // --- the second pool agrees, which is what "process-wide" means ---------
    const third = await makePool(stateFile, NAME, root);
    pools.push(third);
    const adopted = await third.syncProject([b1]);
    check('s13 a pool that starts later adopts the existing group', adopted === rotated, `${adopted} vs ${rotated}`);
    groups = await projectNames(third, NAME);
    check('s14 and does not mint a second one', groups.length === 1, String(groups.length));

    // --- grouping stays off unless a name is configured ---------------------
    const off = new CodexThreadPool({ codexPath: process.execPath, cwd: ROOT, log: () => {} });
    off.spawnChild = spawnStub;
    await off.start();
    pools.push(off);
    const ignored = await off.syncProject(['whatever']);
    check('s15 grouping is opt-in: no projectName means no sync', ignored === null, String(ignored));
  } finally {
    for (const pool of pools) await pool.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Scenario 16–19: the DSH half. `lib/index.js` is loaded the way the plugin
 * loader loads it, against a fake host whose only job is to record what the
 * plugin asks of the workspace service.
 */
async function scenarioWorkspaceFiling() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-acp-profile-'));
  const previousProfile = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = profileDir;
  try {
    const created = [];
    const attached = [];
    const acpDir = path.join(profileDir, 'agent-room-workspace', 'acp');
    const fakeWorkspace = {
      attachSession: async (sessionId) => {
        attached.push(sessionId);
      },
    };
    const registry = {
      create: async (dir, title) => {
        created.push({ dir, title });
        return fakeWorkspace;
      },
    };
    const services = new Map([['workspaceRegistry', registry]]);
    const logs = [];
    const ctx = {
      logger: { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) },
      get: (name) => services.get(name) || null,
      webServer: { register: () => () => {} },
      effect: () => () => {},
    };

    const module = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);
    check(
      's16 workspaceRegistry is NOT a hard inject (the room must load without it)',
      JSON.stringify(module.inject) === '["webServer"]',
      JSON.stringify(module.inject),
    );

    module.apply(ctx, { routePrefix: '/agent-room', cwd: ROOT });
    check('s17 the harness workspace dirs were created', fs.existsSync(acpDir), acpDir);

    const file = module.createSessionFiler(ctx, { codex: path.join(profileDir, 'agent-room-workspace', 'codex'), acp: acpDir });
    check('s18 the plugin builds a session filer', typeof file === 'function', typeof file);

    if (typeof file === 'function') {
      await file({ roomId: 'r1', memberId: 'ds', backend: 'acp', sessionId: 'session-one', cwd: acpDir });
      await file({ roomId: 'r1', memberId: 'ds', backend: 'acp', sessionId: 'session-two', cwd: acpDir });
      check('s19 the harness workspace is created once for the directory', created.length === 1, JSON.stringify(created));
      check('s20 it is the ACP directory, titled for the harness', created[0] && created[0].dir === acpDir && /acp/.test(created[0].title), JSON.stringify(created[0]));
      check('s21 every announced session is attached', attached.join(',') === 'session-one,session-two', attached.join(','));
      // codex files itself over its own RPC, so the host must not touch it.
      const before = attached.length;
      await file({ roomId: 'r1', memberId: 'alpha', backend: 'codex', sessionId: 'codex-thread-1', cwd: path.join(profileDir, 'agent-room-workspace', 'codex') });
      check('s22 codex sessions are left to the codex pool', attached.length === before, String(attached.length));

      // A missing service, an unwritable store or a rejected attach must not
      // throw into the room: grouping is a convenience, not a precondition.
      services.delete('workspaceRegistry');
      const bare = module.createSessionFiler(ctx, { codex: 'x', acp: acpDir });
      let threw = null;
      try {
        await bare({ roomId: 'r1', memberId: 'ds', backend: 'acp', sessionId: 'session-three', cwd: acpDir });
      } catch (error) {
        threw = error;
      }
      check('s23 a profile with no workspace service is a no-op, not a failure', threw === null, threw ? threw.message : '');

      services.set('workspaceRegistry', {
        create: async () => ({
          attachSession: async () => {
            throw new Error('cannot attach session: its cwd resolves elsewhere');
          },
        }),
      });
      const strict = module.createSessionFiler(ctx, { codex: 'x', acp: acpDir });
      let propagated = null;
      try {
        await strict({ roomId: 'r1', memberId: 'ds', backend: 'acp', sessionId: 'session-four', cwd: acpDir });
      } catch (error) {
        propagated = error;
      }
      check(
        's24 a rejected attach reaches the caller, which logs it rather than swallowing it',
        propagated && /cwd resolves elsewhere/.test(propagated.message),
        propagated ? propagated.message : '(no error)',
      );
    }
  } finally {
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previousProfile;
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function main() {
  await scenarioCodex();
  await scenarioWorkspaceFiling();
  await sleep(10);
  console.log('codex project  rotated, unioned across rooms, opt-in');
  console.log('acp workspace  row created once, every session attached');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
