#!/usr/bin/env node
/**
 * The room must not need a member to speak before that member can hear.
 *
 * Bug this pins down: threads used to be created lazily on a member's own first
 * turn, so in a fresh room the first message reached only the threads that
 * already existed — i.e. nobody's — and every listener stayed deaf until it was
 * its turn. `connect()` now pre-warms every member, so the very first segment
 * goes straight into a warm session instead of paying for a cold start.
 *
 * R3 note: the push itself is no longer a per-record injection into another
 * member's thread. A record is captured into that member's segment buffer and
 * handed over as one batched turn. So "the listener heard it" is now proven from
 * the body of the turn it was given (`runTurn` is echoed back by the stub),
 * not from an injection log. `member.running === null` means "not reading"
 * (it replaced `member.inflight.size === 0`).
 *
 * A backend that reports `supportsInject === false` is deliberately NOT warmed:
 * pre-warming exists to make the push cheap, and such a backend takes the same
 * segment channel anyway — see scenarios 3 and 6.
 */
'use strict';

const path = require('node:path');
const { AgentRoom } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

/**
 * Pool double with the real per-thread queue semantics: interrupts and turns
 * share one chain per thread, so ordering guarantees are testable. Every call is
 * recorded, which is how "was this member cold-started?" is answered.
 */
function makeStubPool() {
  const threads = new Map();
  const queues = new Map();
  const calls = [];
  let nextThread = 0;
  const enqueue = (key, task) => {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(key, next.catch(() => {}));
    return next;
  };
  const pool = {
    calls,
    threads,
    pid: 1,
    binary: 'stub',
    supportsInject: true,
    async start() {
      calls.push({ kind: 'start' });
    },
    async stop() {
      calls.push({ kind: 'stop' });
    },
    getThread: (key) => threads.get(key) || null,
    closeThread(key) {
      calls.push({ kind: 'close', key });
      threads.delete(key);
    },
    async modelCapabilities() {
      return new Map([['stub-model', { efforts: ['none', 'high'], serviceTiers: ['priority'], defaultEffort: 'none' }]]);
    },
    async openThread(key, options) {
      calls.push({ kind: 'open', key });
      nextThread += 1;
      const record = { key, id: 'thread-' + nextThread, model: options.model, sandbox: options.sandbox, cwd: options.cwd, options };
      threads.set(key, record);
      return record;
    },
    runTurn(key, options) {
      return enqueue(key, async () => {
        // The prompt body is recorded in `calls` — that is where the delivery
        // assertions read it. The reply deliberately does NOT echo the body:
        // an echoing reply would be appended as an agent record and re-quote the
        // very line under test, making "delivered once" unmeasurable.
        calls.push({ kind: 'runTurn', key, text: options.text });
        const thread = threads.get(key);
        return { text: `[${thread ? thread.id : 'no-thread'}] ok`, usage: null };
      });
    },
    async interrupt() {
      calls.push({ kind: 'interrupt' });
      return true;
    },
  };
  return pool;
}

const openCount = (pool) => pool.calls.filter((c) => c.kind === 'open').length;
const runsFor = (pool, key) => pool.calls.filter((c) => c.kind === 'runTurn' && c.key === key);
const bufferLines = (member) => member.segments.flatMap((segment) => segment.lines).join('\n');
const memberOf = (room, id) => room.members.find((m) => m.id === id);
/** Buffer lines that carry the marker, as whole lines — not substring hits, since
 *  a member's own echoed reply re-quotes everything it was given. */
const bufferedLines = (member, needle) => member.segments.flatMap((s) => s.lines).filter((line) => line.includes(needle) && !line.includes('[房间广播]'));
/** How many times a proper formatted `[用户]` line appears in a turn body. */
const userLineCount = (text, needle) => String(text || '').split('\n').filter((line) => /^\[\d{2}:\d{2}:\d{2}\] \[用户\] /.test(line) && line.includes(needle)).length;

function makeRoom(pool, overrides = {}) {
  const room = new AgentRoom({
    id: 'warm-room',
    cwd: path.join(__dirname, '..'),
    segmentMs: 0,
    queueStallMs: 0,
    members: [
      { id: 'alpha', label: 'Alpha', model: 'stub-model' },
      { id: 'beta', label: 'Beta', model: 'stub-model' },
      { id: 'gamma', label: 'Gamma', model: 'stub-model' },
    ],
    replyPolicy: 'mentioned-only',
    maxRelayHops: 0,
    ...overrides,
  });
  room.pool = pool;
  return room;
}

async function scenario1() {
  const pool = makeStubPool();
  const room = makeRoom(pool);
  await room.connect();
  const threads = Array.from(pool.threads.keys()).sort();
  check('s1 every member has a thread before anyone speaks', threads.join(',') === 'alpha,beta,gamma', threads.join(','));

  // The first message of the session is addressed to alpha only.
  const warmed = openCount(pool);
  const result = await room.say('@alpha 第一条消息，别人也该听到');
  check('s1 the addressed member is served at once', result.delivered.length === 1 && result.delivered[0].memberId === 'alpha', JSON.stringify(result.delivered));
  check('s1 the warm thread was reused, no cold start', openCount(pool) === warmed, `${warmed} -> ${openCount(pool)} opens`);
  const alphaTurn = runsFor(pool, 'alpha')[0];
  check('s1 the served turn carries the line', !!alphaTurn && alphaTurn.text.includes('[用户] @alpha 第一条消息，别人也该听到'), alphaTurn && alphaTurn.text);

  // The others are not woken, but they are not deaf either: the record is
  // captured into their buffer, exactly once.
  const beta = memberOf(room, 'beta');
  for (const id of ['beta', 'gamma']) {
    const member = memberOf(room, id);
    check(`s1 ${id} captured the line without being woken`, bufferedLines(member, '第一条消息，别人也该听到').length === 1, JSON.stringify(bufferedLines(member, '第一条消息，别人也该听到')));
  }
  check('s1 nothing is left in flight', beta.running === null, String(beta.running && beta.running.id));
  check('s1 the capture did not start a turn for the listener', runsFor(pool, 'beta').length === 0, `${runsFor(pool, 'beta').length} turns`);

  // The line is delivered to beta exactly once — at its turn — not at capture.
  await room._tick();
  const betaTurn = runsFor(pool, 'beta')[0];
  check('s1 the listener finally gets the line', !!betaTurn && betaTurn.text.includes('[用户] @alpha 第一条消息，别人也该听到'), betaTurn && betaTurn.text.slice(0, 200));
  check('s1 the captured line is not delivered a second time', !!betaTurn && userLineCount(betaTurn.text, '第一条消息，别人也该听到') === 1, betaTurn && String(userLineCount(betaTurn.text, '第一条消息，别人也该听到')));
  check('s1 the listener recorded a turn', beta.turns === 1, String(beta.turns));
  check('s1 nothing is left in flight after delivery', beta.running === null, String(beta.running && beta.running.id));
  return room;
}

async function scenario2() {
  // prewarm disabled => the old, lazy behaviour must come back exactly: no
  // session is opened until a member actually has to read something.
  const pool = makeStubPool();
  const room = makeRoom(pool, { prewarm: false });
  await room.connect();
  check('s2 prewarm:false opens no threads up front', pool.threads.size === 0, String(pool.threads.size));
  const result = await room.say('@alpha 冷启动');
  check('s2 the cold-start room still serves the first turn', result.delivered.length === 1 && result.delivered[0].memberId === 'alpha', JSON.stringify(result.delivered));
  check('s2 the thread is opened on demand', pool.threads.has('alpha'), Array.from(pool.threads.keys()).join(','));
  check('s2 nobody else was cold-started', !pool.threads.has('beta') && !pool.threads.has('gamma'), Array.from(pool.threads.keys()).join(','));
  check('s2 exactly one thread exists', pool.threads.size === 1, String(pool.threads.size));
  return room;
}

async function scenario3() {
  // An ACP-like backend receives it too, through the same segment channel: the
  // capture needs no thread, and the turn that follows opens one on demand.
  const pool = makeStubPool();
  pool.supportsInject = false;
  const room = makeRoom(pool);
  await room.connect();
  check('s3 an inject-less backend is not warmed', pool.threads.size === 0, Array.from(pool.threads.keys()).join(','));

  const first = await room.say('@alpha 一条别人听不到实时推送的消息');
  check('s3 the first message is still served', first.delivered.length === 1 && first.delivered[0].memberId === 'alpha', JSON.stringify(first.delivered));
  const beta = memberOf(room, 'beta');
  check('s3 the listener captured it anyway', bufferLines(beta).includes('一条别人听不到实时推送的消息'), JSON.stringify(bufferLines(beta)));

  await room._tick();
  const betaTurn = runsFor(pool, 'beta')[0];
  const text = betaTurn ? betaTurn.text : '';
  check('s3 the captured record was carried into the turn', /一条别人听不到实时推送的消息/.test(text), text.slice(0, 200));
  check('s3 the replay is attributed, not misattributed', /\[用户\]/.test(text) && !/\[你自己 @alpha\]/.test(text), text.slice(0, 240));
  const reply = room.log.filter((r) => r.authorId === 'beta').pop();
  check('s3 the inject-less member really answered', !!reply, 'beta never answered');
  return { room, turn: reply };
}

async function scenario4() {
  // A member that fails to warm must not sink the room.
  const pool = makeStubPool();
  const realOpen = pool.openThread;
  pool.openThread = async (key, options) => {
    if (key === 'beta') throw new Error('agent refused to start');
    return realOpen(key, options);
  };
  const room = makeRoom(pool);
  await room.connect();
  const beta = memberOf(room, 'beta');
  check('s4 the failing member records the error', /agent refused to start/.test(beta.error || ''), String(beta.error));
  check('s4 the healthy members are still warmed', pool.threads.has('alpha') && pool.threads.has('gamma'), Array.from(pool.threads.keys()).join(','));
  await room.say('@alpha 房间还能用吗');
  check('s4 the room still serves a turn', room.log.some((r) => r.authorId === 'alpha'), 'alpha never answered');
  check('s4 the room reports itself connected', room.ready === true);
  return room;
}

async function scenario5() {
  // A member added at runtime must become able to hear immediately, not at some
  // later turn.
  const pool = makeStubPool();
  const room = makeRoom(pool);
  await room.connect();
  await room.addMember({ id: 'delta', label: 'Delta', model: 'stub-model' });
  check('s5 the newcomer gets a thread on add', pool.threads.has('delta'), Array.from(pool.threads.keys()).join(','));
  const delta = memberOf(room, 'delta');
  check('s5 the newcomer is ready, not reading', delta.running === null, String(delta.running && delta.running.id));

  await room.say('@alpha 新人应该也听到了');
  check('s5 the newcomer captured the next message', bufferLines(delta).includes('新人应该也听到了'), JSON.stringify(bufferLines(delta)));
  check('s5 the newcomer was not woken early', runsFor(pool, 'delta').length === 0, `${runsFor(pool, 'delta').length} turns`);

  await room._tick();
  const deltaTurn = runsFor(pool, 'delta')[0];
  check('s5 the newcomer reads it on its own turn', !!deltaTurn && deltaTurn.text.includes('新人应该也听到了'), deltaTurn && deltaTurn.text.slice(0, 200));
  check('s5 the newcomer reused its warm thread', openCount(pool) === 4, `${openCount(pool)} opens`);
  return room;
}

async function scenario6() {
  // A backend with no injection support must not be warmed: the session would be
  // paid for and buy nothing, and its lazy spawn is a promise of the add path.
  // (Delivery itself does not depend on it — that is scenario 3.)
  const pool = makeStubPool();
  pool.supportsInject = false;
  const room = makeRoom(pool);
  await room.connect();
  check('s6 a non-injecting backend is not pre-warmed', pool.threads.size === 0, Array.from(pool.threads.keys()).join(','));
  await room.addMember({ id: 'delta', label: 'Delta', model: 'stub-model' });
  check('s6 a member added to it is not warmed either', !pool.threads.has('delta'), Array.from(pool.threads.keys()).join(','));
  // It still works — the thread is opened on demand.
  const before = openCount(pool);
  await room.say('@alpha 按需开线程');
  check('s6 the thread opens on first use', pool.threads.has('alpha'), Array.from(pool.threads.keys()).join(','));
  check('s6 only the member that had to read was opened', openCount(pool) === before + 1, `${before} -> ${openCount(pool)} opens`);
  check('s6 a disable-able flag is not a mute: the room answered', room.log.some((r) => r.authorId === 'alpha'), 'alpha never answered');
  return room;
}

async function main() {
  const r1 = await scenario1();
  const r2 = await scenario2();
  const r3 = await scenario3();
  const r4 = await scenario4();
  const r5 = await scenario5();
  const r6 = await scenario6();
  for (const room of [r1, r2, r3.room, r4, r5, r6]) await room.dispose();

  console.log('scenario1 warm   every member has a thread before the first message');
  console.log('                 the first segment goes straight to a turn, no cold start');
  console.log('scenario2 lazy   prewarm:false restores exactly the old behaviour');
  console.log('scenario3 acp    an inject-less backend hears it through the same channel');
  console.log('scenario4 degrade one member failing to warm leaves the room usable');
  console.log('scenario5 add    a member added at runtime hears the next message too');
  console.log('scenario6 policy a non-injecting backend is never warmed, opens on demand');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
