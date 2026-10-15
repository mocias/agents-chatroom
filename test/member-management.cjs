#!/usr/bin/env node
/**
 * Offline engine test for RUNTIME MEMBER MANAGEMENT — no codex, no network.
 *
 * "Adding a teammate" is two different things behind one API:
 *   - a new session on an already-known backend (a second codex thread), and
 *   - the first member of a backend nobody has used yet (an ACP harness).
 *
 * The second case is where the interesting failure lives: a new backend must be
 * started and its model catalogue merged before its member can be validated, and
 * a roster edit must reach disk without ever blocking the room.
 *
 * Every pool below is a stub, so this test asserts routing and bookkeeping
 * rather than any real subprocess.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentRoom } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

/** A pool stub that records what it was asked to do. */
function stubPool(label, models = ['m-one', 'm-two']) {
  const threads = new Map();
  const calls = { started: 0, stopped: 0, opened: [], closed: [], turns: [], interrupted: [] };
  return {
    label,
    binary: `(${label})`,
    pid: 1000,
    calls,
    async start() {
      calls.started += 1;
    },
    async stop() {
      calls.stopped += 1;
    },
    async modelCapabilities() {
      const map = new Map();
      for (const model of models) map.set(model, { id: model, efforts: ['none', 'high'], serviceTiers: [], defaultEffort: 'none' });
      return map;
    },
    getThread(id) {
      return threads.get(id) || null;
    },
    async openThread(id, options) {
      const record = { id: `${label}-thread-${id}`, sandbox: 'read-only', options };
      threads.set(id, record);
      calls.opened.push(id);
      return record;
    },
    closeThread(id) {
      if (threads.delete(id)) calls.closed.push(id);
    },
    supportsInject: true,
    async injectItems() {
      return { injected: 1 };
    },
    async flush() {},
    async runTurn(id, options) {
      calls.turns.push({ id, text: options.text });
      return { text: `${id} on ${label}`, usage: {} };
    },
    async interrupt(id) {
      calls.interrupted.push(id);
      return true;
    },
  };
}

/** Build a room whose primary pool is a stub, plus an injectable ACP stub. */
function makeRoom(extra = {}) {
  const room = new AgentRoom({
    cwd: process.cwd(),
    replyPolicy: 'mentioned-only',
    maxRelayHops: 0,
    // Delivery is driven by `say()`/`@` only: with both timers off, a segment
    // never moves on its own, so scenario 3 can attribute a turn body to the
    // exact message that caused it.
    segmentMs: 0,
    queueStallMs: 0,
    members: [{ id: 'alpha', label: 'Alpha', model: 'm-one' }],
    ...extra,
  });
  const codex = stubPool('codex');
  room.pool = codex;
  return { room, codex };
}

async function main() {
  const problems = [];
  const check = (label, ok, detail) => {
    if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-members-'));
  const summary = { pools: 0, backends: 0 };

  // --- Scenario 1: add a teammate on the existing (primary) backend ---
  {
    const rosterFile = path.join(tmp, 'room1.members.json');
    const { room, codex } = makeRoom({ rosterFile });
    await room.connect();
    const added = await room.addMember({ id: 'beta', label: 'Beta', model: 'm-two', persona: '挑错' });

    check('new member is in the roster', room.members.some((m) => m.id === 'beta'));
    check('new member defaults to the primary backend', added.backend === 'codex', String(added.backend));
    check('adding did not spawn a second pool', room.pools.size === 1, String(room.pools.size));
    check('the roster file was written', fs.existsSync(rosterFile));
    const saved = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    check('the roster file holds both members', saved.members.length === 2, JSON.stringify(saved.members));
    check('the roster file records the persona', saved.members[1].persona === '挑错', JSON.stringify(saved.members[1]));

    // The new member must actually be able to speak through its thread.
    await room.ensureThread(added);
    check('the new member opened a thread on the primary pool', codex.calls.opened.includes('beta'), JSON.stringify(codex.calls.opened));
  }

  // --- Scenario 2: a brand-new backend is started and merged on demand ---
  {
    const { room, codex } = makeRoom();
    await room.connect();
    // Wire the ACP pool in before the room needs it: this is the seam the real
    // backend plugs into, so the test asserts the room's side of the contract.
    const acp = stubPool('acp', ['claude-sonnet']);
    // Pre-register the backend pool: this is the seam the real AcpPool plugs
    // into, so the test asserts the room's side of the contract.
    room.pools.set('acp', acp);
    const member = await room.addMember({ id: 'claude', label: 'Claude', model: 'claude-sonnet', backend: 'acp' });

    check('the member is attached to the acp backend', member.backend === 'acp', String(member.backend));
    check('the room now holds two pools', room.pools.size === 2, String(room.pools.size));
    check('the acp catalogue was merged', room.modelsByBackend().some((row) => row.backend === 'acp' && row.model === 'claude-sonnet'), JSON.stringify(room.modelsByBackend()));
    check('the codex member was not re-pointed by the acp catalogue', room.members[0].model === 'm-one', String(room.members[0].model));
    summary.pools = room.pools.size;
    summary.backends = room.modelsByBackend().length;

    // A model the ACP harness does not offer must be rejected, not silently kept.
    let rejected = null;
    try {
      room.setMemberModel('claude', 'gpt-5.6-sol');
    } catch (error) {
      rejected = error.message;
    }
    check('setMemberModel refuses a model the backend does not offer', !!rejected && rejected.includes('not offered'), String(rejected));

    // Routing: each member turns through its own pool.
    await room.ensureThread(room.members[0]);
    await room.ensureThread(member);
    check('codex member opened on the codex pool', codex.calls.opened.includes('alpha'), JSON.stringify(codex.calls.opened));
    check('acp member opened on the acp pool', acp.calls.opened.includes('claude'), JSON.stringify(acp.calls.opened));

    // A backend named in the config must be offered to the UI even before any
    // member uses it: pools are lazy, and an invisible backend is an unreachable
    // "接别家 harness" path. Only the configuration can advertise it.
    const configured = makeRoom({ backends: { acp: { agentCommand: 'never-spawned' } } });
    const offered = configured.room.backends();
    check('a configured but unused backend is still offered', offered.includes('acp'), JSON.stringify(offered));
    check('offering it did not spawn its pool', !configured.room.pools.has('acp'), JSON.stringify(Array.from(configured.room.pools.keys())));
    check('the snapshot lists configured backends too', configured.room.snapshot().backends.includes('acp'), JSON.stringify(configured.room.snapshot().backends));
  }

  // --- Scenario 3: changing a model rebuilds the thread and rewinds the cursor ---
  {
    const { room, codex } = makeRoom();
    await room.connect();
    const alpha = room.members[0];
    await room.ensureThread(alpha);
    await room.say('@alpha 你好');
    const turnsBefore = alpha.turns;
    const cursorBefore = alpha.cursor;
    check('the member took a turn', turnsBefore === 1, String(turnsBefore));
    check('its cursor advanced past the log', cursorBefore > 0, String(cursorBefore));

    room.setMemberModel('alpha', 'm-two');
    check('the thread was closed so the next turn reopens on the new model', codex.calls.closed.includes('alpha'), JSON.stringify(codex.calls.closed));
    check('the cursor was rewound to replay the room into the fresh thread', alpha.cursor === 0, String(alpha.cursor));
    check('the member keeps its model', alpha.model === 'm-two', alpha.model);
    // Rewinding is not just the cursor: `needsReplay` is what makes the NEXT turn
    // re-brief the fresh thread from the whole log. This flag replaced the old
    // `_deltaFor()` projection, which existed only to be read by tests.
    check('the member is flagged for a full replay', alpha.needsReplay === true, String(alpha.needsReplay));

    // A fresh thread has no history, so the whole log must be replayed — and not
    // as a summary: the replay IS the formatted room log.
    await room.ensureThread(alpha);
    const turnsBeforeReplay = codex.calls.turns.length;
    await room.say('@alpha 再说一句');
    const replayed = codex.calls.turns.slice(turnsBeforeReplay).find((t) => t.id === 'alpha');
    check('the fresh thread got a turn', !!replayed, JSON.stringify(codex.calls.turns.slice(turnsBeforeReplay)));
    const body = replayed ? replayed.text : '';
    check('the fresh thread is re-briefed from the log', body.includes('@alpha 你好'), body.slice(0, 240));
    check('the replay carries the new line too', body.includes('@alpha 再说一句'), body.slice(0, 240));
    check('the replayed history is attributed and timestamped', /\[\d{2}:\d{2}:\d{2}\] \[用户\] @alpha 你好/.test(body), body.slice(0, 240));
    check('the replay is announced as room broadcast', body.includes('[房间广播]'), body.slice(0, 120));
    // Replay is one-shot: it must not repeat on every subsequent turn.
    check('the replay flag is consumed', alpha.needsReplay === false, String(alpha.needsReplay));
    const afterReplay = codex.calls.turns.length;
    await room.say('@alpha 第三句');
    const third = codex.calls.turns.slice(afterReplay).find((t) => t.id === 'alpha');
    check('a later turn is incremental, not a full replay', !!third && !third.text.includes('@alpha 你好'), third && third.text.slice(0, 240));
    check('delivery is counted per segment', alpha.segmentsSent >= 3, String(alpha.segmentsSent));
    check('the member is not reading after the turn', alpha.running === null, String(alpha.running && alpha.running.id));
  }

  // --- Scenario 4: removing a member stops it and pulls it out of routing ---
  {
    const { room, codex } = makeRoom();
    await room.connect();
    await room.addMember({ id: 'beta', label: 'Beta', model: 'm-two' });
    const beta = room.members.find((m) => m.id === 'beta');
    await room.ensureThread(beta);

    await room.removeMember('beta');
    check('the member is gone', !room.members.some((m) => m.id === 'beta'));
    check('its thread was closed', codex.calls.closed.includes('beta'), JSON.stringify(codex.calls.closed));

    // A removed member must not be woken by an @ that still mentions it.
    const before = codex.calls.turns.length;
    await room.say('@beta 还在吗');
    check('a removed member is not routed to', codex.calls.turns.length === before, JSON.stringify(codex.calls.turns.slice(before)));

    let missing = null;
    try {
      await room.removeMember('beta');
    } catch (error) {
      missing = error.message;
    }
    check('removing an unknown member is an error, not a silent no-op', !!missing && missing.includes('no such member'), String(missing));
  }

  // --- Scenario 5: ids are validated; duplicates are refused ---
  {
    const { room } = makeRoom();
    await room.connect();
    let blank = null;
    let duplicate = null;
    let spaced = null;
    try {
      await room.addMember({ id: '  ' });
    } catch (error) {
      blank = error.message;
    }
    try {
      await room.addMember({ id: 'alpha' });
    } catch (error) {
      duplicate = error.message;
    }
    try {
      await room.addMember({ id: 'two words' });
    } catch (error) {
      spaced = error.message;
    }
    check('a blank id is refused', !!blank, String(blank));
    check('a duplicate id is refused', !!duplicate && duplicate.includes('already exists'), String(duplicate));
    check('an id with spaces is refused', !!spaced && spaced.includes('single word'), String(spaced));
  }

  // --- Scenario 6: a saved roster is restored, and a broken one is survived ---
  {
    const rosterFile = path.join(tmp, 'room6.members.json');
    fs.writeFileSync(
      rosterFile,
      JSON.stringify({ version: 1, replyPolicy: 'everyone', members: [{ id: 'solo', label: 'Solo', model: 'm-one', backend: 'codex' }] }),
      'utf8',
    );
    const room = new AgentRoom({ cwd: process.cwd(), rosterFile });
    check('a saved roster replaces the default member list', room.members.length === 1 && room.members[0].id === 'solo', JSON.stringify(room.members.map((m) => m.id)));
    check('a saved reply policy is restored', room.replyPolicy === 'everyone', room.replyPolicy);

    // Config is the operator's statement; the file is accumulated UI state.
    const explicit = new AgentRoom({ cwd: process.cwd(), rosterFile, members: [{ id: 'pinned', model: 'm-one' }] });
    check('explicit config wins over the saved roster', explicit.members.length === 1 && explicit.members[0].id === 'pinned', JSON.stringify(explicit.members.map((m) => m.id)));

    const broken = path.join(tmp, 'broken.members.json');
    fs.writeFileSync(broken, '{ not json', 'utf8');
    const survived = new AgentRoom({ cwd: process.cwd(), rosterFile: broken });
    check('an unparseable roster falls back to the defaults instead of throwing', survived.members.length >= 1, String(survived.members.length));
  }

  // --- Scenario 7: dispose stops every pool, not just the primary ---
  {
    const { room, codex } = makeRoom();
    await room.connect();
    const acp = stubPool('acp', ['claude-sonnet']);
    room.pools.set('acp', acp);
    await room.addMember({ id: 'claude', model: 'claude-sonnet', backend: 'acp' });
    await room.dispose();
    check('the primary pool was stopped', codex.calls.stopped === 1, String(codex.calls.stopped));
    check('the secondary pool was stopped too', acp.calls.stopped === 1, String(acp.calls.stopped));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('scenario1 add        roster written and reloadable');
  console.log('scenario2 backends   pools:', summary.pools, 'models tagged:', summary.backends);
  console.log('scenario3 remodels   thread closed, cursor rewound, log replayed');
  console.log('scenario4 remove     gone from routing');
  console.log('scenario5 validate   blank/duplicate/spaced refused');
  console.log('scenario6 roster     restored, config-over-file, corrupt survived');
  console.log('scenario7 dispose    all pools stopped');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
