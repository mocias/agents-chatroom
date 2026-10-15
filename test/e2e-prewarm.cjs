#!/usr/bin/env node
/**
 * Real-codex proof of the prewarm fix: in a brand-new room, the *first* message
 * must reach a member that has never spoken.
 *
 * This is the end-to-end counterpart to `test/prewarm.cjs`. It needs a live
 * standalone room (`node test/serve.cjs <port>`) with a real codex.
 *
 * Run:  node test/e2e-prewarm.cjs [http://127.0.0.1:8796]
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8796';
const ROOM = 'warm' + Math.random().toString(36).slice(2, 8);

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

async function get(path) {
  const response = await fetch(BASE + path);
  return response.json();
}
async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function main() {
  // Wait for the server to be up.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await get('/state?room=' + ROOM);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const state0 = await get('/state?room=' + ROOM);
  const members = state0.snapshot.members.map((m) => m.id);
  console.log('room    :', ROOM, '| connected:', state0.snapshot.connected);
  console.log('members :', members.map((id) => '@' + id).join(' '));
  check('at least two members', members.length >= 2, JSON.stringify(members));
  check('prewarm is on by default', state0.snapshot.prewarm !== false, String(state0.snapshot.prewarm));

  // Every member must already own a thread — that is precisely what prewarm buys.
  const warmed = state0.snapshot.members.filter((m) => m.threadId);
  console.log('warm threads before any message:', warmed.length + '/' + members.length,
    '|', state0.snapshot.members.map((m) => `${m.id}:${m.threadId ? 'warm' : 'COLD'}`).join(' '));
  check('every member has a thread before the first message', warmed.length === members.length,
    state0.snapshot.members.filter((m) => !m.threadId).map((m) => m.id).join(','));

  // The very first message, addressed to ONE member.
  const first = members[0];
  const others = members.slice(1);
  const spoken = await post('/say', {
    room: ROOM,
    text: `@${first} 请只回答两个字：收到。不要使用任何工具。`,
  });
  const woke = spoken.delivered.map((d) => d.memberId);
  console.log('\nfirst message -> @' + first + ' | woken:', JSON.stringify(woke));
  check('only the addressed member was woken', woke.length === 1 && woke[0] === first, JSON.stringify(woke));

  // Let the turn settle, then look at what each member is holding.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const state1 = await get('/state?room=' + ROOM);
  const held = state1.snapshot.members.map((m) => `${m.id}:queued=${m.queued || 0}`);
  console.log('held:', held.join(' '), '| segmentMs:', state1.snapshot.segmentMs);
  // The first message of a room is served immediately, so this is about what was
  // *captured*, not what was pushed: every non-author member must have the line
  // in its own queue of unread segments. That is the R3 replacement for the old
  // real-time injection, and it is what makes an unaddressed member able to read
  // the room at all.
  const listeners = state1.snapshot.members.filter((m) => others.includes(m.id));
  check('a listener that never spoke holds the first message',
    listeners.some((m) => (m.queued || 0) > 0 || m.activeSegment),
    listeners.map((m) => `${m.id}:${m.queued || 0}`).join(' '));
  check('no member is left in a wedged turn',
    state1.snapshot.members.every((m) => !m.stalls),
    state1.snapshot.members.filter((m) => m.stalls).map((m) => `${m.id}:stalls=${m.stalls}`).join(' '));

  // Now prove the listener actually *has* the earlier content: ask it to recall,
  // which is the only way to confirm an injection landed (it is unreadable via API).
  const listener = others[0];
  const recall = await post('/say', {
    room: ROOM,
    text: `@${listener} 上一条公开消息是被点名给哪个成员的？只回答那个成员的 id，不要解释，不要用工具。`,
  });
  const answer = (recall.delivered[0]?.record?.text || '').trim();
  console.log('\nrecall ->', JSON.stringify(answer.slice(0, 120)));
  check('the listener knew about a message it was not asked to answer',
    answer.toLowerCase().includes(first.toLowerCase()),
    `expected to find "${first}" in ${JSON.stringify(answer.slice(0, 160))}`);

  console.log('\nproblems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
