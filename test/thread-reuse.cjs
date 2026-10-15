#!/usr/bin/env node
/**
 * A warm thread must STAY warm across turns.
 *
 * Bug this pins down (found live, not here): `thread/start` takes a `SandboxMode`
 * string but echoes a `SandboxPolicy` OBJECT. The pool recorded that object
 * verbatim, while `room.cjs#ensureThread` compares `record.sandbox` against the
 * mode string it is about to ask for. Object never equals string, so the reuse
 * test failed on EVERY turn and the room silently rebuilt the member's thread —
 * one fresh codex rollout per message, a cold start each time, and a member that
 * could never remember what the room had said.
 *
 * Evidence at the time: one rollout file per turn —
 *   23:21:36 01a13b01 (turn 1)  23:22:50 01a13b02 (turn 2)
 *
 * Why no existing test caught it: `test/stub-app-server.cjs` echoed
 * `sandbox: 'read-only'` — the string, not the object the real server sends — so
 * the stub agreed with the client's bug. The stub now mirrors the real shape;
 * these assertions lock both halves down.
 *
 * Zero codex: the app-server is the local stub script.
 */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { CodexThreadPool, sandboxModeOf } = require(path.join(__dirname, '..', 'lib', 'codex-pool.cjs'));
const { AgentRoom } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

const STUB = path.join(__dirname, 'stub-app-server.cjs');
const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

const spawnStub = (binary, args, options) => spawn(process.execPath, [STUB], options);

function makeRoom(overrides = {}) {
  const room = new AgentRoom({
    id: 'reuse-room',
    title: 'Reuse Room',
    cwd: path.join(__dirname, '..'),
    members: [
      { id: 'alpha', label: 'Alpha', model: 'stub-model', persona: 'calm' },
      { id: 'beta', label: 'Beta', model: 'stub-model', persona: 'skeptical' },
    ],
    prewarm: true,
    replyPolicy: 'mentioned-only',
    maxRelayHops: 0,
    ...overrides,
  });
  for (const pool of room.pools.values()) pool.spawnChild = spawnStub;
  room.on('log', () => {});
  return room;
}

const agentText = (room, id) => {
  const entry = room.log.filter((r) => r.authorId === id).pop();
  return entry ? entry.text : '';
};

/**
 * `threadId` is a projection: the raw member object holds no such field, only
 * `threadGen`. Read it from the snapshot, which is what an operator sees.
 */
const threadOf = (room, id) => {
  const projected = room.snapshot().members.find((m) => m.id === id);
  return projected ? projected.threadId : null;
};

/**
 * Count how many threads the room opened. A reuse regression shows up here as
 * one `openThread` per turn instead of one per member.
 */
function countOpens(room) {
  const counter = { opens: 0 };
  for (const pool of room.pools.values()) {
    const original = pool.openThread.bind(pool);
    pool.openThread = (key, options) => {
      counter.opens += 1;
      return original(key, options);
    };
  }
  return counter;
}

/** The echo of the `SandboxPolicy` object the real server returns. */
function scenario1() {
  check('s1 readOnly object normalizes to a mode string', sandboxModeOf({ type: 'readOnly', networkAccess: false }, 'x') === 'read-only');
  check('s1 dangerFullAccess object normalizes', sandboxModeOf({ type: 'dangerFullAccess' }, 'x') === 'danger-full-access');
  check('s1 workspaceWrite object normalizes', sandboxModeOf({ type: 'workspaceWrite', writableRoots: [] }, 'x') === 'workspace-write');
  check('s1 a mode string passes through untouched', sandboxModeOf('read-only', 'x') === 'read-only');
  check('s1 an unknown policy shape falls back to what was asked', sandboxModeOf({ type: 'somethingNew' }, 'workspace-write') === 'workspace-write');
  check('s1 null falls back to what was asked', sandboxModeOf(null, 'read-only') === 'read-only');
  check('s1 a bare object never leaks through', sandboxModeOf({ type: 'readOnly' }, 'x') !== '[object Object]');
}

/** The pool record's `sandbox` must be the caller's mode string. */
async function scenario2() {
  const pool = new CodexThreadPool({ codexPath: process.execPath, cwd: path.join(__dirname, '..') });
  pool.spawnChild = spawnStub;
  await pool.start();
  const chat = await pool.openThread('chat-key', { model: 'stub-model', cwd: path.join(__dirname, '..'), sandbox: 'read-only' });
  check('s2 a codex thread records a mode STRING, not the echoed policy object', typeof chat.sandbox === 'string', JSON.stringify(chat.sandbox));
  check('s2 the chat thread records read-only', chat.sandbox === 'read-only', String(chat.sandbox));
  const work = await pool.openThread('work-key', { model: 'stub-model', cwd: path.join(__dirname, '..'), sandbox: 'danger-full-access' });
  check('s2 a work thread records danger-full-access', work.sandbox === 'danger-full-access', String(work.sandbox));
  await pool.stop();
}

/** The room must reuse the member's thread across consecutive turns. */
async function scenario3() {
  const room = makeRoom();
  const counter = countOpens(room);
  await room.connect();
  const afterPrewarm = counter.opens;
  check('s3 prewarm opens exactly one thread per member', afterPrewarm === room.members.length, `${afterPrewarm} opens for ${room.members.length} members`);

  await room.say('@alpha one', { authorId: 'user' });
  const firstThread = threadOf(room, 'alpha');
  check('s3 alpha has a thread after its first turn', !!firstThread, String(firstThread));

  await room.say('@alpha two', { authorId: 'user' });
  const secondThread = threadOf(room, 'alpha');
  // The live defect: this changed on every turn.
  check('s3 the second turn REUSED the same thread', secondThread === firstThread, `${firstThread} -> ${secondThread}`);
  check('s3 no extra thread was opened for the second turn', counter.opens === afterPrewarm, `${afterPrewarm} -> ${counter.opens}`);

  // A rebuilt thread has empty history and its cursor is rewound, so the turn
  // body carries the whole room transcript. A reused thread must not re-brief.
  const text = agentText(room, 'alpha');
  check('s3 the reused thread was not re-briefed with the room history', !/\[用户\] @alpha one/.test(text), text.slice(0, 200));
  await room.dispose();
}

/** A genuine mode switch must still rebuild — the fix is not "always reuse". */
async function scenario4() {
  const room = makeRoom();
  await room.connect();
  await room.say('@alpha one', { authorId: 'user' });
  const chatThread = threadOf(room, 'alpha');

  room.setMode('work');
  await room.say('@alpha two', { authorId: 'user' });
  const workThread = threadOf(room, 'alpha');
  // WORK is danger-full-access and sandbox is a thread-level codex parameter, so
  // the thread must be replaced — and the replacement carries the full replay.
  check('s4 switching to WORK rebuilds the thread', workThread !== chatThread, `${chatThread} -> ${workThread}`);
  check('s4 the rebuilt WORK thread was re-briefed', /\[用户\] @alpha one/.test(agentText(room, 'alpha')), agentText(room, 'alpha').slice(0, 200));

  room.setMode('chat');
  await room.say('@alpha three', { authorId: 'user' });
  const backThread = threadOf(room, 'alpha');
  check('s4 switching back to CHAT rebuilds again', backThread !== workThread, `${workThread} -> ${backThread}`);

  // And once back in a stable mode, reuse resumes.
  await room.say('@alpha four', { authorId: 'user' });
  const stableThread = threadOf(room, 'alpha');
  check('s4 once the mode settles, threads are reused again', stableThread === backThread, `${backThread} -> ${stableThread}`);
  await room.dispose();
}

async function main() {
  scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  console.log('scenario1 unit   the echoed SandboxPolicy object normalizes to a mode string');
  console.log('scenario2 pool   a thread record stores the mode string, not the echoed object');
  console.log('scenario3 room   consecutive turns reuse one warm thread, with no re-briefing');
  console.log('scenario4 modes  a real CHAT/WORK switch still rebuilds, then reuse resumes');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
