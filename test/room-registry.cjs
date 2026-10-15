#!/usr/bin/env node
/**
 * The room registry: create a room, switch to it, delete it (files and all).
 *
 * R1 replaces "one room per DSH session, cleared in place with
 * `/new-conversation`" with "many named rooms you can create, switch between and
 * delete". That turns three things into contract:
 *
 *   - a new room id must NOT be derived from anything the caller owns, or a DSH
 *     session id quietly becomes a room id again and every session spawns its
 *     own set of harnesses (the leak this whole feature exists to fix);
 *   - `/close-room` (recycle, keep the history) and `/delete-room` (destroy,
 *     remove the history) must stay different operations, because the reaper
 *     uses the first one every 30 minutes and a reaper that deleted history
 *     would be data loss rather than cleanup;
 *   - `/new-conversation` must be gone as an HTTP route, and must say so rather
 *     than 404, so an older client learns the replacement.
 *
 * Zero quota: the engine is a stub and no harness is spawned. `http` and
 * `fetch` are real, so the routes, the status codes and the JSON shapes are
 * exercised as a browser would exercise them.
 *
 * Run:  node test/room-registry.cjs
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoomApi } = require(path.join(__dirname, '..', 'lib', 'server.cjs'));

/**
 * A room stand-in.
 *
 * Carries the fields `/rooms` reports (`title`, `members`, `logFile`) and
 * records `connect`/`dispose` so the test can tell a room that was built from
 * one that was merely remembered.
 */
function stubRoom(config, log) {
  const state = {
    id: config.id,
    title: config.title,
    members: [],
    logFile: config.logFile === undefined ? null : config.logFile,
    busy: [],
    connects: 0,
    disposed: false,
  };
  return {
    id: config.id,
    get state() {
      return state;
    },
    get title() {
      return state.title;
    },
    get logFile() {
      return state.logFile;
    },
    get members() {
      return state.members;
    },
    get availableModels() {
      return [];
    },
    snapshot() {
      return {
        roomId: state.id,
        title: state.title,
        busy: state.busy.slice(),
        members: state.members,
        log: [],
      };
    },
    backends() {
      return ['codex'];
    },
    modelsByBackend() {
      return [];
    },
    toConfig(member) {
      return member;
    },
    async connect() {
      state.connects += 1;
      log.push(['connect', state.id]);
    },
    async dispose() {
      state.disposed = true;
      log.push(['dispose', state.id]);
    },
  };
}

function makeApi(options, log, roomsDir) {
  return new RoomApi({
    cwd: process.cwd(),
    title: 'stub',
    roomsDir,
    createRoom: (config) => stubRoom(config, log),
    ...options,
  });
}

async function main() {
  const problems = [];
  const check = (label, ok, detail) => {
    if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-registry-'));
  const log = [];
  // `sweepIntervalMs: 0` keeps a real interval out of the test; the reaper is
  // not what this file is about.
  const api = makeApi({ idleRoomTtlMs: 0, sweepIntervalMs: 0 }, log, tmp);
  const server = http.createServer(async (request, response) => {
    const handled = await api.handle(request, response, {});
    if (!handled) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, route, body, raw) => {
    const response = await fetch(base + route, {
      method,
      headers: body || raw ? { 'content-type': 'application/json' } : undefined,
      body: raw ? raw : body ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    return { status: response.status, payload };
  };

  const connectsFor = (id) => log.filter((entry) => entry[0] === 'connect' && entry[1] === id).length;
  const fileFor = (id, suffix) => path.join(tmp, `${id}.${suffix}`);

  try {
    // 1. `POST /new-room` invents an id that is nobody's DSH session id, creates
    //    the room and connects it.
    const created = await call('POST', '/new-room', {});
    const newId = created.payload && created.payload.room;
    check('POST /new-room succeeds', created.status === 200 && created.payload.ok === true, JSON.stringify(created.payload));
    check('POST /new-room returned an id', typeof newId === 'string' && newId.length > 0, String(newId));
    check(
      'the generated id is a room id, not a caller-owned id',
      /^room-[0-9a-z]+-[0-9a-z]{4}$/.test(String(newId)),
      String(newId),
    );
    check('a generated id is never "default"', newId !== 'default', String(newId));
    check('the room is live', api.rooms.has(newId), `rooms=${Array.from(api.rooms.keys()).join(',')}`);
    check('the room was connected', connectsFor(newId) === 1, `connects=${connectsFor(newId)}`);
    check('the new room is reported as new', created.payload.existed === false, JSON.stringify(created.payload));

    // Two calls in a row must not collide: the id has a random half precisely
    // because two clients can click "new room" in the same millisecond.
    const second = await call('POST', '/new-room', {});
    check('a second /new-room mints a different id', second.payload.room !== newId, `${newId} vs ${second.payload.room}`);
    check('both new rooms are live', api.rooms.size === 2, `size=${api.rooms.size}`);

    // 2. Re-creating an id that is already live is reported, not repeated:
    //    a double click must not start a second harness behind one room.
    const again = await call('POST', '/new-room', { room: newId });
    check('an existing id reports existed:true', again.status === 200 && again.payload.existed === true, JSON.stringify(again.payload));
    check('an existing id keeps the same id', again.payload.room === newId, String(again.payload.room));
    check('an existing room is NOT re-connected', connectsFor(newId) === 1, `connects=${connectsFor(newId)}`);
    check('re-creating did not duplicate the room', api.rooms.size === 2, `size=${api.rooms.size}`);

    // An explicit title is honoured and shows up on the switcher.
    const titled = await call('POST', '/new-room', { title: '设计评审' });
    check('/new-room accepts an explicit title', titled.payload.title === '设计评审', JSON.stringify(titled.payload));

    // 3. `GET /rooms` carries what the switcher needs, keeping the keys the
    //    reaper test already depends on (`rooms` must stay an array of ids).
    const rooms = await call('GET', '/rooms');
    check('GET /rooms still returns the flat id list', Array.isArray(rooms.payload.rooms), JSON.stringify(rooms.payload.rooms));
    check('GET /rooms still returns the ttl', rooms.payload.idleRoomTtlMs === 0, String(rooms.payload.idleRoomTtlMs));
    check('GET /rooms still returns the cap', rooms.payload.maxRooms === 16, String(rooms.payload.maxRooms));
    check('GET /rooms still returns the count', rooms.payload.roomCount === api.rooms.size, String(rooms.payload.roomCount));
    check('GET /rooms adds a details list', Array.isArray(rooms.payload.details), JSON.stringify(rooms.payload.details));
    check('details covers every room', rooms.payload.details.length === api.rooms.size, `${rooms.payload.details.length} vs ${api.rooms.size}`);
    const roomRow = rooms.payload.details.find((row) => row.room === newId);
    check('each room reports its id', !!roomRow, JSON.stringify(rooms.payload.details));
    check('each room reports a title', !!roomRow && typeof roomRow.title === 'string' && roomRow.title.length > 0, JSON.stringify(roomRow));
    check('each room reports a member count', !!roomRow && roomRow.members === 0, JSON.stringify(roomRow));
    check(
      'each room reports its log file path',
      !!roomRow && typeof roomRow.logFile === 'string' && roomRow.logFile.endsWith(`${newId}.log.jsonl`),
      JSON.stringify(roomRow),
    );
    check(
      'the log file lives in the rooms dir',
      !!roomRow && path.dirname(roomRow.logFile) === tmp,
      roomRow && roomRow.logFile,
    );

    // 4. `/close-room` recycles: processes stop, files stay. This is the half
    //    the 30-minute reaper uses, so it must never be lossy.
    const recycleId = newId;
    fs.writeFileSync(fileFor(recycleId, 'log.jsonl'), '{"text":"kept"}\n', 'utf8');
    fs.writeFileSync(fileFor(recycleId, 'members.json'), '[]', 'utf8');
    const closed = await call('POST', '/close-room', { room: recycleId });
    check('POST /close-room succeeds', closed.status === 200 && closed.payload.closed === true, JSON.stringify(closed.payload));
    check('the recycled room left memory', !api.rooms.has(recycleId), `rooms=${Array.from(api.rooms.keys()).join(',')}`);
    check(
      'the recycled room was disposed',
      log.some((entry) => entry[0] === 'dispose' && entry[1] === recycleId),
      JSON.stringify(log),
    );
    check('recycling KEEPS the log file', fs.existsSync(fileFor(recycleId, 'log.jsonl')));
    check('recycling KEEPS the member file', fs.existsSync(fileFor(recycleId, 'members.json')));

    // 5. `/delete-room` destroys: processes gone, memory gone, both files gone,
    //    and the caller is told which files it removed.
    const doomed = (await call('POST', '/new-room', {})).payload.room;
    fs.writeFileSync(fileFor(doomed, 'log.jsonl'), '{"text":"gone"}\n', 'utf8');
    fs.writeFileSync(fileFor(doomed, 'members.json'), '[{"id":"a"}]', 'utf8');
    const deleted = await call('POST', '/delete-room', { room: doomed });
    check('POST /delete-room succeeds', deleted.status === 200 && deleted.payload.ok === true, JSON.stringify(deleted.payload));
    check('deleting reports the destroy', deleted.payload.deleted === true, JSON.stringify(deleted.payload));
    check('deleting names the room', deleted.payload.room === doomed, JSON.stringify(deleted.payload));
    check('the deleted room left memory', !api.rooms.has(doomed), `rooms=${Array.from(api.rooms.keys()).join(',')}`);
    check(
      'the deleted room was disposed',
      log.some((entry) => entry[0] === 'dispose' && entry[1] === doomed),
      JSON.stringify(log),
    );
    check('the log file was removed', !fs.existsSync(fileFor(doomed, 'log.jsonl')));
    check('the member file was removed', !fs.existsSync(fileFor(doomed, 'members.json')));
    check(
      'the removed files are listed back',
      Array.isArray(deleted.payload.files) && deleted.payload.files.length === 2 &&
        deleted.payload.files.includes(`${doomed}.log.jsonl`) && deleted.payload.files.includes(`${doomed}.members.json`),
      JSON.stringify(deleted.payload.files),
    );

    // A room that is not there is a no-op, not an error: the caller may be
    // racing the reaper, and the files may already be gone.
    const ghostRoom = 'room-ghost-0000';
    const ghost = await call('POST', '/delete-room', { room: ghostRoom });
    check('deleting an unknown room is a clean no-op', ghost.status === 200 && ghost.payload.deleted === false, JSON.stringify(ghost.payload));
    check('an unknown room still answers ok', ghost.payload.ok === true, JSON.stringify(ghost.payload));
    check('an unknown room still reports a file list', Array.isArray(ghost.payload.files), JSON.stringify(ghost.payload.files));
    check('an unknown room removed nothing', ghost.payload.files.length === 0, JSON.stringify(ghost.payload.files));

    // A room that never wrote a log must still delete cleanly (ENOENT is not an
    // error — the room simply never appended anything).
    const quiet = (await call('POST', '/new-room', {})).payload.room;
    const quietDelete = await call('POST', '/delete-room', { room: quiet });
    check('deleting a room with no files still succeeds', quietDelete.status === 200 && quietDelete.payload.deleted === true, JSON.stringify(quietDelete.payload));
    check('deleting a room with no files removes nothing', quietDelete.payload.files.length === 0, JSON.stringify(quietDelete.payload.files));

    // `force` must get past a live SSE-style subscriber: a user who cannot
    // delete a room is stuck with it.
    const busyRoom = (await call('POST', '/new-room', {})).payload.room;
    api.roomMeta.get(busyRoom).subscribers = 1;
    const refused = await call('POST', '/delete-room', { room: busyRoom });
    check('a streamed room refuses a plain delete', refused.payload.deleted === false, JSON.stringify(refused.payload));
    check('the refused room is still live', api.rooms.has(busyRoom));
    const forced = await call('POST', '/delete-room', { room: busyRoom, force: true });
    check('force deletes a streamed room', forced.payload.deleted === true, JSON.stringify(forced.payload));
    check('the forced delete removed the room', !api.rooms.has(busyRoom));

    // 6. `/new-conversation` is retired. 410 (not 404) so a client is told what
    //    replaced it, and the removal must not have taken the engine with it.
    const retired = await call('POST', '/new-conversation', { room: 'default' });
    check('POST /new-conversation answers 410', retired.status === 410, String(retired.status));
    check('the 410 is not a success payload', retired.payload.ok === false, JSON.stringify(retired.payload));
    check(
      'the 410 explains the replacement',
      /new-conversation has been removed/.test(retired.payload.error || '') &&
        /delete the room and create a new one/.test(retired.payload.error || ''),
      JSON.stringify(retired.payload),
    );
    check('the retired route created no room', !api.rooms.has('default'), `rooms=${Array.from(api.rooms.keys()).join(',')}`);

    // 7. A malformed body is a clean 500 with a message, and the server lives.
    const bad = await call('POST', '/delete-room', null, '{ not json');
    check('a malformed body is a clean 500', bad.status === 500, String(bad.status));
    check('a malformed body explains itself', bad.payload && /invalid JSON/.test(bad.payload.error || ''), JSON.stringify(bad.payload));
    const badNew = await call('POST', '/new-room', null, '{ nope');
    check('a malformed /new-room body is a clean 500', badNew.status === 500, String(badNew.status));
    const alive = await call('GET', '/rooms');
    check('the server survived the malformed requests', alive.status === 200, String(alive.status));
    const survivorIds = alive.payload.rooms || [];
    check(
      'a rejected body created no room',
      !survivorIds.some((id) => id === 'undefined' || id === 'null'),
      JSON.stringify(survivorIds),
    );

    // A room id that is not a string must not create a room called "undefined".
    const weird = await call('POST', '/new-room', { room: 42 });
    check('a non-string room id is ignored', !!weird.payload.room && weird.payload.room !== 'undefined', JSON.stringify(weird.payload));
    check('a non-string room id still mints a room id', /^room-/.test(String(weird.payload.room)), String(weird.payload.room));
  } finally {
    await api.dispose();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('new-room       mints a non-session id, connects once, existing id reported');
  console.log('rooms          id list kept, details carry title/members/logFile');
  console.log('close-room     recycles the process and KEEPS the files');
  console.log('delete-room    removes process, memory and both files, lists them back');
  console.log('delete edges   unknown room is a clean no-op, ENOENT tolerated, force wins');
  console.log('new-conversation retired: 410 naming the replacement');
  console.log('malformed      clean 500 with a message, server survives');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
