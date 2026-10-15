#!/usr/bin/env node
/**
 * HTTP contract test for member management — a real server on a real socket,
 * but a stubbed engine, so no harness is ever spawned.
 *
 * The engine is tested directly in `member-management.cjs`; what this file
 * covers is the layer between the browser and the engine: route shapes, method
 * and body handling, error mapping (a rejected add must be a 500 with the
 * engine's message, not a hung request or a silent 200), and the fact that
 * `GET /state` and `GET /models` carry what the UI needs to render the roster.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoomApi } = require(path.join(__dirname, '..', 'lib', 'server.cjs'));

/** A minimal stand-in for AgentRoom: records calls, no subprocess. */
function stubRoom(config) {
  const state = {
    id: config.id,
    replyPolicy: config.replyPolicy || 'addressed',
    mode: 'chat',
    members: [{ id: 'alpha', label: 'Alpha', model: 'm-one', persona: '', aliases: [], backend: 'codex' }],
    log: [],
    logSeq: 0,
    ready: true,
    backends: ['codex'],
    modelList: [{ backend: 'codex', model: 'm-one' }],
  };
  const calls = [];
  const room = {
    id: state.id,
    calls,
    get members() {
      return state.members;
    },
    get mode() {
      return state.mode;
    },
    get replyPolicy() {
      return state.replyPolicy;
    },
    get availableModels() {
      return ['m-one'];
    },
    snapshot() {
      return {
        roomId: state.id,
        mode: state.mode,
        replyPolicy: state.replyPolicy,
        connected: true,
        members: state.members.map((m) => ({ ...m, status: 'idle', turns: 0, tokens: 0 })),
        log: state.log,
      };
    },
    backends() {
      return state.backends;
    },
    modelsByBackend() {
      return state.modelList;
    },
    toConfig(member) {
      return { id: member.id, label: member.label, model: member.model, persona: member.persona, backend: member.backend };
    },
    async connect() {
      calls.push(['connect']);
    },
    async addMember(input) {
      calls.push(['addMember', input]);
      if (!input.id) throw new Error('member id is required');
      if (state.members.some((m) => m.id === input.id)) throw new Error(`member already exists: ${input.id}`);
      const member = { id: input.id, label: input.label || input.id, model: input.model || 'm-one', persona: input.persona || '', backend: input.backend || 'codex' };
      state.members.push(member);
      return member;
    },
    async removeMember(id) {
      calls.push(['removeMember', id]);
      const index = state.members.findIndex((m) => m.id === id);
      if (index < 0) throw new Error(`no such member: ${id}`);
      return state.members.splice(index, 1)[0];
    },
    setMemberModel(id, model) {
      calls.push(['setMemberModel', id, model]);
      const member = state.members.find((m) => m.id === id);
      if (!member) throw new Error(`no such member: ${id}`);
      member.model = model;
      return member;
    },
    setMemberPersona(id, persona) {
      calls.push(['setMemberPersona', id, persona]);
      const member = state.members.find((m) => m.id === id);
      if (!member) throw new Error(`no such member: ${id}`);
      member.persona = persona;
      return member;
    },
    setMemberLabel(id, label) {
      calls.push(['setMemberLabel', id, label]);
      const member = state.members.find((m) => m.id === id);
      if (!member) throw new Error(`no such member: ${id}`);
      member.label = label;
      return member;
    },
    setReplyPolicy(policy) {
      state.replyPolicy = policy;
      return policy;
    },
    setMode(mode) {
      state.mode = mode;
      return mode;
    },
    async say(text) {
      calls.push(['say', text]);
      return { entry: { id: 'm1', text }, delivered: [] };
    },
    async interruptAll() {
      return [];
    },
    async dispose() {},
  };
  room._state = state;
  return room;
}

async function main() {
  const problems = [];
  const check = (label, ok, detail) => {
    if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-http-'));
  const api = new RoomApi({ cwd: process.cwd(), title: 'stub', roomsDir: tmp, createRoom: stubRoom });
  const server = http.createServer(async (request, response) => {
    const handled = await api.handle(request, response, {});
    if (!handled) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    return { status: response.status, payload };
  };

  try {
    // --- the roster is visible to the UI before anything is added ---
    const state0 = await call('GET', '/state?room=r1');
    check('GET /state lists the members', state0.payload && state0.payload.snapshot.members.length === 1, JSON.stringify(state0.payload));

    const models0 = await call('GET', '/models?room=r1');
    check('GET /models reports the model list', Array.isArray(models0.payload.models), JSON.stringify(models0.payload));
    check('GET /models tags each model with its backend', models0.payload.models[0].backend === 'codex', JSON.stringify(models0.payload.models));
    check('GET /models reports the backends in use', Array.isArray(models0.payload.backends), JSON.stringify(models0.payload.backends));

    // --- add a member ---
    const added = await call('POST', '/members', { room: 'r1', id: 'beta', label: 'Beta', model: 'm-one', persona: '挑错' });
    check('POST /members succeeds', added.status === 200 && added.payload.ok === true, JSON.stringify(added.payload));
    check('POST /members returns the new member', added.payload.member && added.payload.member.id === 'beta', JSON.stringify(added.payload));

    const room1 = api.get('r1');
    const addCall = room1.calls.find((row) => row[0] === 'addMember');
    check('the persona reached the engine', addCall && addCall[1].persona === '挑错', JSON.stringify(addCall));

    const state1 = await call('GET', '/state?room=r1');
    check('the new member shows up in /state', state1.payload.snapshot.members.length === 2, JSON.stringify(state1.payload.snapshot.members.map((m) => m.id)));

    // --- a duplicate id must be a visible error, not a silent success ---
    const duplicate = await call('POST', '/members', { room: 'r1', id: 'beta' });
    check('a duplicate id fails with a non-200', duplicate.status >= 400, String(duplicate.status));
    check('the failure carries the engine message', duplicate.payload && /already exists/.test(duplicate.payload.error || ''), JSON.stringify(duplicate.payload));

    // --- re-point a member: all three editable fields in one call ---
    const edited = await call('POST', '/member', { room: 'r1', id: 'beta', model: 'm-two', persona: '审查', label: 'B' });
    check('POST /member succeeds', edited.status === 200 && edited.payload.ok === true, JSON.stringify(edited.payload));
    const beta = api.get('r1').members.find((m) => m.id === 'beta');
    check('the model was changed', beta.model === 'm-two', beta.model);
    check('the persona was changed', beta.persona === '审查', beta.persona);
    check('the label was changed', beta.label === 'B', beta.label);

    // --- a partial edit must not clobber the untouched fields ---
    const partial = await call('POST', '/member', { room: 'r1', id: 'beta', model: 'm-three' });
    check('a partial edit is allowed', partial.status === 200, JSON.stringify(partial.payload));
    check('a partial edit leaves the persona alone', beta.persona === '审查', beta.persona);

    // --- editing an unknown member is an error ---
    const ghost = await call('POST', '/member', { room: 'r1', id: 'nobody', model: 'm-one' });
    check('editing an unknown member fails', ghost.status >= 400 && /no such member/.test(ghost.payload.error || ''), JSON.stringify(ghost.payload));

    // --- remove a member ---
    const removed = await call('POST', '/remove-member', { room: 'r1', id: 'beta' });
    check('POST /remove-member succeeds', removed.status === 200 && removed.payload.ok === true, JSON.stringify(removed.payload));
    check('the removed member is reported back', removed.payload.removed && removed.payload.removed.id === 'beta', JSON.stringify(removed.payload));
    const state2 = await call('GET', '/state?room=r1');
    check('the member is gone from /state', state2.payload.snapshot.members.length === 1, JSON.stringify(state2.payload.snapshot.members.map((m) => m.id)));

    const missing = await call('POST', '/remove-member', { room: 'r1', id: 'beta' });
    check('removing twice fails the second time', missing.status >= 400, String(missing.status));

    // --- a malformed body must be a clean error, not a crash ---
    const bad = await fetch(base + '/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    const badPayload = await bad.json().catch(() => null);
    check('a malformed body is a clean 500', bad.status === 500, String(bad.status));
    check('a malformed body explains itself', badPayload && /invalid JSON/.test(badPayload.error || ''), JSON.stringify(badPayload));

    // The server must still be alive after all that.
    const alive = await call('GET', '/state?room=r1');
    check('the server survived a malformed request', alive.status === 200, String(alive.status));

    // --- rooms are isolated ---
    await call('POST', '/members', { room: 'r2', id: 'zeta' });
    const other = await call('GET', '/state?room=r2');
    check('a second room has its own roster', other.payload.snapshot.members.length === 2, JSON.stringify(other.payload.snapshot.members.map((m) => m.id)));
    const first = await call('GET', '/state?room=r1');
    check('the first room was not affected', first.payload.snapshot.members.length === 1, JSON.stringify(first.payload.snapshot.members.map((m) => m.id)));
  } finally {
    await api.dispose();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('GET  /state /models   roster + per-backend model catalogue');
  console.log('POST /members         add, duplicate rejected');
  console.log('POST /member          model + persona + label, partial edits safe');
  console.log('POST /remove-member   remove, double-remove rejected');
  console.log('malformed body        500 with a message, server survives');
  console.log('room isolation        two rooms, two rosters');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
