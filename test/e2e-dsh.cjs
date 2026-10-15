'use strict';
/**
 * End-to-end check against a LIVE DSH host.
 *
 * Drives the room over the same HTTP surface the browser tab uses, so it proves
 * the installed plugin (host entry + webServer route + codex pool), not just the
 * standalone engine. Usage: node test/e2e-dsh.cjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:19387/agent-room';

async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function get(path) {
  const response = await fetch(BASE + path);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** POST that tolerates a non-2xx answer, so a tombstone can be asserted. */
async function postRaw(path, body) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

(async () => {
  const problems = [];
  const state0 = await get('/state?room=e2e');
  console.log('room     :', state0.snapshot.roomId, '| connected:', state0.snapshot.connected);
  console.log('codex pid:', state0.snapshot.codexPid);
  console.log('members  :', state0.snapshot.members.map((m) => '@' + m.id + '(' + m.model + ')').join(' '));
  if (!state0.snapshot.connected) problems.push('room is not connected to codex');

  // 1. @-addressing must wake exactly one agent (the other two stay cold).
  const mentioned = await post('/say', {
    room: 'e2e',
    text: '@astra 只回答两个字：收到。不要使用任何工具。',
  });
  const awoken = mentioned.delivered.filter((d) => d.record).map((d) => d.memberId);
  console.log('\n@astra  -> delivered:', JSON.stringify(mentioned.delivered.map((d) => d.memberId)));
  console.log('          text      :', (mentioned.delivered[0]?.record?.text || '(none)').slice(0, 120));
  if (awoken.length !== 1 || awoken[0] !== 'astra') {
    problems.push('@astra woke ' + JSON.stringify(awoken) + ' instead of exactly ["astra"]');
  }

  // 2. A broadcast with no mention must be heard by everyone (public room).
  const broadcast = await post('/say', {
    room: 'e2e',
    text: '一句话确认你收到了这条公开消息，署名你自己的名字，不要用工具。',
  });
  const heard = broadcast.delivered.map((d) => d.memberId).sort();
  console.log('\nbroadcast -> delivered:', JSON.stringify(heard));
  if (heard.length < 2) problems.push('broadcast only reached ' + JSON.stringify(heard));

  // 3. The shared log must contain every agent line, i.e. it is a real room.
  const state1 = await get('/state?room=e2e');
  const authors = state1.snapshot.log.map((e) => e.authorId);
  console.log('\nlog authors:', JSON.stringify(authors));
  for (const id of heard) {
    if (!authors.includes(id)) problems.push('agent ' + id + ' answered but its line is not in the shared log');
  }

  // 4. Agents must be able to read each other's lines: ask one about a peer.
  const cross = await post('/say', {
    room: 'e2e',
    text: '@astra 这个房间里除你之外，还有谁已经发过言？只列名字，不要用工具。',
  });
  const crossText = cross.delivered[0]?.record?.text || '';
  console.log('\ncross-read ->', crossText.slice(0, 160));
  if (!crossText) problems.push('cross-read produced no text');

  // 5. Mode switch must be reflected and must not lose the log.
  const chat = await post('/mode', { room: 'e2e', mode: 'chat' });
  console.log('\nmode ->', chat.mode);
  if (chat.mode !== 'chat') problems.push('/mode did not report chat');
  const work = await post('/mode', { room: 'e2e', mode: 'work' });
  if (work.mode !== 'work') problems.push('/mode did not report work');
  await post('/mode', { room: 'e2e', mode: 'chat' });
  const state2 = await get('/state?room=e2e');
  if (state2.snapshot.log.length < state1.snapshot.log.length) {
    problems.push('switching mode dropped log entries');
  }

  // 6. The wire protocol must truthfully advertise the guest-visible surface.
  const models = await get('/models?room=e2e');
  console.log('models ->', models.available.length, 'available;',
    models.members.map((m) => `${m.id}=${m.error ? 'ERR' : 'ok'}`).join(' '));
  if (!models.available.length) problems.push('/models reported no available models');

  // 7. R1: 「清空本房间」is gone. The tombstone must answer 410 and must NOT
  //    touch the room — an in-place reset had to fight the segment buffers and
  //    the on-disk log, so "start over" is now delete-the-room-and-make-a-new-one.
  const fresh = await postRaw('/new-conversation', { room: 'e2e' });
  console.log('new conversation ->', fresh.status, JSON.stringify(fresh.body));
  if (fresh.status !== 410) problems.push('/new-conversation answered ' + fresh.status + ' instead of 410');
  if (fresh.body.ok !== false) problems.push('/new-conversation did not report failure');
  const after = await get('/state?room=e2e');
  const leftover = after.snapshot.log.filter((e) => e.kind !== 'system');
  console.log('  entries after the tombstone:', after.snapshot.log.length,
    '| non-system:', leftover.length);
  if (after.snapshot.log.length !== state2.snapshot.log.length) {
    problems.push('the /new-conversation tombstone mutated the log');
  }

  console.log('\nusage:', state2.snapshot.members.map((m) => `${m.id}=${m.tokens}tok`).join(' '));

  // 8. R3: delivery is segmented and the room persists it. Every line a member
  //    did not write must be captured for it — that is what replaced the old
  //    per-line real-time injection, and what lets an unaddressed member read
  //    the room on its next turn.
  const held = state1.snapshot.members.map((m) => `${m.id}=${m.queued || 0}q/${m.segmentsSent || 0}s`);
  console.log('\ndelivery -> segmentMs:', state1.snapshot.segmentMs, '| per member:', held.join(' '));
  if (!(state1.snapshot.segmentMs > 0)) problems.push('segmentMs is not configured');
  const anyHeld = state1.snapshot.members.some((m) => (m.queued || 0) > 0 || m.activeSegment);
  if (!anyHeld) {
    problems.push('no member holds any unread segment — is capture working?');
  }
  if (!state1.snapshot.logFile) problems.push('/state did not report a logFile');
  else console.log('           logFile  :', state1.snapshot.logFile);
  const workspaces = state1.snapshot.workspaceDirs || {};
  console.log('           workspaces:', Object.entries(workspaces).map(([b, d]) => `${b}=${d}`).join(' '));
  if (!workspaces.codex) problems.push('workspaceDirs.codex is not configured');

  // 9. Adding a teammate: a new independent thread, no restart involved.
  const addId = 'e2e' + Date.now().toString(36).slice(-4);
  const added = await post('/members', {
    room: 'e2e',
    id: addId,
    label: 'E2E Guest',
    persona: '你负责核对别人的结论。',
  });
  console.log('\nadd member ->', added.member.id, added.member.backend, added.member.model);
  if (!added.member || added.member.id !== addId) problems.push('POST /members did not return the new member');
  const state3 = await get('/state?room=e2e');
  const guest = state3.snapshot.members.find((m) => m.id === addId);
  if (!guest) problems.push('the new member is not in /state');
  else if (guest.persona !== '你负责核对别人的结论。') problems.push('the persona did not survive the round trip');

  // 10. Re-pointing that member's model, and the catalogue that makes it possible.
  const catalogue = await get('/models?room=e2e');
  const target = (catalogue.models.find((row) => row.model !== guest?.model) || {}).model;
  console.log('catalogue ->', catalogue.backends.join(','), '|', catalogue.models.length, 'model(s)');
  if (!catalogue.models.length) problems.push('/models reported no models by backend');
  if (!catalogue.backends.length) problems.push('/models reported no backends');
  if (target) {
    const edited = await post('/member', { room: 'e2e', id: addId, model: target });
    console.log('re-model  ->', edited.member.model);
    if (edited.member.model !== target) problems.push('POST /member did not change the model');
  }

  // 11. Removing a teammate must take it out of routing, not just the roster.
  const removed = await post('/remove-member', { room: 'e2e', id: addId });
  console.log('remove    ->', removed.removed.id);
  const state4 = await get('/state?room=e2e');
  if (state4.snapshot.members.some((m) => m.id === addId)) problems.push('the removed member is still in /state');
  const afterRemove = await post('/say', {
    room: 'e2e',
    text: `@${addId} 你应该已经不在房间里了，如果还能收到请回复。`,
  });
  const leaked = afterRemove.delivered.filter((d) => d.memberId === addId);
  if (leaked.length) problems.push('a removed member was still woken by an @mention');
  console.log('           removed member woken by @:', leaked.length);

  console.log('\nproblems:', problems.length ? problems : 'none');
  process.exit(problems.length ? 1 : 0);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
