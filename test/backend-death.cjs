#!/usr/bin/env node
/**
 * What happens to a room when its backend process dies?
 *
 * This is a real incident, not a hypothetical. The host that ran the room had
 * its `codex app-server` children killed from outside (they are separate OS
 * processes, and anything with process rights can end one). The room kept
 * answering HTTP 200, kept reporting `connected: true`, and kept handing out a
 * pid for a process that no longer existed. Every member's thread id pointed
 * into a dead process, so the next turn would disappear into a closed stdin —
 * silently, forever if nobody looked.
 *
 * Three separate defects had to be fixed together, and each one gets its own
 * scenario here:
 *
 *   1. `pid` kept reporting the corpse, because `stop()`/exit never cleared
 *      `this.child`. Nothing downstream could tell the pool was dead.
 *   2. Pool threads were not dropped on death, so `ensureThread` found a stale
 *      thread, reused it, and the member's cursor was NOT rewound — the member
 *      would then answer from an empty context in a brand-new thread. The fix
 *      is visible as `member.needsReplay === true` plus a turn body carrying the
 *      whole room transcript.
 *   3. A turn already in flight when the child died never settled: no
 *      `turn/completed` was coming, so it hung until the 300 s timeout. The
 *      observable replacement for the old `member.inflight` probe is
 *      `member.running === null` ("this member is not reading a segment").
 *
 * Zero codex: the app-server is `test/stub-app-server.cjs`, a local script.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CodexThreadPool } = require(path.join(__dirname, '..', 'lib', 'codex-pool.cjs'));
const { AgentRoom } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

const STUB = path.join(__dirname, 'stub-app-server.cjs');
const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

/**
 * The pool spawns `binary app-server --listen stdio://`. Substituting the
 * spawner (rather than the binary) keeps `resolveCodexBinary` and the argv
 * shape out of the test's way — the room builds the pool itself, so this is
 * also the only hook available from outside.
 */
const spawnStub = (binary, args, options) => spawn(process.execPath, [STUB], options);

function makeRoom(overrides = {}) {
  const room = new AgentRoom({
    id: 'death-room',
    title: 'Death Room',
    cwd: path.join(__dirname, '..'),
    members: [
      { id: 'alpha', label: 'Alpha', model: 'stub-model', persona: 'calm' },
      { id: 'beta', label: 'Beta', model: 'stub-model', persona: 'skeptical' },
    ],
    prewarm: true,
    replyPolicy: 'mentioned-only',
    maxRelayHops: 0,
    // No ticker: with R3 delivery, a segment is handed over on `say()`/`@` or an
    // explicit `_tick()`, and every scenario here drives delivery through `@`.
    // Disabling both timers keeps the run from racing the 30 s segment clock.
    segmentMs: 0,
    queueStallMs: 0,
    ...overrides,
  });
  for (const pool of room.pools.values()) pool.spawnChild = spawnStub;
  room.on('log', () => {});
  return room;
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until `predicate()` holds, or give up after `timeoutMs`. */
async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

/** Kill a child from outside the pool, exactly as the incident did. */
async function killBackend(room) {
  const pool = room.pools.get(room.primaryBackend);
  const pid = pool.pid;
  check('the backend has a live pid before the kill', alive(pid), String(pid));
  process.kill(pid, 'SIGKILL');
  await waitFor(() => !alive(pid), 3000);
  // Let the pool observe the exit event.
  await waitFor(() => pool.running === false, 3000);
  return { pool, pid };
}

async function scenario1() {
  // The connection state must stop claiming a dead child is healthy.
  const pool = new CodexThreadPool({ codexPath: process.execPath });
  pool.spawnChild = spawnStub;
  await pool.start();
  const pid = pool.pid;
  check('s1 the pool reports a pid once started', !!pid, String(pid));
  check('s1 the pool reports running once started', pool.running === true, String(pool.running));

  process.kill(pid, 'SIGKILL');
  const died = await waitFor(() => pool.running === false, 3000);
  check('s1 the pool notices the child died', died, 'running stayed true');
  check('s1 the pool drops its memoized connection', pool.ready === null, String(pool.ready));
  // The old bug: `pid` kept returning the corpse, so callers could not tell.
  check('s1 a dead pool no longer advertises its pid', pool.pid === null, String(pool.pid));

  // And a request must fail fast instead of writing into a closed pipe.
  let failed = false;
  try {
    await pool.request('model/list', {}, { timeoutMs: 2000 });
  } catch {
    failed = true;
  }
  check('s1 a request on a dead pool fails instead of hanging', failed);
  await pool.stop();
}

async function scenario2() {
  // The room must recover: restart, replay the room, and answer again.
  const room = makeRoom();
  await room.connect();
  check('s2 the room connects', room.snapshot().connected === true);

  await room.say('@alpha first message', { authorId: 'user' });
  const before = room.log.filter((r) => r.kind === 'agent').length;
  check('s2 alpha answered before the kill', before === 1, String(before));

  const { pid } = await killBackend(room);
  check("s2 the room stops claiming it is connected", room.snapshot().connected === false);

  const lost = alive(pid);
  check('s2 the backend process really is gone', !lost, String(pid));

  // Ask again. The room must bring the backend back rather than fail.
  const second = await room.say('@beta are you alive?', { authorId: 'user' });
  check('s2 the room still delivers after a backend death', second.delivered.length > 0, JSON.stringify(second.delivered));
  check('s2 the delivery is attributed to the addressed member', second.delivered.some((d) => d.memberId === 'beta' && !d.error), JSON.stringify(second.delivered).slice(0, 200));
  check('s2 the room restarted its backend', room.snapshot().connected === true, 'still disconnected');
  const pool = room.pools.get(room.primaryBackend);
  check('s2 the restarted backend is a different, live process', pool.pid !== pid && alive(pool.pid), `${pid} -> ${pool.pid}`);

  const beta = room.members.find((m) => m.id === 'beta');
  const reply = room.log.filter((r) => r.authorId === 'beta').pop();
  const text = reply ? reply.text : '';
  // The heart of the fix: the brand-new thread was handed the replayed room
  // transcript instead of answering from an empty context.
  check('s2 the new thread was handed the earlier room history', /first message/.test(text), text.slice(0, 200));
  check('s2 the replay is attributed to the user, not to beta', /\[用户\]/.test(text), text.slice(0, 200));
  // A member is "not reading" when `running` is null. That is what replaced the
  // old `inflight.size === 0` probe: `inflight` no longer exists because a turn
  // is now one segment at a time, so the flag became this single field.
  check('s2 the member is no longer reading a segment', beta.running === null, String(beta.running && beta.running.id));
  check('s2 nothing was left queued behind the recovered turn', beta.segments.length === 0, `queued ${beta.segments.length}`);
  check('s2 the replay was consumed, not pending again', beta.needsReplay === false, String(beta.needsReplay));
  check('s2 the recovered backend is out of the busy set', room.busy.has('beta') === false, JSON.stringify(Array.from(room.busy)));
  await room.dispose();
}

async function scenario3() {
  // A turn already in flight when the child dies must not hang for 300 s.
  const flag = path.join(__dirname, '.stub-die-on-turn');
  fs.writeFileSync(flag, 'die');
  // Set BEFORE the pool spawns: the stub reads this from its own environment,
  // which is captured when the child is created inside `connect()`. Setting it
  // afterwards silently does nothing, and the turn would then succeed.
  process.env.STUB_DIE_ON_TURN = flag;
  const room = makeRoom({
    members: [
      { id: 'alpha', label: 'Alpha', model: 'stub-model' },
      { id: 'beta', label: 'Beta', model: 'stub-model' },
    ],
  });
  try {
    await room.connect();
    const started = Date.now();
    const result = await room.say('@alpha this turn will be interrupted', { authorId: 'user' });
    const elapsed = Date.now() - started;
    const alpha = room.members.find((m) => m.id === 'alpha');
    // The turn must settle promptly with an error, not sit until the timeout.
    check('s3 a turn interrupted by a backend death settles quickly', elapsed < 30000, elapsed + 'ms');
    check('s3 the member reports the failure', !!alpha.error, String(alpha.error));
    check('s3 the failure explains itself', /exited/i.test(alpha.error || ''), String(alpha.error));
    check('s3 the room is not stuck busy', alpha.status !== 'thinking', String(alpha.status));
    check('s3 no phantom reply was posted', result.delivered.every((d) => !d.record), JSON.stringify(result.delivered).slice(0, 120));
  } finally {
    delete process.env.STUB_DIE_ON_TURN;
    try {
      fs.unlinkSync(flag);
    } catch {}
  }
  await room.dispose();
}

async function scenario4() {
  // Recovery must repeat: a backend that dies twice is still recoverable, and
  // the room must not accumulate dead pools or leak processes.
  const room = makeRoom();
  await room.connect();
  const firstPid = room.pools.get(room.primaryBackend).pid;

  await room.say('@alpha round one', { authorId: 'user' });
  await killBackend(room);
  await room.say('@alpha round two', { authorId: 'user' });
  const secondPid = room.pools.get(room.primaryBackend).pid;
  check('s4 the first restart produced a new process', secondPid && secondPid !== firstPid, `${firstPid} -> ${secondPid}`);

  await killBackend(room);
  await room.say('@alpha round three', { authorId: 'user' });
  const thirdPid = room.pools.get(room.primaryBackend).pid;
  check('s4 the second restart produced another new process', thirdPid && thirdPid !== secondPid, `${secondPid} -> ${thirdPid}`);
  check('s4 only one pool exists per backend', room.pools.size === 1, String(room.pools.size));
  check('s4 the room is healthy again', room.snapshot().connected === true);

  const texts = room.log.filter((r) => r.authorId === 'alpha').map((r) => r.text);
  check('s4 alpha spoke after every restart', texts.length === 3, JSON.stringify(texts.map((t) => t.slice(0, 24))));

  // Disposal must actually end the process; `pool.pid` alone is not proof
  // (it keeps pointing at the child after an exit), so probe the OS.
  const live = [firstPid, secondPid, thirdPid].filter(alive);
  check('s4 earlier processes were already gone', live.length <= 1, JSON.stringify(live));
  await room.dispose();
  await waitFor(() => !alive(thirdPid), 3000);
  check('s4 dispose ends the surviving backend process', !alive(thirdPid), String(thirdPid));
}

async function scenario5() {
  // A write that races the child's death fails with EPIPE *asynchronously*, as
  // an `'error'` event on the stdin stream — the `try` inside `write()` never
  // sees it (it already returned `true`). An `'error'` event with no listener is
  // fatal to the entire Node process, so the failure mode is not "the turn
  // fails", it is "the host dies". This scenario was intermittent before the
  // fix: `run-all.cjs` occasionally recorded `backend-death.cjs exit 1` while
  // the test still printed `problems: none`, because the crash happened after
  // the last check.
  const pool = new CodexThreadPool({ codexPath: process.execPath, log: () => {} });
  pool.spawnChild = spawnStub;
  await pool.start();
  const child = pool.child;
  process.kill(pool.pid, 'SIGKILL');
  const died = await waitFor(() => pool.running === false, 3000);
  check('s5 the backend is dead before the doomed write', died, String(pool.running));

  // The invariant in one line: the stream that can emit the fatal event has
  // somebody listening for it.
  check('s5 the child stdin has an error listener', child.stdin.listenerCount('error') > 0, String(child.stdin.listenerCount('error')));

  // Bypass `pool.write` on purpose — it refuses once `running` is false, while
  // the frame that actually killed the host was one that raced the death.
  let threw = null;
  try {
    child.stdin.write('{"jsonrpc":"2.0","id":9999999,"method":"model/list"}\n');
  } catch (error) {
    threw = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  check('s5 the doomed write did not throw synchronously', threw === null, threw ? threw.message : '');
  // Reaching this line at all is the assertion: without the listener the process
  // is already gone. The check makes that explicit in the output.
  check('s5 the process survived the asynchronous write failure', true);
  await pool.stop();
}

async function main() {
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();

  console.log('scenario1 detect  a dead child stops reporting as a live connection');
  console.log('scenario2 recover the room restarts and replays the whole history');
  console.log('scenario3 inflight a turn cut off by the death settles instead of hanging');
  console.log('scenario4 repeat  recovery works twice and leaks no process');
  console.log('scenario5 epipe   a write into a corpse does not kill the host process');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
