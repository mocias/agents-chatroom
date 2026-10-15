#!/usr/bin/env node
/**
 * Integration test: an ACP member inside a real room.
 *
 * `test/acp-backend-smoke.cjs` proves `AcpPool` is a correct ACP client. This
 * file proves the other half — that `room.cjs` can run a room whose members are
 * on the `acp` backend, through the same engine paths as codex members.
 *
 * The interesting asymmetry is preemption. `AcpPool` cannot inject and has no
 * `steer`, so an `@` that arrives while an ACP member is mid-turn cannot be
 * folded into the running turn: the room cancels it and carries the text over
 * (`preempted`). Codex members take the other branch (`steered`). Delivery
 * itself is the SAME channel for both backends: a record is captured into the
 * member's segment buffer and handed over as one batched turn, so ACP is not
 * degraded to a per-record replay anymore — it was never a replay, it was the
 * absence of the push channel.
 *
 * Fully offline: the agent is `test/acp-fixture.cjs`, run on the bundled node.
 */
'use strict';

const path = require('node:path');
const { AgentRoom } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRoom(overrides = {}) {
  return new AgentRoom({
    id: 'acp-room',
    cwd: path.join(__dirname, '..'),
    backend: 'acp',
    backends: {
      acp: { agentCommand: process.execPath, agentArgs: [path.join(__dirname, 'acp-fixture.cjs')] },
    },
    members: [
      { id: 'fix', label: 'Fixture', model: 'fixture-a', persona: '你负责复述。' },
      { id: 'fix2', label: 'Fixture2', model: 'fixture-b', persona: '你负责复述。' },
    ],
    replyPolicy: 'mentioned-only',
    maxRelayHops: 0,
    // Both timers off: delivery is driven by `say()`/`@` and an explicit
    // `await room._tick()`, so nothing moves in the background while a real
    // agent subprocess is being talked to.
    segmentMs: 0,
    queueStallMs: 0,
    ...overrides,
  });
}

async function main() {
  const room = makeRoom();

  // --- the room connects on a non-codex primary backend ---------------------
  await room.connect();
  check('the room connects with acp as its primary backend', room.ready === true);
  check('the acp backend is the only pool', room.backends().join(',') === 'acp', room.backends().join(','));
  const models = room.modelsByBackend();
  check('the model catalogue is tagged with the backend', models.every((row) => row.backend === 'acp'), JSON.stringify(models));
  check('both fixture models are advertised', models.length === 2, JSON.stringify(models));
  check('no member was "corrected" off an advertised model', room.members.every((m) => !m.error), room.members.map((m) => m.id + ':' + m.error).join(' '));
  // An ACP-only room must not describe its agent as codex.
  const snap = room.snapshot();
  check('the snapshot names the real primary backend', snap.backend === 'acp' && snap.binary && !snap.codexPid,
    `backend=${snap.backend} pid=${snap.pid} codexPid=${snap.codexPid}`);

  // --- one member speaks; the other is captured, not pushed ----------------
  const said = await room.say('@fix 记住暗号 ZEBRA-7');
  check('the addressed member answered', said.delivered.length === 1 && said.delivered[0].memberId === 'fix', JSON.stringify(said.delivered.map((d) => d.memberId)));
  await sleep(250);
  const fix2 = room.members.find((m) => m.id === 'fix2');
  // ACP cannot be pushed to, and R3 does not push anyway: the record lands in
  // fix2's segment buffer and waits for fix2's own turn. Being quiet is not the
  // same as being deaf, so the buffer must actually hold the line.
  check('the unaddressed ACP member was not woken', fix2.running === null, String(fix2.running && fix2.running.id));
  check(
    'the unaddressed ACP member buffered the record instead',
    fix2.segments.flatMap((s) => s.lines).join('\n').includes('ZEBRA-7'),
    JSON.stringify(fix2.segments.flatMap((s) => s.lines)),
  );
  check('the buffered record was not lost in flight', fix2.carryOver === '', JSON.stringify(fix2.carryOver));

  // --- the transcript still reaches the listener, on its own turn -----------
  await room.say('@fix2 第一轮');
  await sleep(250);
  await room.say('@fix2 RECALL');
  await sleep(250);

  const fix2Replies = room.log.filter((r) => r.authorId === 'fix2').map((r) => r.text);
  const recall = fix2Replies[fix2Replies.length - 1] || '';
  check('the listener was woken by its own mention', fix2Replies.length === 2, String(fix2Replies.length));
  check(
    'the earlier public record reached the ACP member through its segment',
    /ZEBRA-7/.test(recall),
    recall.slice(0, 160),
  );
  check('attribution survived the segment handover ([用户] / [@fix])', /\[用户\]/.test(recall) && /\[@fix\]/.test(recall), recall.slice(0, 200));
  check('the handover did not misattribute a peer line to the reader', !/\[你自己 @fix\]/.test(recall), recall.slice(0, 200));
  check('the ACP member is not left reading', fix2.running === null, String(fix2.running && fix2.running.id));
  check('both ACP turns were counted as segments', fix2.segmentsSent === 2, String(fix2.segmentsSent));

  // --- ACP members stay on their own session (no cross-talk) ---------------
  const fixReplies = room.log.filter((r) => r.authorId === 'fix').map((r) => r.text);
  check(
    'each member speaks from its own ACP session',
    fixReplies[0].includes('fixture-') && recall.includes('fixture-') && fixReplies[0].match(/fixture-\d+/)[0] !== recall.match(/fixture-\d+/)[0],
    `${fixReplies[0].slice(0, 24)} vs ${recall.slice(0, 24)}`,
  );

  // --- thread reuse: the second turn must not cold-start a new session ------
  check(
    'the second turn reused the same ACP session (no cold start)',
    recall.match(/fixture-\d+/)[0] === fix2Replies[0].match(/fixture-\d+/)[0],
    `${fix2Replies[0].match(/fixture-\d+/)[0]} -> ${recall.match(/fixture-\d+/)[0]}`,
  );

  // --- adding an ACP member at runtime -------------------------------------
  const added = await room.addMember({ id: 'fix3', label: 'Fixture3', model: 'fixture-b', backend: 'acp' });
  check('an ACP member can be added at runtime', added.id === 'fix3' && added.backend === 'acp', added.backend);
  check('the new member is in the roster', room.members.some((m) => m.id === 'fix3'));
  const third = await room.say('@fix3 你好');
  check('the new ACP member can speak on its first turn', third.delivered.some((d) => d.memberId === 'fix3'), JSON.stringify(third.delivered.map((d) => d.memberId)));

  // --- removing it closes its session --------------------------------------
  await room.removeMember('fix3');
  check('the removed ACP member is gone from the roster', !room.members.some((m) => m.id === 'fix3'));
  const after = await room.say('@fix3 还在吗');
  check('a removed member is no longer woken', !after.delivered.some((d) => d.memberId === 'fix3'), JSON.stringify(after.delivered.map((d) => d.memberId)));

  // --- changing the model re-opens a session with the new model ------------
  const before = room.log.filter((r) => r.authorId === 'fix').length;
  room.setMemberModel('fix', 'fixture-b');
  await room.say('@fix 换模型后再答一次');
  await sleep(250);
  const newest = room.log.filter((r) => r.authorId === 'fix').slice(before).map((r) => r.text).join(' ');
  check('the new model is actually in use after a switch', /\[model=fixture-b/.test(newest), newest.slice(-80));

  // --- an agent that reveals its catalogue ONLY in session/new --------------
  // This is the REAL shape: dsh-acp has no `initialize` model list at all, so a
  // pool's pre-session catalogue is empty. The room must not read that
  // emptiness as "this backend offers nothing but a placeholder" — doing so
  // re-labelled every ACP member's model to the synthetic `acp-default`, showed
  // a bogus "model ... not offered" error, and (worst) asked the agent for a
  // model that does not exist, so the configured model was never applied.
  const quiet = makeRoom({
    id: 'acp-quiet',
    backends: {
      acp: {
        agentCommand: process.execPath,
        agentArgs: [path.join(__dirname, 'acp-fixture.cjs'), '--quiet-models'],
      },
    },
    members: [{ id: 'shy', label: 'Shy', model: 'fixture-a', persona: '你负责复述。' }],
    replyPolicy: 'addressed',
  });
  await quiet.connect();
  const shy = quiet.members[0];
  check(
    'a member keeps its configured model when the agent has no pre-session catalogue',
    shy.model === 'fixture-a',
    `model=${shy.model} error=${shy.error}`,
  );
  check('no bogus "not offered" error is recorded for that member', !shy.error, String(shy.error));
  check(
    'the synthetic placeholder is not offered as a selectable model',
    quiet.modelsByBackend().every((row) => row.model !== 'acp-default'),
    JSON.stringify(quiet.modelsByBackend()),
  );
  // Opening the session is where the catalogue finally appears; the room must
  // pick it up (for the UI) without re-labelling the member.
  await quiet.say('@shy 介绍一下你自己');
  await sleep(200);
  const learned = quiet.modelsByBackend();
  check(
    'the real catalogue is learned once a session exists',
    learned.some((row) => row.model === 'fixture-a') && learned.some((row) => row.model === 'fixture-b'),
    JSON.stringify(learned),
  );
  check('learning the catalogue did not re-label the member', quiet.members[0].model === 'fixture-a', quiet.members[0].model);
  const shyReply = quiet.log.filter((r) => r.authorId === 'shy').map((r) => r.text).join(' ');
  check(
    'the configured model was actually applied to the session',
    /\[model=fixture-a/.test(shyReply),
    shyReply.slice(-80),
  );
  await quiet.dispose();

  // --- a member added with NO model must not inherit a codex model name -----
  // The blank field means "let the agent decide". Seeding it with codex's
  // `gpt-5.6-sol` would name a model this backend has never heard of, so the
  // first catalogue refresh would "correct" it and show the user a
  // `model gpt-5.6-sol not offered` error for a model they never chose.
  const blank = makeRoom({ id: 'acp-blank', members: [] });
  await blank.connect();
  const nameless = await blank.addMember({ id: 'nameless', label: 'Nameless', backend: 'acp' });
  check('a model-less ACP member does not inherit a codex model name', nameless.model === null, `model=${nameless.model}`);
  check('a model-less ACP member shows no bogus error', !nameless.error, String(nameless.error));
  const namelessTurn = await blank.say('@nameless 你好');
  check(
    'a model-less ACP member can still speak',
    namelessTurn.delivered.some((d) => d.memberId === 'nameless'),
    JSON.stringify(namelessTurn.delivered.map((d) => d.memberId)),
  );
  check(
    'speaking did not back-fill a codex model name onto it',
    blank.members.find((m) => m.id === 'nameless').model === null,
    String(blank.members.find((m) => m.id === 'nameless').model),
  );
  await blank.dispose();

  // A member declared at construction time with no `backend` inherits the room's
  // primary backend (`acp` here), so the same rule must apply without an
  // explicit backend field — this is the `members:` config path.
  const implicit = makeRoom({ id: 'acp-implicit', members: [{ id: 'plain', label: 'Plain', persona: '你负责复述。' }] });
  await implicit.connect();
  check(
    'a member with no backend inherits the primary one without a codex default model',
    implicit.members[0].backend === 'acp' && implicit.members[0].model === null,
    `backend=${implicit.members[0].backend} model=${implicit.members[0].model}`,
  );
  await implicit.dispose();

  // --- `@` on a BUSY ACP member: preempted, never steered -------------------
  // AcpPool reports no `supportsSteer`, so the room cannot fold the new line
  // into the running turn the way it does for codex. The only honest option is
  // to cancel and carry the text over — losing it would be the bug this pins.
  const preemptRoom = makeRoom({
    id: 'acp-preempt',
    backends: {
      acp: {
        agentCommand: process.execPath,
        agentArgs: [path.join(__dirname, 'acp-fixture.cjs'), '--slow', '1500'],
      },
    },
    members: [{ id: 'busy', label: 'Busy', model: 'fixture-a', persona: '你负责复述。' }],
  });
  await preemptRoom.connect();
  const busyMember = preemptRoom.members[0];
  const opening = preemptRoom.say('@busy 慢慢说').catch(() => null);
  await sleep(150);
  check('the ACP member is mid-turn', !!busyMember.running, String(busyMember.running && busyMember.running.id));

  const interrupted = await preemptRoom.say('@busy 插一句');
  check(
    'an @ on a busy ACP member is preempted, not steered',
    interrupted.delivered.length === 1 && interrupted.delivered[0].preempted === true,
    JSON.stringify(interrupted.delivered),
  );
  check('no steer was attempted on an ACP member', busyMember.steered === 0, String(busyMember.steered));
  check('the preemption is counted', busyMember.preempted === 1, String(busyMember.preempted));
  check(
    'the interrupted turn text is carried over instead of dropped',
    busyMember.carryOver.includes('慢慢说') && busyMember.carryOver.includes('插一句'),
    JSON.stringify(busyMember.carryOver),
  );
  await Promise.race([opening, sleep(4000)]);
  check('the ACP member is released after the cancel', busyMember.running === null, String(busyMember.running && busyMember.running.id));
  check('the room is not left busy', preemptRoom.busy.size === 0, JSON.stringify(Array.from(preemptRoom.busy)));

  // The carried-over text is not a dead end: the next delivery replays it.
  const sentBefore = busyMember.segmentsSent;
  await preemptRoom._tick();
  await sleep(300);
  const carrier = preemptRoom.log.filter((r) => r.authorId === 'busy').map((r) => r.text).join(' ');
  check('the carried-over text is re-delivered on the next turn', busyMember.segmentsSent === sentBefore + 1, `${sentBefore} -> ${busyMember.segmentsSent}`);
  check('the carried-over text reached the agent', /慢慢说/.test(carrier) || busyMember.carryOver === '', `${carrier.slice(-120)} carryOver=${JSON.stringify(busyMember.carryOver)}`);
  await preemptRoom.dispose();

  // --- interrupt safety: a removed member mid-turn must not wedge the room --
  const slow = makeRoom({ members: [{ id: 'slow', label: 'Slow', model: 'fixture-a' }], id: 'acp-slow' });
  await slow.connect();
  const pending = slow.say('@slow 慢慢说').catch(() => null);
  await sleep(80);
  await slow.removeMember('slow');
  await Promise.race([pending, sleep(3000)]);
  check('removing a member mid-turn does not wedge the room', slow.busy.size === 0, JSON.stringify(Array.from(slow.busy)));
  await slow.dispose();

  // --- attachments reach an ACP member as paths in its prompt --------------
  // `attachments.cjs` proves `_formatRecord` writes the path INTO the text, and
  // `codex-input.cjs` proves codex gets a structured `localImage`. Neither proves
  // that an ACP member — which is text-only — actually receives the path, which
  // is the whole delivery mechanism for that backend. `RECALL` makes the fixture
  // echo back the exact prompt text it was handed, so this is the one place the
  // claim can be checked end to end rather than inferred.
  const fileRoom = makeRoom({ members: [{ id: 'filer', label: 'Filer', model: 'fixture-a' }] });
  await fileRoom.connect();
  const attachmentPath = path.join(__dirname, '..', 'public', 'index.html');
  await fileRoom.say('@filer 这是附件', {
    attachments: [
      { id: 'fa', name: 'index.html', bytes: 4096, mediaType: 'text/html', isImage: false, path: attachmentPath },
      { id: 'fb', name: 'pic.png', bytes: 2048, mediaType: 'image/png', isImage: true, path: path.join(__dirname, '..', 'public', 'pic.png') },
    ],
  });
  await sleep(250);
  await fileRoom.say('@filer RECALL');
  await sleep(250);
  const filerReplies = fileRoom.log.filter((r) => r.authorId === 'filer').map((r) => r.text);
  const filerRecall = filerReplies[filerReplies.length - 1] || '';
  check(
    'an ACP member receives the attachment PATH in its prompt',
    filerRecall.includes(attachmentPath),
    filerRecall.slice(0, 240),
  );
  check(
    'an image is called out as an image to a text-only backend',
    /图片/.test(filerRecall) && /pic\.png/.test(filerRecall),
    filerRecall.slice(0, 240),
  );
  check(
    'a plain file is called out as a file',
    /文件/.test(filerRecall) && /index\.html/.test(filerRecall),
    filerRecall.slice(0, 240),
  );
  // The record the human sees still carries the structured entries, so the
  // transcript can render a chip rather than only the path text.
  const fileRecord = fileRoom.log.find((r) => r.authorId === 'user' && r.attachments && r.attachments.length === 2);
  check('the room record keeps both structured attachments', !!fileRecord, JSON.stringify(fileRoom.log.filter((r) => r.authorId === 'user').map((r) => (r.attachments || []).length)));
  await fileRoom.dispose();

  // --- dispose really kills the agent processes -----------------------------
  // Asserting on `pool.pid` would be wrong: neither backend clears its `child`
  // reference on a normal stop (codex returns early once `killed`, ACP nulls it
  // only when it was already dead), so `pid` keeps reporting a dead process.
  // The property that matters is that the OS process is gone.
  const livePids = [];
  for (const pool of room.pools.values()) if (pool.pid) livePids.push(pool.pid);
  await room.dispose();
  await sleep(300);
  const stillAlive = livePids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  check(
    'dispose terminated every agent process',
    livePids.length > 0 && stillAlive.length === 0,
    `pids=${JSON.stringify(livePids)} alive=${JSON.stringify(stillAlive)}`,
  );
  check('dispose marked the room disconnected', room.ready === false);

  console.log('backend    room runs on acp as its primary backend, catalogue tagged');
  console.log('           the snapshot names acp, not codex, for pid/binary');
  console.log('delivery   ACP members ride the same segmented channel as codex');
  console.log('replay     the transcript still reached the listener, attribution intact');
  console.log('isolation  each member has its own session; reuse avoids a cold start');
  console.log('lifecycle  add / remove / re-model all work on ACP members');
  console.log('catalogue  a session-only catalogue is learned without re-labelling members');
  console.log('blank      a model-less ACP member keeps the agent default, not a codex name');
  console.log('safety     removing a member mid-turn leaves the room un-wedged');
  console.log('preempt    @ on a busy ACP member cancels and carries the text over');
  console.log('attach     an attachment PATH reaches a text-only ACP prompt, image/file labelled');
  console.log('teardown   dispose kills the agent processes');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
