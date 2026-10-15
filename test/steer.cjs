#!/usr/bin/env node
/**
 * Mid-turn steering: pushing text into the turn that is running RIGHT NOW.
 *
 * This is the protocol behind the Codex desktop app's 引导 (steer) button:
 * `turn/steer` with the id of the currently active turn. The whole point is
 * that it acts *during* the turn — the model sees a second user message inside
 * the same turn, and the turn is never restarted.
 *
 * The trap this test exists to catch: routing steer through the pool's
 * per-thread queue. `injectItems` and `runTurn` share one promise chain per
 * thread so that a history push cannot be spliced into a turn the model has
 * already begun, and it is tempting to make steer "consistent" with that. But
 * steer's entire purpose is to reach the in-flight turn: queued behind it, the
 * correction would land after the reply it was meant to redirect — the button
 * would report success while doing nothing the user would recognise. `steer`
 * therefore deliberately bypasses `_enqueue`, and scenario 5 is what holds that
 * decision in place.
 *
 * Zero codex: the app-server is `test/stub-app-server.cjs`, a local script. No
 * real model call is made and no quota is spent.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CodexThreadPool } = require(path.join(__dirname, '..', 'lib', 'codex-pool.cjs'));

const STUB = path.join(__dirname, 'stub-app-server.cjs');
const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

/**
 * The pool spawns `binary app-server --listen stdio://`. Substituting the
 * spawner (rather than the binary) keeps `resolveCodexBinary` and the argv shape
 * out of the test's way, and is the only hook the pool exposes for this.
 */
const spawnStub = (binary, args, options) => spawn(process.execPath, [STUB], options);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The stub captures its environment when IT starts, so anything a scenario needs
 * the stub to see must be set before `start()` spawns it — and cleared again
 * afterwards so it cannot leak into the next scenario's child.
 */
async function withStubEnv(env, run) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A pool wired to the stub, optionally with a long-running turn. */
async function makePool(env = {}) {
  let pool = null;
  await withStubEnv(env, async () => {
    pool = new CodexThreadPool({ codexPath: process.execPath, cwd: path.join(__dirname, '..'), log: () => {} });
    pool.spawnChild = spawnStub;
    await pool.start();
  });
  return pool;
}

/** Scenario 1: steering a key that never had a thread is a plain refusal. */
async function scenario1() {
  const pool = await makePool();
  try {
    const result = await pool.steer('never-opened', 'hello?');
    check('s1 steering an unknown thread key reports no-thread', result.ok === false && result.reason === 'no-thread', JSON.stringify(result));
  } finally {
    await pool.stop();
  }
}

/** Scenario 2: a thread that exists but has nothing running cannot be steered. */
async function scenario2() {
  const pool = await makePool();
  try {
    await pool.openThread('idle', { model: 'stub-model', cwd: path.join(__dirname, '..'), sandbox: 'read-only' });
    const result = await pool.steer('idle', 'nobody is listening');
    check(
      's2 steering an idle thread reports no-active-turn',
      result.ok === false && result.reason === 'no-active-turn',
      JSON.stringify(result),
    );
  } finally {
    await pool.stop();
  }
}

/**
 * Scenario 3: the happy path, and the only assertion that proves delivery.
 *
 * `STUB_STEER_JOINS_TEXT` makes the stub fold whatever landed mid-turn into the
 * turn's final `agentMessage`. Asserting on that text is the difference between
 * "the RPC returned ok" and "the model actually received the words", which is
 * the property the button promises.
 */
async function scenario3() {
  const holdMs = 1500;
  const pool = await makePool({ STUB_TURN_MS: String(holdMs), STUB_STEER_JOINS_TEXT: '1' });
  try {
    await pool.openThread('live', { model: 'stub-model', cwd: path.join(__dirname, '..'), sandbox: 'read-only' });
    let startedId = null;
    const turn = pool.runTurn('live', {
      text: 'start writing the report',
      onTurnStarted: (id) => {
        startedId = id;
      },
    });
    // Wait for `turn/started`, not for a fixed guess: the notification is what
    // sets `activeTurns`, and steering before it arrives is a legitimate
    // no-active-turn race, not the behaviour under test.
    const deadline = Date.now() + 3000;
    while (!startedId && Date.now() < deadline) await sleep(10);
    check('s3 the turn announced itself before the steer', !!startedId, String(startedId));
    check('s3 the pool reports an active turn while one is running', pool.hasActiveTurn('live') === true, String(pool.hasActiveTurn('live')));

    const steered = await pool.steer('live', 'actually, use the short format');
    check('s3 steering a running turn succeeds', steered.ok === true, JSON.stringify(steered));
    check('s3 the steer reports the SAME active turn, not a new one', steered.turnId === startedId, `${startedId} -> ${steered.turnId}`);

    const outcome = await turn;
    check('s3 the turn completed normally after being steered', outcome.status === 'completed', String(outcome.status));
    check(
      's3 the steered text reached the model inside that same turn',
      /actually, use the short format/.test(outcome.text),
      outcome.text.slice(0, 240),
    );
    check('s3 the turn kept its original prompt too', /start writing the report/.test(outcome.text), outcome.text.slice(0, 240));
    check('s3 the active turn is cleared once the turn settles', pool.hasActiveTurn('live') === false, String(pool.hasActiveTurn('live')));
  } finally {
    await pool.stop();
  }
}

/** Scenario 4: steering after the turn ended is a refusal, never a throw or a hang. */
async function scenario4() {
  const holdMs = 300;
  const pool = await makePool({ STUB_TURN_MS: String(holdMs) });
  try {
    await pool.openThread('done', { model: 'stub-model', cwd: path.join(__dirname, '..'), sandbox: 'read-only' });
    const before = pool.hasActiveTurn('done');
    await pool.runTurn('done', { text: 'quick one' });
    const duringReport = before === false ? 'idle before the turn, as expected' : 'unexpectedly busy before the turn';
    check('s4 nothing is running before the turn starts', before === false, duringReport);
    const result = await pool.steer('done', 'too late');
    check(
      's4 steering a finished turn reports no-active-turn rather than throwing',
      result.ok === false && result.reason === 'no-active-turn',
      JSON.stringify(result),
    );
  } finally {
    await pool.stop();
  }
}

/**
 * Scenario 5: steer bypasses the per-thread queue — the load-bearing property.
 *
 * Timing margins: the turn is held for 1500ms. A steer that went through
 * `_enqueue` could not settle before the turn finished, so it would take
 * >=1500ms; the threshold is set at 800ms, roughly half the hold. That is a wide
 * margin in both directions — a correct steer resolves in single-digit
 * milliseconds even on a loaded machine, and a queued one cannot beat 1500ms by
 * accident — so the test is not sensitive to a slow box.
 */
async function scenario5() {
  const holdMs = 1500;
  const queueThreshold = 800;
  const pool = await makePool({ STUB_TURN_MS: String(holdMs) });
  try {
    await pool.openThread('busy', { model: 'stub-model', cwd: path.join(__dirname, '..'), sandbox: 'read-only' });
    let startedId = null;
    const turn = pool.runTurn('busy', {
      text: 'a long answer',
      onTurnStarted: (id) => {
        startedId = id;
      },
    });
    const deadline = Date.now() + 3000;
    while (!startedId && Date.now() < deadline) await sleep(10);

    // A queued `runTurn` on the same key must stay pending behind the in-flight
    // one — that is what proves the queue is real and that steer is not in it.
    let queuedDone = false;
    const queued = pool.runTurn('busy', { text: 'second turn' }).then(() => {
      queuedDone = true;
    });

    const steerStart = Date.now();
    const steered = await pool.steer('busy', 'shorten it');
    const steerMs = Date.now() - steerStart;
    check('s5 the steer succeeded while the turn was still running', steered.ok === true, JSON.stringify(steered));
    check(
      's5 steer resolves promptly instead of waiting for the turn to end',
      steerMs < queueThreshold,
      `${steerMs}ms (turn held ${holdMs}ms, threshold ${queueThreshold}ms)`,
    );
    check('s5 a queued turn on the same thread is still waiting', queuedDone === false, queuedDone ? 'the queued turn already ran' : '');

    await turn;
    await queued;
    check('s5 the queued turn ran once the in-flight turn finished', queuedDone === true, String(queuedDone));
  } finally {
    await pool.stop();
  }
}

/** Scenario 6: the capability flag and the liveness probe the engine reads. */
async function scenario6() {
  const holdMs = 400;
  const pool = await makePool({ STUB_TURN_MS: String(holdMs) });
  try {
    check('s6 the pool declares steer support', pool.supportsSteer === true, String(pool.supportsSteer));
    await pool.openThread('flags', { model: 'stub-model', cwd: path.join(__dirname, '..'), sandbox: 'read-only' });
    check('s6 an idle thread has no active turn', pool.hasActiveTurn('flags') === false, String(pool.hasActiveTurn('flags')));
    let sawActive = false;
    const turn = pool.runTurn('flags', {
      text: 'probe',
      onTurnStarted: () => {
        sawActive = pool.hasActiveTurn('flags');
      },
    });
    await turn;
    check('s6 hasActiveTurn flips true for the duration of the turn', sawActive === true, String(sawActive));
    check('s6 hasActiveTurn flips back to false afterwards', pool.hasActiveTurn('flags') === false, String(pool.hasActiveTurn('flags')));
  } finally {
    await pool.stop();
  }
}

/**
 * Scenario 7: an attachment's path reaches codex ON THE WIRE as `localImage`.
 *
 * This is the last hop of the upload feature and the one nothing else covers:
 * `codex-input.cjs` proves `buildInput` produces the right shape, and
 * `segments.cjs` proves a segment carries its attachments to `pool.runTurn`, but
 * neither observes what `_runTurn` actually sends. Dropping attachments there
 * (`buildInput(options.text, [])`) left all 24 offline tests passing — an image
 * would have been silently replaced by its path in the text, which is exactly
 * the difference between a model *seeing* a screenshot and merely reading a
 * filename. The stub records the raw `input` array so this hop is observable.
 */
async function scenario7() {
  const inputFile = path.join(os.tmpdir(), 'ar-stub-input-' + process.pid + '-' + Date.now() + '.jsonl');
  const pool = await makePool({ STUB_INPUT_FILE: inputFile });
  try {
    await pool.openThread('shots', { model: 'stub-model', cwd: path.join(__dirname, '..'), sandbox: 'read-only' });
    await pool.runTurn('shots', {
      text: '看这张图',
      attachments: [
        { id: 'f1', name: 'shot.png', bytes: 10, mediaType: 'image/png', isImage: true, path: '/tmp/a/f1.png' },
        { id: 'f2', name: 'notes.md', bytes: 10, mediaType: 'text/markdown', isImage: false, path: '/tmp/a/f2.md' },
      ],
    });
    const lines = fs.readFileSync(inputFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    check('s7 the stub saw exactly one turn', lines.length === 1, String(lines.length));
    const input = (lines[0] && lines[0].input) || [];
    check('s7 the text entry is still first', input[0] && input[0].type === 'text', JSON.stringify(input.map((e) => e.type)));
    check(
      's7 the image arrived as a localImage entry on the wire',
      input.some((entry) => entry.type === 'localImage'),
      JSON.stringify(input),
    );
    const image = input.find((entry) => entry.type === 'localImage');
    check('s7 the localImage carries the real path', !!image && image.path === '/tmp/a/f1.png', JSON.stringify(image));
    check(
      's7 the non-image did NOT become a localImage',
      input.filter((entry) => entry.type === 'localImage').length === 1,
      JSON.stringify(input.map((e) => e.type)),
    );
    check('s7 no path is smuggled into the text entry', input[0].text === '看这张图', JSON.stringify(input[0].text));

    // A turn with no attachments must stay a single text entry — the same
    // assertion from the other side, so a mutation that always appends an image
    // is caught too.
    await pool.runTurn('shots', { text: 'no attachment here' });
    const after = fs.readFileSync(inputFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const last = after[after.length - 1].input;
    check('s7 a turn with no attachments is text only', last.length === 1 && last[0].type === 'text', JSON.stringify(last));
  } finally {
    await pool.stop();
    try {
      fs.unlinkSync(inputFile);
    } catch {}
  }
}

async function main() {
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();

  console.log('scenario1 no-thread      steering a key with no open thread is refused');
  console.log('scenario2 no-active-turn an idle thread cannot be steered');
  console.log('scenario3 deliver        a steer lands in the running turn and reaches the model');
  console.log('scenario4 late           steering after the turn ended is a refusal, not a hang');
  console.log('scenario5 bypass-queue   steer settles while the turn is still running');
  console.log('scenario6 capability     supportsSteer and hasActiveTurn track a turn lifetime');
  console.log('scenario7 attachments    an image reaches codex as localImage on the wire');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
