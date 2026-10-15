#!/usr/bin/env node
/**
 * Offline test for the R3/R4 delivery layer — no codex, no network, no DSH.
 *
 * What this pins down, in the order the user asked for it:
 *
 *   1. capture      — a record reaches every non-author member's buffer and
 *                     starts nothing. Nobody is woken by bookkeeping.
 *   2. immediacy    — the room's first message and any `@` are served now, everything
 *                     else waits for the tick (so three typed lines = one turn).
 *   3. timestamps   — every injected line carries the plugin's own clock, taken
 *                     at append time. No harness protocol has that field.
 *   4. merge rule   — content joins the open (unread) segment; once a member has
 *                     begun reading, new content queues BEHIND it instead.
 *   5. truncation   — a segment closes at `maxSegmentChars` rather than growing
 *                     without bound, and one tick may then hand over several.
 *   6. steering     — `@` on a busy codex member goes into the running turn via
 *                     `pool.steer`, which must NOT be queued behind that turn.
 *   7. preemption   — a backend without steering has its turn cancelled and the
 *                     interrupted text carried into the next delivery.
 *   8. stall        — a genuinely wedged turn is interrupted once, then its text
 *                     is requeued and the queue freed. Never twice.
 *
 * The stub pool implements the real per-thread queue (serialised promises) so
 * ordering and "steer bypasses the queue" are observable, not assumed.
 */
'use strict';

const path = require('node:path');
const { AgentRoom } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

/** A pool stub that serialises turns per member and records every call. */
function stubPool(options = {}) {
  const calls = [];
  const state = {
    threads: new Set(),
    running: new Map(),
    turnSerial: 0,
  };
  const queue = new Map();
  const enqueue = (key, task) => {
    const previous = queue.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    queue.set(key, next.catch(() => {}));
    return next;
  };
  const pool = {
    binary: '(stub)',
    pid: 4242,
    calls,
    state,
    supportsInject: options.supportsInject !== false,
    supportsSteer: options.supportsSteer === true,
    running: true,
    async start() {
      pool.running = true;
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
    async injectItems() {
      return { injected: 0, skipped: 'unsupported' };
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
        calls.push({ kind: 'runTurn', memberId, text: turnOptions.text, attachments: turnOptions.attachments, turnId });
        try {
          if (options.turnMs) await new Promise((r) => setTimeout(r, options.turnMs));
          if (active.cancelled) {
            // A cancelled turn returns whatever it had: the engine must carry the
            // text over rather than pretend it was read.
            return { text: '', usage: {}, interrupted: true };
          }
          const reply = typeof options.reply === 'function' ? options.reply(memberId, turnOptions) : options.reply;
          return { text: reply === undefined ? `[${memberId}] ok` : reply, usage: {} };
        } finally {
          state.running.delete(memberId);
        }
      });
    },
    async stop() {
      pool.running = false;
    },
  };
  return pool;
}

/** Build a connected room with a stubbed pool, no ticker unless asked. */
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

const turnTexts = (pool, memberId) => pool.calls.filter((c) => c.kind === 'runTurn' && c.memberId === memberId).map((c) => c.text);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const problems = [];
  const check = (label, ok, detail) => {
    if (!ok) problems.push(`${label}${detail === undefined ? '' : `: ${detail}`}`);
  };

  // ---- 1. capture records nothing but bookkeeping -------------------------
  {
    const { room, pool } = makeRoom();
    await room.connect();
    const before = pool.calls.filter((c) => c.kind === 'runTurn').length;
    room.append({ authorId: 'user', authorLabel: '你', text: '第一句', kind: 'user', mentions: [] });
    const turns = pool.calls.filter((c) => c.kind === 'runTurn').length - before;
    check('s1 append starts no turn', turns === 0, `saw ${turns}`);
    const alpha = room.members.find((m) => m.id === 'alpha');
    const beta = room.members.find((m) => m.id === 'beta');
    check('s1 record reached every non-author buffer', alpha.segments.length === 1 && beta.segments.length === 1);
    check(
      's1 buffer holds the formatted line',
      alpha.segments[0].lines[0].includes('[用户] 第一句'),
      JSON.stringify(alpha.segments[0].lines),
    );
  }

  // ---- 2 & 3. first message immediate, later messages wait for the tick ----
  {
    const { room, pool } = makeRoom();
    await room.connect();
    const first = await room.say('大家好');
    check('s2 first message served now', first.delivered.length >= 1, JSON.stringify(first.delivered));
    check('s2 first message produced turns', pool.calls.filter((c) => c.kind === 'runTurn').length >= 1);
    const afterFirst = pool.calls.filter((c) => c.kind === 'runTurn').length;
    await room.say('再说一句');
    check('s2 second message does not serve immediately', pool.calls.filter((c) => c.kind === 'runTurn').length === afterFirst);
    await room._tick();
    const served = pool.calls.filter((c) => c.kind === 'runTurn').length;
    check('s2 tick serves the pending segment', served > afterFirst, `${served} vs ${afterFirst}`);
    const [, secondTurn] = turnTexts(pool, 'alpha');
    check('s3 injected line carries a clock', /\[\d{2}:\d{2}:\d{2}\] \[用户\] 再说一句/.test(secondTurn), secondTurn);
    check('s3 body announces the room broadcast', secondTurn.includes('[房间广播]'));
  }

  // ---- 2b. `@` is served immediately, and only to the named member --------
  {
    const { room, pool } = makeRoom();
    await room.connect();
    await room.say('开场');
    const baseline = pool.calls.filter((c) => c.kind === 'runTurn').length;
    const result = await room.say('@beta 你怎么看？');
    const runs = pool.calls.filter((c) => c.kind === 'runTurn').slice(baseline);
    check('s2b @ served immediately', runs.length === 1, JSON.stringify(runs.map((r) => r.memberId)));
    check('s2b @ served only the named member', runs[0] && runs[0].memberId === 'beta', JSON.stringify(runs.map((r) => r.memberId)));
    check(
      's3b named member is told this segment points at it',
      runs[0].text.includes('这一段点到了你'),
      runs[0].text.slice(-160),
    );
    check('s2b say reports who it served', result.delivered.length === 1 && result.delivered[0].memberId === 'beta');
  }

  // ---- 4. merge rule: unread segment absorbs, running one does not ---------
  {
    const { room } = makeRoom({ pool: { turnMs: 200 } });
    await room.connect();
    // `say` awaits the turns it starts, so fire it without awaiting: the point
    // of this scenario is the window where the member IS reading.
    const opening = room.say('第一条');
    await delay(30);
    const alpha = room.members.find((m) => m.id === 'alpha');
    check('s4 the member is reading', !!alpha.running, String(alpha.running && alpha.running.id));
    room.append({ authorId: 'user', authorLabel: '你', text: '第二条', kind: 'user', mentions: [] });
    room.append({ authorId: 'user', authorLabel: '你', text: '第三条', kind: 'user', mentions: [] });
    check('s4 content while reading queues behind', alpha.segments.length === 1, `queued ${alpha.segments.length}`);
    check(
      's4 the queued segment merges the two later lines',
      alpha.segments[0].lines.length === 2,
      JSON.stringify(alpha.segments[0].lines),
    );
    // Ask the busy member for its next segment directly rather than through a
    // tick: `say` serves its targets one after another, so beta/gamma are still
    // free and a tick would spend this window on them.
    const refused = await room._deliver(alpha);
    check('s4 busy member refuses a second segment', refused && refused.skipped === 'busy', JSON.stringify(refused));
    check('s4 the queue is untouched by the refusal', alpha.segments.length === 1, `queued ${alpha.segments.length}`);
    check('s4 no interleaved turn for the busy member', turnTexts(room.pool, 'alpha').length === 1);
    await opening;
  }

  // ---- 4b. attachments ride the segment all the way to the pool ------------
  // The link between "the record has an attachment" and "the turn was given it"
  // is `_runSegment` -> `pool.runTurn({ attachments })`. Nothing else checks it:
  // `attachments.cjs` stops at `_formatRecord` (the text a member reads) and
  // `codex-input.cjs` starts at `buildInput` (text -> input). If this handover
  // were dropped, codex would never get `localImage` and the agent would be
  // told a picture exists but handed no image — with every test still green.
  {
    const { room, pool } = makeRoom();
    await room.connect();
    const files = [
      { id: 'f1', name: 'shot.png', bytes: 2048, mediaType: 'image/png', isImage: true, path: '/tmp/f1.png' },
      { id: 'f2', name: 'notes.md', bytes: 12, mediaType: 'text/markdown', isImage: false, path: '/tmp/f2.md' },
    ];
    await room.say('@alpha 看附件', { attachments: files });
    const turn = pool.calls.filter((c) => c.kind === 'runTurn' && c.memberId === 'alpha')[0];
    check('s4b the turn was given the attachments', !!turn && Array.isArray(turn.attachments) && turn.attachments.length === 2, JSON.stringify(turn && turn.attachments));
    check(
      's4b the paths survived the segment handover',
      !!turn && turn.attachments.map((a) => a.path).join(',') === '/tmp/f1.png,/tmp/f2.md',
      JSON.stringify(turn && turn.attachments.map((a) => a.path)),
    );
    // Coalescing must not lose them either: the merged segment is what the next
    // turn is built from, so a merge that dropped `attachments` would silently
    // un-attach a file the moment two messages were batched.
    const beta = room.members.find((m) => m.id === 'beta');
    beta.segments = [];
    room.append({ authorId: 'user', authorLabel: '你', text: 'a', kind: 'user', mentions: [], attachments: [files[0]] });
    room.append({ authorId: 'user', authorLabel: '你', text: 'b', kind: 'user', mentions: [], attachments: [files[1]] });
    check('s4b a merge keeps both sets of attachments', beta.segments.length === 1 && (beta.segments[0].attachments || []).length === 2, JSON.stringify(beta.segments.map((s) => (s.attachments || []).length)));
    // A record with no attachments must not invent any. A fresh room, because
    // `append` captures to EVERY member: alpha's buffer already holds the two
    // attachment records above, and a merge would (correctly) bring them along.
    const fresh = makeRoom();
    await fresh.room.connect();
    await fresh.room.say('@alpha 纯文字');
    const plain = fresh.pool.calls.filter((c) => c.kind === 'runTurn' && c.memberId === 'alpha')[0];
    check('s4b a plain message gives the pool an empty list, not undefined', !!plain && Array.isArray(plain.attachments) && plain.attachments.length === 0, JSON.stringify(plain && plain.attachments));
  }

  // ---- 5. truncation closes a segment instead of growing it ----------------
  {
    const { room, pool } = makeRoom({ maxSegmentChars: 120 });
    await room.connect();
    // Fill one member's buffer past the cap without serving it: the room has
    // already been opened, so `append` (not `say`) is the capture path.
    room.append({ authorId: 'user', authorLabel: '你', text: '开场', kind: 'user', mentions: [] });
    const alpha = room.members.find((m) => m.id === 'alpha');
    alpha.segments = [];
    for (let i = 0; i < 6; i += 1) {
      room.append({ authorId: 'user', authorLabel: '你', text: `第 ${i} 条比较长的消息内容内容内容内容内容`, kind: 'user', mentions: [] });
    }
    check('s5 long content splits into several segments', alpha.segments.length > 1, `segments ${alpha.segments.length}`);
    for (const segment of alpha.segments) {
      check('s5 every segment respects the cap', segment.chars <= 120 + 60, `${segment.chars}`);
    }
    const before = pool.calls.filter((c) => c.kind === 'runTurn').length;
    await room._tick();
    const after = pool.calls.filter((c) => c.kind === 'runTurn').length - before;
    check('s5 one tick hands over exactly one segment per member', after <= room.members.length, `runs ${after}`);
  }

  // ---- 5b. queue is bounded, and bounds it by merging, not by dropping -----
  {
    const { room } = makeRoom({ maxQueuedSegments: 2, maxSegmentChars: 100000, pool: { turnMs: 40 } });
    await room.connect();
    const alpha = room.members.find((m) => m.id === 'alpha');
    // Five sealed segments by hand: exactly what a wedged turn produces.
    for (let i = 0; i < 5; i += 1) {
      alpha.segments.push({
        id: `manual-${i}`,
        lines: [`line ${i}`],
        chars: 10,
        firstSeq: i,
        lastSeq: i,
        createdAt: Date.now(),
        sealedAt: Date.now(),
        mentions: new Set(),
        attachments: [{ id: `m${i}`, name: `f${i}.png`, bytes: 10, mediaType: 'image/png', isImage: true, path: `/tmp/f${i}.png` }],
      });
    }
    room._boundQueue(alpha);
    check('s5b backlog is bounded', alpha.segments.length <= 2, `segments ${alpha.segments.length}`);
    check('s5b bounding merged instead of shedding', alpha.shed === 0 && alpha.segments[0].lines.length > 1, JSON.stringify(alpha.segments[0].lines));
    // Bounding MERGES segments, and the merged segment is what the next turn is
    // built from — so a merge that dropped `attachments` would silently detach a
    // file exactly when the room is under load, which is when it is least
    // visible. Counted across ALL surviving segments rather than on the first
    // one: bounding cascades (5 segments -> merge -> merge -> 2), so how many
    // land in `segments[0]` is an implementation detail, while "all five files
    // are still somewhere in the queue" is the property that matters.
    const surviving = alpha.segments.reduce((sum, s) => sum + (s.attachments || []).length, 0);
    check('s5b merging keeps every attachment from both halves', surviving === 5, `${surviving} of 5: ${JSON.stringify(alpha.segments.map((s) => (s.attachments || []).length))}`);
  }

  // ---- 6. `@` steers into a running codex turn (and bypasses the queue) ----
  {
    const { room, pool } = makeRoom({ pool: { supportsSteer: true, turnMs: 400 } });
    await room.connect();
    const opening = room.say('开场'); // alpha/beta/gamma all start reading
    await delay(30); // let the opening reach the turn: `say` awaits it
    const steerStart = Date.now();
    const result = await room.say('@alpha 立刻补充一句');
    const elapsed = Date.now() - steerStart;
    const steers = pool.calls.filter((c) => c.kind === 'steer');
    check('s6 @ steered the busy member', steers.length === 1 && steers[0].memberId === 'alpha', JSON.stringify(steers));
    check('s6 steer carried the new text', !!steers[0] && steers[0].text.includes('立刻补充一句'), steers[0] && steers[0].text);
    check('s6 steer did not wait for the turn to finish', elapsed < 350, `${elapsed}ms`);
    check(
      's6 steer produced no phantom record',
      result.delivered.length === 1 && !result.delivered[0].record,
      JSON.stringify(result.delivered),
    );
    check('s6 steered counter is surfaced', room.snapshot().members.find((m) => m.id === 'alpha').steered === 1);
    await opening;
  }

  // ---- 7. no steering -> cancel + carry the text into the next delivery ----
  {
    const { room, pool } = makeRoom({ pool: { supportsSteer: false, turnMs: 50 } });
    await room.connect();
    const opening = room.say('开场');
    await delay(20);
    const alpha = room.members.find((m) => m.id === 'alpha');
    check('s7 the member is reading', !!alpha.running, String(alpha.running && alpha.running.id));
    await room.say('@alpha 现在就说');
    check('s7 the turn was interrupted', pool.calls.some((c) => c.kind === 'interrupt' && c.memberId === 'alpha'));
    check('s7 interrupted text is carried over', alpha.carryOver.includes('开场'), alpha.carryOver);
    check('s7 preempted counter is surfaced', room.snapshot().members.find((m) => m.id === 'alpha').preempted >= 1);
    // Wait for the interrupted turn to settle, then let the carryOver go out.
    await opening;
    await delay(120);
    await room._tick();
    const texts = turnTexts(pool, 'alpha');
    check('s7 carryOver is prepended to the next turn', texts.length >= 2 && texts[1].includes('开场'), JSON.stringify(texts.map((t) => t.slice(0, 40))));
    check('s7 carryOver is cleared after use', alpha.carryOver === '');
  }

  // ---- 8. a wedged turn is interrupted once, then its queue is freed -------
  {
    const { room } = makeRoom({ queueStallMs: 1000, pool: { turnMs: 10000 } });
    await room.connect();
    // A turn that never settles: exactly the shape the user hit at the codex
    // app-server (73s, no drain). Do not await it.
    const opener = room.say('开场');
    await delay(30);
    const alpha = room.members.find((m) => m.id === 'alpha');
    check('s8 the member is reading', !!alpha.running);
    const startedAt = alpha.running.startedAt;
    check('s8 the running segment is stamped', typeof startedAt === 'number', String(startedAt));
    // Nothing is wedged yet.
    await room._enforceStall(startedAt + 500);
    check('s8 no warning before the deadline', (alpha.stalls || 0) === 0 && alpha.stallWarned === false);
    // Past the deadline: warn + interrupt once.
    await room._enforceStall(startedAt + 1500);
    check('s8 a stall is reported', alpha.stalls === 1, `stalls ${alpha.stalls}`);
    check('s8 the wedged turn is interrupted', room.pool.calls.some((c) => c.kind === 'interrupt' && c.memberId === 'alpha'));
    check('s8 the hold is still in place (queue not freed yet)', !!alpha.running);
    // Still wedged well past it: free the queue, requeue the text.
    const before = room.pool.calls.filter((c) => c.kind === 'interrupt').length;
    await room._enforceStall(startedAt + 5000);
    check('s8 the queue is freed', alpha.running === null && !room.busy.has('alpha'));
    check('s8 the text is requeued, not lost', alpha.carryOver.includes('开场'), alpha.carryOver);
    check('s8 stall is counted again', alpha.stalls === 2, `stalls ${alpha.stalls}`);
    const after = room.pool.calls.filter((c) => c.kind === 'interrupt').length;
    check('s8 interrupt is never sent twice for one turn', after === before, `${before} -> ${after}`);
    // The wedged promise never settles, so let the process forget it.
    opener.catch(() => {});
  }

  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
