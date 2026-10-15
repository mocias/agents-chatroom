#!/usr/bin/env node
/**
 * Room lifecycle: rooms must be reapable.
 *
 * A room owns live harness processes, and a room id is any string a client
 * picks — a typo, a one-off probe, a fresh DSH session id per tab. Before this
 * test existed, every distinct id ever asked for kept its `codex.exe` until DSH
 * restarted; ten stray processes were counted in the task manager, all from ids
 * like `leadprobe` that nobody would ever open again.
 *
 * Zero quota: the engine is a stub and no harness is spawned. `now` is injected
 * everywhere a real clock would otherwise force the test to wait half an hour.
 *
 * Run:  node test/room-lifecycle.cjs
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoomApi } = require(path.join(__dirname, '..', 'lib', 'server.cjs'));

/**
 * A room stand-in that records its own disposal.
 *
 * `busy` is the field the reaper reads to decide whether stopping the room would
 * pull the rug out from under a running turn, so the stub must be able to fake it.
 */
function stubRoom(config, log) {
  const state = { id: config.id, busy: [], disposed: false };
  return {
    id: config.id,
    get state() {
      return state;
    },
    get members() {
      return [];
    },
    get availableModels() {
      return [];
    },
    snapshot() {
      return { roomId: state.id, busy: state.busy, members: [], log: [] };
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
      log.push(['connect', state.id]);
    },
    async dispose() {
      state.disposed = true;
      log.push(['dispose', state.id]);
    },
  };
}

function makeApi(options, log) {
  return new RoomApi({
    cwd: process.cwd(),
    title: 'stub',
    createRoom: (config) => stubRoom(config, log),
    ...options,
  });
}

async function main() {
  const problems = [];
  const check = (label, ok, detail) => {
    if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
  };
  const log = [];

  const TTL = 60 * 1000;

  // 1. Distinct ids are distinct rooms; a repeat id is not a second room.
  {
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0 }, log);
    const a = await api.ensure('alpha');
    const again = await api.ensure('alpha');
    const b = await api.ensure('beta');
    check('distinct ids -> distinct rooms', api.rooms.size === 2, `size=${api.rooms.size}`);
    check('same id -> same room object', a === again);
    check('different ids -> different rooms', a !== b);
    await api.dispose();
  }

  // 2. The reaper actually reaps, and disposes what it reaps.
  {
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0 }, log);
    await api.ensure('probe-one');
    await api.ensure('probe-two');
    await api.ensure('probe-three');
    check('three rooms live before sweep', api.rooms.size === 3, `size=${api.rooms.size}`);
    const reaped = await api.sweepIdle(Date.now() + TTL + 1);
    check('sweep reaps every stale room', reaped.length === 3, `reaped=${reaped.join(',')}`);
    check('reaped rooms are gone', api.rooms.size === 0, `size=${api.rooms.size}`);
    check('reaped rooms are disposed', api.roomMeta.size === 0, `meta=${api.roomMeta.size}`);
    check(
      'the engine was told to stop',
      ['probe-one', 'probe-two', 'probe-three'].every((id) => log.some((e) => e[0] === 'dispose' && e[1] === id)),
      JSON.stringify(log.filter((e) => e[0] === 'dispose')),
    );
    await api.dispose();
  }

  // 3. A room touched since the last sweep is NOT reaped. This is the whole
  //    point: the open tab polls /state and holds an SSE stream, so a room in
  //    use must survive every sweep.
  {
    const log2 = [];
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0 }, log2);
    await api.ensure('warm');
    await api.ensure('cold');
    const now = Date.now() + TTL + 1;
    // `warm` was just used; `cold` is stale. Only one sweep may pass, so push
    // `warm`'s lastUsed to the same instant the sweep runs from.
    api.roomMeta.get('warm').lastUsed = now;
    api.roomMeta.get('cold').lastUsed = now - TTL - 1;
    const reaped = await api.sweepIdle(now);
    check('only the stale room is reaped', reaped.length === 1 && reaped[0] === 'cold', `reaped=${reaped.join(',')}`);
    check('the warm room survives', api.rooms.has('warm'));
    check('the warm room was not disposed', log2.every((e) => !(e[0] === 'dispose' && e[1] === 'warm')));
    await api.dispose();
  }

  // 4. Touching on read keeps a room alive across a sweep boundary. This is what
  //    a browser does every second, and what makes TTL safe rather than lossy.
  {
    const log3 = [];
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0 }, log3);
    await api.ensure('watched');
    // Backdate it so "was this touched?" does not hinge on clock resolution.
    const base = Date.now() - 5000;
    api.roomMeta.get('watched').lastUsed = base;
    // A sweep at base+TTL/2 must not reap it...
    const first = await api.sweepIdle(base + TTL / 2);
    check('a room inside its TTL is not reaped', first.length === 0, `reaped=${first.join(',')}`);
    // ...and the sweep itself must not be what keeps it alive: only a read does.
    check('the sweep itself does not touch', api.roomMeta.get('watched').lastUsed === base);
    // A read (what the UI does on every poll) re-touches to "now".
    await api.ensure('watched');
    const touched = api.roomMeta.get('watched').lastUsed;
    check('reading re-touches lastUsed', touched > base, `touched=${touched} base=${base}`);
    // The next sweep measures from the touch, not from room creation.
    const second = await api.sweepIdle(touched + TTL - 1);
    check('a re-touched room still survives', second.length === 0 && api.rooms.has('watched'));
    const third = await api.sweepIdle(touched + TTL + 1);
    check('and it expires from the touch when polling stops', third.includes('watched'), `reaped=${third.join(',')}`);
    await api.dispose();
  }

  // 5. Safety: never stop a room mid-turn, and never stop one somebody is
  //    streaming. `force` is the explicit escape hatch.
  {
    const log4 = [];
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0 }, log4);
    const room = await api.ensure('talking');
    room.state.busy = ['codex'];
    const refused = await api.closeRoom('talking');
    check('a busy room is not closed', refused === false);
    check('the busy room is still there', api.rooms.has('talking'));
    room.state.busy = [];
    api.roomMeta.get('talking').subscribers = 1;
    const refused2 = await api.closeRoom('talking');
    check('a room with an open stream is not closed', refused2 === false);
    check('the streamed room is still there', api.rooms.has('talking'));
    const forced = await api.closeRoom('talking', { force: true });
    check('force closes it anyway', forced === true && !api.rooms.has('talking'));
    check('force disposed the engine', log4.some((e) => e[0] === 'dispose' && e[1] === 'talking'));
    check('closing a room that does not exist is a no-op', (await api.closeRoom('ghost')) === false);
    await api.dispose();
  }

  // 6. The sweeper skips busy rooms rather than stopping them, and gets them on a
  //    later tick once the turn ends.
  {
    const log5 = [];
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0 }, log5);
    const room = await api.ensure('slow-turn');
    api.roomMeta.get('slow-turn').lastUsed = Date.now() - TTL - 1;
    room.state.busy = ['codex'];
    const first = await api.sweepIdle();
    check('a stale but busy room survives the sweep', first.length === 0 && api.rooms.has('slow-turn'));
    room.state.busy = [];
    const second = await api.sweepIdle();
    check('it is reaped once the turn ends', second.length === 1 && second[0] === 'slow-turn', `reaped=${second.join(',')}`);
    await api.dispose();
  }

  // 7. Soft cap: at capacity an already-stale room is reclaimed to make space.
  {
    const log6 = [];
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0, maxRooms: 2 }, log6);
    await api.ensure('one');
    await api.ensure('two');
    api.roomMeta.get('one').lastUsed = Date.now() - TTL - 1;
    await api.ensure('three');
    check('a stale room is reclaimed at capacity', !api.rooms.has('one'), `rooms=${Array.from(api.rooms.keys()).join(',')}`);
    check('the new room exists', api.rooms.has('three'));
    check('the in-use room was left alone', api.rooms.has('two'));
    check('the reclaimed room was disposed', log6.some((e) => e[0] === 'dispose' && e[1] === 'one'));
    await api.dispose();
  }

  // 8. Soft cap must NOT evict a room that is in use. Exceeding the cap is the
  //    honest outcome: an in-use room is not a leak, and yanking it mid-session
  //    would cost the user their log and their threads.
  {
    const log7 = [];
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0, maxRooms: 2 }, log7);
    await api.ensure('busy-one');
    const second = await api.ensure('busy-two');
    second.state.busy = ['codex'];
    await api.ensure('busy-three');
    check('cap does not evict a busy room', api.rooms.has('busy-two'));
    check('cap does not evict a freshly used room', api.rooms.has('busy-one'));
    check('creating past the cap is allowed', api.rooms.size === 3, `size=${api.rooms.size}`);
    await api.dispose();
  }

  // 9. TTL can be disabled outright, for an embedding that prefers holding rooms
  //    to paying cold starts. That must also switch off the cap: the cap is only
  //    a second way of reaping, so "never reap" has to mean never reap.
  {
    const log8 = [];
    const api = makeApi({ idleRoomTtlMs: 0, sweepIntervalMs: 0, maxRooms: 1 }, log8);
    await api.ensure('forever');
    await api.ensure('also-forever');
    api.roomMeta.get('forever').lastUsed = 0;
    const reaped = await api.sweepIdle(Date.now() + 10 * TTL);
    check('ttl=0 disables reaping', reaped.length === 0 && api.rooms.has('forever'));
    check('ttl=0 starts no sweeper', api.sweepTimer === null);
    check('ttl=0 also disables the cap', api.rooms.size === 2, `size=${api.rooms.size}`);
    check('ttl=0 disposes nothing', log8.every((e) => e[0] !== 'dispose'));
    await api.dispose();
  }

  // 10. dispose() tears everything down and stops the timer, so a plugin unload
  //     leaks neither processes nor a live interval.
  {
    const log9 = [];
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 60000 }, log9);
    await api.ensure('a');
    await api.ensure('b');
    check('a sweeper is running by default', api.sweepTimer !== null);
    await api.dispose();
    check('dispose stops the sweeper', api.sweepTimer === null);
    check('dispose clears the rooms', api.rooms.size === 0);
    check('dispose clears the bookkeeping', api.roomMeta.size === 0);
    check('dispose disposed both engines', log9.filter((e) => e[0] === 'dispose').length === 2);
  }

  // 11. The HTTP surface: /rooms reports what is live, /close-room reaps on
  //     demand. Without these the only way to see a leaked room was to count
  //     codex.exe in the task manager.
  {
    const log10 = [];
    const api = makeApi({ idleRoomTtlMs: TTL, sweepIntervalMs: 0 }, log10);
    const server = http.createServer(async (request, response) => {
      const handled = await api.handle(request, response, {});
      if (!handled) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const getJson = async (route, options) => {
      const res = await fetch(base + route, options);
      return { status: res.status, body: await res.json() };
    };
    try {
      await api.ensure('http-one', { title: 'One' });
      const empty = await getJson('/rooms');
      check('/rooms reports the live room', empty.status === 200 && empty.body.rooms.includes('http-one'), JSON.stringify(empty.body));
      check('/rooms reports the ttl', empty.body.idleRoomTtlMs === TTL, `ttl=${empty.body.idleRoomTtlMs}`);

      const closed = await getJson('/close-room', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: 'http-one' }),
      });
      check('POST /close-room closes it', closed.body.closed === true, JSON.stringify(closed.body));
      const after = await getJson('/rooms');
      check('the closed room is gone', !after.body.rooms.includes('http-one'), JSON.stringify(after.body));
      check('the closed room was disposed', log10.some((e) => e[0] === 'dispose' && e[1] === 'http-one'));

      // Closing an unknown room must report "nothing happened", not fail: the
      // caller may be racing the reaper.
      const ghost = await getJson('/close-room', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: 'http-ghost' }),
      });
      check('closing an unknown room is a clean no-op', ghost.status === 200 && ghost.body.closed === false, JSON.stringify(ghost.body));

      // A read-only GET must not be the thing that keeps a stray room alive
      // forever: it touches, but the reaper still collects it later.
      const state = await getJson('/state?room=http-two');
      check('GET /state still creates a room', state.status === 200 && api.rooms.has('http-two'));
      const reaped = await api.sweepIdle(Date.now() + TTL + 1);
      check('a room created by a read-only probe is reapable', reaped.includes('http-two'), `reaped=${reaped.join(',')}`);
    } finally {
      await api.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  console.log('roster of rooms        distinct ids -> distinct rooms, same id reused');
  console.log('idle sweep             stale rooms reaped and disposed, warm rooms kept');
  console.log('touch semantics        a read re-touches, so a watched room never expires');
  console.log('safety                 busy rooms and streamed rooms survive, force overrides');
  console.log('soft cap               reclaims stale rooms at capacity, never evicts in-use ones');
  console.log('ttl=0                  reaping and the cap both disabled, no timer');
  console.log('dispose                timer stopped, rooms and bookkeeping cleared');
  console.log('http                   /rooms and /close-room, unknown room is a clean no-op');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
