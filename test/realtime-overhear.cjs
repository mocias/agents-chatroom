#!/usr/bin/env node
/**
 * Offline engine test for SEGMENTED DELIVERY — no codex, no network.
 *
 * This file used to test real-time overhearing: every appended record was pushed
 * into the other members' threads immediately via `pool.injectItems`. That
 * feature is gone. R3 replaced it with SEGMENTS: a record is captured into each
 * non-author member's buffer and handed over as one batched turn, so three typed
 * lines cost one turn instead of three.
 *
 * What replaced what, and what this file now pins down:
 *
 *   `pool.injected`   -> `member.segments[].lines`  (capture is bookkeeping,
 *                         starts nothing, and needs no thread)
 *   push at append    -> delivery on the tick, or now for the first message / `@`
 *   `member.inflight` -> `member.running`           (`null` means "not reading")
 *   per-record replay -> `member.carryOver` + `_replayLines` on thread rebuild
 *
 * The stub pool records every turn body, so "did this member actually see that
 * line?" is answered from the turn it was given, not assumed. `segmentMs: 0`
 * disables the ticker so delivery only happens through `say()`, `@`, or an
 * explicit `await room._tick()` — fully deterministic.
 */
'use strict';

const path = require('node:path');
const { AgentRoom } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pool stub with the real per-thread queue (serialised promises), so "steer
 * bypasses the queue" and "a cancelled turn returns what it had" are observable.
 *
 * `injected` is deliberately still recorded: the whole point of this file is
 * that the push channel is no longer used, so every assertion can check it is
 * untouched.
 */
function stubPool(options = {}) {
  const calls = [];
  const injected = [];
  const state = { threads: new Set(), running: new Map(), turnSerial: 0 };
  const queue = new Map();
  const enqueue = (key, task) => {
    const previous = queue.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    queue.set(key, next.catch(() => {}));
    return next;
  };
  const pool = {
    binary: '(stub)',
    pid: 1,
    calls,
    injected,
    state,
    supportsInject: true,
    supportsSteer: options.supportsSteer === true,
    running: true,
    async start() {},
    async stop() {
      pool.running = false;
    },
    async modelCapabilities() {
      const map = new Map();
      map.set('gpt-5.6-sol', { id: 'gpt-5.6-sol', efforts: ['none', 'low', 'high'], serviceTiers: [], defaultEffort: 'low' });
      return map;
    },
    getThread(memberId) {
      return state.threads.has(memberId) ? { id: `thread-${memberId}`, sandbox: 'read-only' } : null;
    },
    async openThread(memberId) {
      state.threads.add(memberId);
      return { id: `thread-${memberId}`, sandbox: 'read-only' };
    },
    closeThread(memberId) {
      state.threads.delete(memberId);
    },
    async injectItems(memberId, lines) {
      injected.push({ memberId, lines });
      return { injected: lines.length };
    },
    async flush() {},
    async interrupt(memberId) {
      calls.push({ kind: 'interrupt', memberId });
      const active = state.running.get(memberId);
      if (active) active.cancelled = true;
      return true;
    },
    async steer(memberId, text) {
      calls.push({ kind: 'steer', memberId, text });
      const active = state.running.get(memberId);
      if (!active) return { ok: false, reason: 'no-active-turn' };
      active.steered.push(text);
      return { ok: true, turnId: active.turnId };
    },
    runTurn(memberId, turnOptions) {
      return enqueue(memberId, async () => {
        const turnId = `turn-${++state.turnSerial}`;
        const active = { turnId, steered: [], cancelled: false, call: { memberId, text: turnOptions.text } };
        state.running.set(memberId, active);
        calls.push({ kind: 'runTurn', memberId, text: turnOptions.text, turnId });
        try {
          if (options.turnMs) await delay(options.turnMs);
          if (active.cancelled) return { text: '', usage: {}, interrupted: true };
          const reply = typeof options.reply === 'function' ? options.reply(memberId, turnOptions) : options.reply;
          return { text: reply === undefined ? `[${memberId}] ok` : reply, usage: {} };
        } finally {
          state.running.delete(memberId);
        }
      });
    },
  };
  return pool;
}

/** A connected room with a stub pool. No ticker: delivery is driven by hand. */
function makeRoom(config = {}) {
  const room = new AgentRoom({
    cwd: process.cwd(),
    segmentMs: 0,
    queueStallMs: 0,
    members: [
      { id: 'alpha', label: 'Alpha', model: 'gpt-5.6-sol' },
      { id: 'beta', label: 'Beta', model: 'gpt-5.6-sol' },
      { id: 'gamma', label: 'Gamma', model: 'gpt-5.6-sol' },
    ],
    ...config,
  });
  const pool = stubPool(config.pool);
  room.pool = pool;
  return { room, pool };
}

const runsFor = (pool, memberId) => pool.calls.filter((c) => c.kind === 'runTurn' && c.memberId === memberId);
const bufferLines = (member) => member.segments.flatMap((segment) => segment.lines).join('\n');

async function main() {
  const problems = [];
  const check = (label, ok, detail) => {
    if (!ok) problems.push(`${label}${detail === undefined ? '' : `: ${detail}`}`);
  };

  // ---- 1. capture: a record reaches every non-author buffer, starts nothing --
  {
    const { room, pool } = makeRoom();
    await room.connect();
    await room.say('开场', { authorId: 'user' });
    // Clear what the opening produced so the next append is the only variable.
    for (const member of room.members) member.segments = [];
    const before = pool.calls.filter((c) => c.kind === 'runTurn').length;

    room.append({ authorId: 'user', authorLabel: '你', text: '第一句广播', kind: 'user', mentions: [] });

    const turns = pool.calls.filter((c) => c.kind === 'runTurn').length - before;
    check('s1 append starts no turn', turns === 0, `saw ${turns} turns for a plain capture`);
    for (const id of ['alpha', 'beta', 'gamma']) {
      const member = room.members.find((m) => m.id === id);
      check(`s1 ${id} has the record buffered`, member.segments.length === 1, `segments ${member.segments.length}`);
      check(`s1 ${id}'s buffer holds the formatted line`, bufferLines(member).includes('[用户] 第一句广播'), JSON.stringify(bufferLines(member)));
    }
    check('s1 the push channel was not used', pool.injected.length === 0, JSON.stringify(pool.injected));
  }

  // ---- 2. the first message is served now; later ones wait for the tick -----
  {
    const { room, pool } = makeRoom({ pool: { reply: '' } });
    await room.connect();

    const first = await room.say('第一句');
    check('s2 the first message is served immediately', first.delivered.length === room.members.length, JSON.stringify(first.delivered));
    const afterFirst = pool.calls.filter((c) => c.kind === 'runTurn').length;
    check('s2 the first message reached every member', afterFirst === 3, `${afterFirst} turns`);

    const second = await room.say('第二句');
    check('s2 a later message does not serve itself', second.delivered.length === 0, JSON.stringify(second.delivered));
    check('s2 no turn started before the tick', pool.calls.filter((c) => c.kind === 'runTurn').length === afterFirst);
    for (const id of ['alpha', 'beta', 'gamma']) {
      const member = room.members.find((m) => m.id === id);
      check(`s2 ${id} is holding the unread segment`, member.segments.length === 1 && member.running === null, `queued ${member.segments.length} running ${!!member.running}`);
    }

    await room._tick();
    const served = pool.calls.filter((c) => c.kind === 'runTurn').length - afterFirst;
    check('s2 the tick hands the segment over', served === 3, `${served} turns`);
    const secondTurn = runsFor(pool, 'alpha')[1];
    check('s2 the delivered body carries the buffered line', !!secondTurn && /\[\d{2}:\d{2}:\d{2}\] \[用户\] 第二句/.test(secondTurn.text), secondTurn && secondTurn.text);
    check('s2 the delivered body announces the broadcast', !!secondTurn && secondTurn.text.includes('[房间广播]'), secondTurn && secondTurn.text.slice(0, 120));
    check('s2 the buffers are drained after delivery', room.members.every((m) => m.segments.length === 0), JSON.stringify(room.snapshot().members.map((m) => m.queued)));
    check('s2 the push channel was not used', pool.injected.length === 0, JSON.stringify(pool.injected));
  }

  // ---- 3. `@` is served now, and only to the member it names ---------------
  {
    const { room, pool } = makeRoom({ pool: { reply: '' } });
    await room.connect();
    await room.say('开场');
    const baseline = pool.calls.filter((c) => c.kind === 'runTurn').length;

    const result = await room.say('@beta 你怎么看？');
    const runs = pool.calls.filter((c) => c.kind === 'runTurn').slice(baseline);
    check('s3 @ is served immediately', runs.length === 1, JSON.stringify(runs.map((r) => r.memberId)));
    check('s3 @ served only the named member', runs[0] && runs[0].memberId === 'beta', JSON.stringify(runs.map((r) => r.memberId)));
    check('s3 the named member is told the segment points at it', !!runs[0] && runs[0].text.includes('这一段点到了你'), runs[0] && runs[0].text.slice(-140));
    check('s3 say reports whom it served', result.delivered.length === 1 && result.delivered[0].memberId === 'beta', JSON.stringify(result.delivered));
    // The unaddressed members are not woken — they keep it for their next turn.
    const alpha = room.members.find((m) => m.id === 'alpha');
    check('s3 an unaddressed member keeps the line buffered', bufferLines(alpha).includes('@beta 你怎么看？'), JSON.stringify(bufferLines(alpha)));
    check('s3 the push channel was not used', pool.injected.length === 0, JSON.stringify(pool.injected));
  }

  // ---- 4. `@` on a busy member: steer when the backend supports it ----------
  {
    const { room, pool } = makeRoom({ pool: { supportsSteer: true, turnMs: 300, reply: '' } });
    await room.connect();
    // Fire the opening without awaiting: the point is the window where the
    // member IS reading, which is the state `_preempt` acts on.
    const opening = room.say('开场');
    await delay(30);
    const alpha = room.members.find((m) => m.id === 'alpha');
    check('s4 the member is reading', !!alpha.running, String(alpha.running && alpha.running.id));

    const result = await room.say('@alpha 立刻补充一句');
    const steers = pool.calls.filter((c) => c.kind === 'steer');
    check('s4 @ on a busy member steers instead of queueing', steers.length === 1 && steers[0].memberId === 'alpha', JSON.stringify(steers));
    check('s4 the steered text is the new line', !!steers[0] && steers[0].text.includes('立刻补充一句'), steers[0] && steers[0].text);
    check('s4 the outcome says it was steered', result.delivered.length === 1 && result.delivered[0].steered === true, JSON.stringify(result.delivered));
    check('s4 no second turn was queued behind the running one', runsFor(pool, 'alpha').length === 1, `${runsFor(pool, 'alpha').length} turns`);
    check('s4 the member was not interrupted', pool.calls.filter((c) => c.kind === 'interrupt').length === 0, JSON.stringify(pool.calls.filter((c) => c.kind === 'interrupt')));
    check('s4 steering bypasses the buffer entirely', alpha.segments.length === 0, `queued ${alpha.segments.length}`);
    await opening;
  }

  // ---- 5. no steering support: the turn is cancelled and carried over -------
  {
    const { room, pool } = makeRoom({ pool: { supportsSteer: false, turnMs: 300, reply: '' } });
    await room.connect();
    const opening = room.say('开场');
    await delay(30);
    const alpha = room.members.find((m) => m.id === 'alpha');
    check('s5 the member is reading', !!alpha.running, String(alpha.running && alpha.running.id));

    const result = await room.say('@alpha 这条必须先说完');
    check('s5 the outcome says it was preempted', result.delivered.length === 1 && result.delivered[0].preempted === true, JSON.stringify(result.delivered));
    check('s5 the running turn was interrupted', pool.calls.some((c) => c.kind === 'interrupt' && c.memberId === 'alpha'), JSON.stringify(pool.calls.filter((c) => c.kind === 'interrupt')));
    check('s5 no steer was attempted', pool.calls.filter((c) => c.kind === 'steer').length === 0, JSON.stringify(pool.calls.filter((c) => c.kind === 'steer')));
    check('s5 the interrupted text is carried over, not lost', alpha.carryOver.includes('开场'), JSON.stringify(alpha.carryOver));
    check('s5 preemption is counted', alpha.preempted === 1, String(alpha.preempted));
    await opening;

    // The carried-over text is not a dead end: the next delivery replays it.
    check('s5 the member is free again', alpha.running === null, String(alpha.running && alpha.running.id));
    await room._tick();
    const after = runsFor(pool, 'alpha');
    check('s5 the carried-over text is re-delivered on the next turn', after.length === 2 && after[1].text.includes('开场'), JSON.stringify(after.map((t) => t.text.slice(0, 60))));
    check('s5 the carry-over is cleared once delivered', alpha.carryOver === '', JSON.stringify(alpha.carryOver));
    check('s5 the push channel was not used', pool.injected.length === 0, JSON.stringify(pool.injected));
  }

  // ---- 6. merge rule: content joins the open segment, it does not pile up ---
  {
    const { room } = makeRoom();
    await room.connect();
    await room.say('开场');
    const alpha = room.members.find((m) => m.id === 'alpha');
    alpha.segments = [];

    room.append({ authorId: 'user', authorLabel: '你', text: '甲', kind: 'user', mentions: [] });
    room.append({ authorId: 'user', authorLabel: '你', text: '乙', kind: 'user', mentions: [] });
    room.append({ authorId: 'user', authorLabel: '你', text: '丙', kind: 'user', mentions: [] });

    check('s6 unread content merges into one segment', alpha.segments.length === 1, `segments ${alpha.segments.length}`);
    check('s6 the merged segment holds every line in order', alpha.segments[0].lines.length === 3 && /\n/.test(bufferLines(alpha)), JSON.stringify(alpha.segments[0].lines));

    // A segment that closed by size starts a new one instead of growing forever.
    const sized = makeRoom({ maxSegmentChars: 40 });
    await sized.room.connect();
    await sized.room.say('开场');
    const small = sized.room.members.find((m) => m.id === 'alpha');
    small.segments = [];
    for (let i = 0; i < 4; i += 1) {
      sized.room.append({ authorId: 'user', authorLabel: '你', text: `第 ${i} 条挺长的内容内容内容`, kind: 'user', mentions: [] });
    }
    check('s6 a full segment is closed rather than grown', small.segments.length > 1, `segments ${small.segments.length}`);
    await sized.room.dispose();
  }

  console.log('capture    a record lands in every non-author buffer and wakes nobody');
  console.log('tick       the first message is immediate, later ones wait for the tick');
  console.log('mention    @ is immediate and names exactly one member');
  console.log('steer      @ on a busy codex member goes into the running turn');
  console.log('preempt    without steer the turn is cancelled and the text carried over');
  console.log('merge      unread content joins the open segment, or closes it at the cap');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
