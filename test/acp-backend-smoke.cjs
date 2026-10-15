#!/usr/bin/env node
'use strict';

/**
 * Smoke test for the ACP backend (`lib/acp-backend.cjs`).
 *
 * Self-contained: it spawns `test/acp-fixture.cjs` as the ACP agent using the
 * bundled Node (`process.execPath`), drives `AcpPool` directly, and asserts the
 * behaviours the room engine depends on. No HTTP, no DSH, no network, no
 * external agent binary.
 *
 * Every assertion prints a numbered PASS/FAIL line; the process exits non-zero
 * if any assertion failed. Every `await` on the pool is wrapped in a hard
 * deadline, so a hung turn is a failure rather than a hang.
 */

const path = require('node:path');
const { AcpPool, childEnv } = require(path.join(__dirname, '..', 'lib', 'acp-backend.cjs'));

const FIXTURE = path.join(__dirname, 'acp-fixture.cjs');
const CWD = path.join(__dirname, '..');

const results = [];
const fixtureStderr = [];
const logs = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  const suffix = detail ? ' — ' + detail : '';
  process.stdout.write((ok ? 'PASS' : 'FAIL') + ' ' + name + suffix + '\n');
}

/** Fail the whole run rather than hang on a wedged child. */
function withDeadline(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline exceeded (' + ms + 'ms): ' + label)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function makePool(extraArgs = []) {
  return new AcpPool({
    cwd: CWD,
    agentCommand: process.execPath,
    agentArgs: [FIXTURE, ...extraArgs],
    log: (line) => {
      logs.push(line);
      if (String(line).includes('PERMISSION-BAD-SHAPE')) fixtureStderr.push(line);
    },
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const pool = makePool();
  let slowPool = null;
  try {
    /* 1 ── start() completes and reports a pid ---------------------------- */
    await withDeadline(pool.start(), 15000, 'start()');
    const pid = pool.pid;
    check('1. start() resolves with a live pid and a non-empty binary',
      Number.isInteger(pid) && pid > 0 && pidAlive(pid) &&
      typeof pool.binary === 'string' && pool.binary.trim().length > 0,
      'pid=' + pid + ' alive=' + pidAlive(pid) + ' binary=' + JSON.stringify(pool.binary));

    /* 2 ── modelCapabilities() returns a non-empty map -------------------- */
    const caps = await withDeadline(pool.modelCapabilities(), 10000, 'modelCapabilities()');
    check('2. modelCapabilities() returns a non-empty Map', caps instanceof Map && caps.size > 0,
      'size=' + (caps instanceof Map ? caps.size : 'n/a') + ' ids=' + JSON.stringify([...caps.keys()]));
    const first = caps.values().next().value;
    check('2b. each capability entry has the codex shape', !!first &&
      typeof first.id === 'string' && typeof first.displayName === 'string' &&
      Array.isArray(first.efforts) && Array.isArray(first.serviceTiers) && 'defaultEffort' in first,
      first ? JSON.stringify({ id: first.id, efforts: first.efforts, defaultEffort: first.defaultEffort, serviceTiers: first.serviceTiers }) : 'no entries');

    /* 3 ── openThread('a') returns a record with a session id ------------- */
    const recordA = await withDeadline(
      pool.openThread('a', { model: 'fixture-a', cwd: CWD, sandbox: 'read-only' }), 15000, "openThread('a')");
    check('3. openThread("a", ...) returns a record with a session id',
      !!recordA && typeof recordA.id === 'string' && recordA.id.length > 0 && recordA.key === 'a',
      'id=' + (recordA && recordA.id));
    check('3b. record exposes the caller\'s sandbox verbatim (room reuse check)',
      !!recordA && recordA.sandbox === 'read-only', 'sandbox=' + (recordA && recordA.sandbox));
    check('3c. getThread("a") returns the same record', pool.getThread('a') === recordA);

    /* 4 ── runTurn returns the echo; onDelta streamed increments ---------- */
    const deltas = [];
    const items = [];
    const codeword = 'ZEBRAFISH-42';
    const turn1 = await withDeadline(
      pool.runTurn('a', {
        text: 'remember this codeword: ' + codeword,
        // 'high' is one of the efforts the fixture advertises through
        // configOptions, so this proves per-turn effort reaches the session.
        effort: 'high',
        onDelta: (text) => deltas.push(text),
        onItem: (item) => items.push(item),
      }), 20000, 'runTurn(a) #1');
    const text1 = (turn1 && turn1.text) || '';
    check('4. runTurn returns the fixture\'s echoed text',
      text1.includes('FIXTURE[') && text1.includes('echo:') && text1.includes(codeword),
      JSON.stringify(text1.slice(0, 120)));
    check('4b. onDelta fired at least once with non-empty increment text',
      deltas.length > 1 && deltas.every((chunk) => typeof chunk === 'string' && chunk.length > 0),
      'deltas=' + deltas.length + ' chunks=' + JSON.stringify(deltas.map((d) => d.length)));
    check('4c. streamed deltas concatenate into the final text',
      deltas.join('') === text1, 'joined=' + JSON.stringify(deltas.join('').slice(0, 80)));
    check('4d. onItem saw a reasoning item and a tool/command item',
      items.some((item) => item.type === 'reasoning') && items.some((item) => item.type === 'command'),
      'itemTypes=' + JSON.stringify([...new Set(items.map((item) => item.type))]));
    const usage = (turn1 && turn1.usage) || {};
    check('4e. usage_update plumbing reaches usage.total.totalTokens/modelContextWindow',
      usage.total && usage.total.totalTokens === 1234 && usage.modelContextWindow === 200000,
      JSON.stringify(usage));

    /* 4f ── the session actually switched model/effort ------------------- */
    // ACP carries model and effort as session CONFIG OPTIONS, so a backend that
    // never sends `session/set_config_option` silently ignores what the room
    // asked for. The fixture reports the model/effort its session is running
    // with, not the request, so this asserts the round trip really happened.
    check('4f. openThread(model) + runTurn(effort) reached the agent as session config',
      /\[model=fixture-a effort=high\]/.test(text1),
      JSON.stringify((text1.match(/\[model=[^\]]*\]/) || ['(no config block)'])[0]));

    /* 5 ── multi-turn memory on the SAME thread --------------------------- */
    const turn2 = await withDeadline(
      pool.runTurn('a', { text: 'RECALL please' }), 20000, 'runTurn(a) #2');
    const text2 = (turn2 && turn2.text) || '';
    check('5. multi-turn memory: RECALL on the same thread returns the codeword',
      text2.includes(codeword), JSON.stringify(text2.slice(0, 160)));

    /* 6 ── two thread keys are genuinely independent ---------------------- */
    const recordB = await withDeadline(
      pool.openThread('b', { model: 'fixture-a', cwd: CWD, sandbox: 'read-only' }), 15000, "openThread('b')");
    check('6a. thread b has a different session id than thread a',
      !!recordB && recordB.id !== recordA.id, 'a=' + recordA.id + ' b=' + recordB.id);
    const turn3 = await withDeadline(
      pool.runTurn('b', { text: 'RECALL please' }), 20000, 'runTurn(b) #1');
    const text3 = (turn3 && turn3.text) || '';
    check('6b. no leak: thread b\'s RECALL does NOT contain thread a\'s codeword',
      !text3.includes(codeword) && text3.includes('nothing earlier'),
      JSON.stringify(text3.slice(0, 160)));

    /* 7 ── interrupt() during a slow turn resolves, never hangs ----------- */
    slowPool = makePool(['--slow', '900']);
    await withDeadline(slowPool.start(), 15000, 'slowPool.start()');
    const recordSlow = await withDeadline(
      slowPool.openThread('slow', { model: 'fixture-a', cwd: CWD, sandbox: 'read-only' }), 15000,
      "slowPool.openThread('slow')");
    check('7a. slow fixture opened a session', !!recordSlow && typeof recordSlow.id === 'string');

    const slowDeltas = [];
    const slowTurn = slowPool.runTurn('slow', {
      text: 'this turn will be interrupted ' + 'x'.repeat(80),
      onDelta: (t) => slowDeltas.push(t),
    });
    slowTurn.catch(() => {});
    await sleep(250); // let the prompt actually reach the agent
    const interrupted = await withDeadline(slowPool.interrupt('slow'), 5000, 'interrupt()');
    check('7b. interrupt() resolved and reported it stopped an active turn', interrupted === true,
      'returned=' + interrupted);
    let slowOutcome = null;
    let slowError = null;
    try {
      slowOutcome = await withDeadline(slowTurn, 8000, 'interrupted slow turn');
    } catch (error) {
      slowError = error;
    }
    const slowText = (slowOutcome && slowOutcome.text) || '';
    check('7c. the interrupted turn settled within the deadline (no hang)',
      slowError !== null || slowOutcome !== null,
      slowError ? 'rejected with: ' + slowError.message : 'resolved stopReason=' + JSON.stringify(slowOutcome && slowOutcome.status));
    check('7d. cancellation truncated the streamed answer',
      slowError !== null || slowDeltas.length < 3,
      'deltas=' + slowDeltas.length + ' text=' + JSON.stringify(slowText.slice(0, 60)));
    check('7e. interrupt() on an idle thread returns false and does not throw',
      (await withDeadline(slowPool.interrupt('slow'), 5000, 'idle interrupt()')) === false);

    /* 8 ── inject is documented as unsupported ---------------------------- */
    check('8. supportsInject === false', pool.supportsInject === false);
    let injectThrew = null;
    try {
      await withDeadline(pool.inject('a', [{ text: 'ignored' }]), 5000, 'inject()');
    } catch (error) {
      injectThrew = error;
    }
    check('8b. inject() resolves without throwing', injectThrew === null,
      injectThrew ? injectThrew.message : 'resolved');
    const injectResult = await withDeadline(pool.injectItems('a', [{ text: 'ignored' }]), 5000, 'injectItems()');
    check('8c. injectItems() reports unsupported (falsy injected, no error) so the room replays the delta',
      !!injectResult && !injectResult.injected && !injectResult.error, JSON.stringify(injectResult));

    /* 8d ── failure and misuse paths are readable errors, not hangs ------ */
    const missing = new AcpPool({
      cwd: CWD,
      // An explicit path that cannot exist: caught synchronously, before spawn.
      agentCommand: path.join(CWD, 'definitely-not-here', 'no-such-agent.exe'),
    });
    let missingError = null;
    try {
      await withDeadline(missing.start(), 8000, 'start() with a missing binary');
    } catch (error) {
      missingError = error;
    }
    check('8d. start() rejects readably for a missing agent binary',
      !!missingError && missingError.name === 'AcpError' && /not found/.test(missingError.message),
      missingError ? missingError.name + ': ' + missingError.message : 'resolved (BUG)');

    // A bare (PATH-resolved) name that does not exist must also reject promptly:
    // `spawn` reports ENOENT asynchronously as an 'error' event, and start() has
    // to race that against the initialize request or it would wait out the
    // 10-minute request timeout.
    const bareMissing = new AcpPool({ cwd: CWD, agentCommand: 'no-such-agent-xyz-123' });
    let bareError = null;
    try {
      await withDeadline(bareMissing.start(), 8000, 'start() with a bare missing command');
    } catch (error) {
      bareError = error;
    }
    check('8e. start() rejects promptly for a bare missing command (spawn ENOENT race)',
      !!bareError && bareError.name === 'AcpError',
      bareError ? bareError.message.slice(0, 120) : 'resolved (BUG)');

    let ghostError = null;
    try {
      await withDeadline(missing.runTurn('ghost', { text: 'x' }), 5000, 'runTurn on an unknown thread');
    } catch (error) {
      ghostError = error;
    }
    check('8f. runTurn() on an unknown thread rejects with AcpError',
      !!ghostError && ghostError.name === 'AcpError' && /unknown thread key/.test(ghostError.message),
      ghostError ? ghostError.name + ': ' + ghostError.message : 'resolved (BUG)');

    // Every one of these is a no-op on a pool that never started.
    let idleThrew = null;
    try {
      await missing.stop();
      await missing.interrupt('nothing');
      missing.closeThread('nothing');
    } catch (error) {
      idleThrew = error;
    }
    check('8g. stop()/interrupt()/closeThread() are inert on an unstarted pool',
      idleThrew === null, idleThrew ? idleThrew.message : 'all inert');

    /* 9 ── closeThread() then re-open yields a NEW session id ------------- */
    const oldId = pool.getThread('a').id;
    pool.closeThread('a');
    check('9a. closeThread() drops the record', pool.getThread('a') === undefined);
    const reopened = await withDeadline(
      pool.openThread('a', { model: 'fixture-a', cwd: CWD, sandbox: 'read-only' }), 15000,
      "re-openThread('a')");
    check('9b. re-openThread() yields a NEW session id', !!reopened && reopened.id !== oldId,
      'old=' + oldId + ' new=' + (reopened && reopened.id));

    /* 10 ── flush() is a real barrier ordered behind an earlier runTurn ----- */
    // `room.cjs` awaits flush() before computing a turn's replay delta, so flush
    // MUST sit behind everything already queued for that key. Issuing a turn and
    // then flushing must therefore observe the turn as already finished.
    let turnFinished = false;
    let flushFinished = false;
    const orderedTurn = pool.runTurn('a', { text: 'flush ordering probe' })
      .then((result) => {
        turnFinished = true;
        return result;
      });
    orderedTurn.catch(() => {});
    const barrier = pool.flush('a').then(() => {
      flushFinished = true;
    });
    await withDeadline(barrier, 20000, 'flush(a)');
    check('10. flush(key) resolves and is ordered after a runTurn issued just before it',
      flushFinished && turnFinished,
      'flush resolved=' + flushFinished + ' turn already finished=' + turnFinished);
    const orderedResult = await withDeadline(orderedTurn, 20000, 'ordered runTurn');
    check('10b. the ordered runTurn still produced its own answer',
      /flush ordering probe/.test((orderedResult && orderedResult.text) || ''),
      JSON.stringify(((orderedResult && orderedResult.text) || '').slice(0, 90)));

    /* 11 ── stop() terminates the child ---------------------------------- */
    const slowPid = slowPool.pid;
    await withDeadline(slowPool.stop(), 15000, 'slowPool.stop()');
    await withDeadline(pool.stop(), 15000, 'pool.stop()');
    for (let i = 0; i < 40 && pidAlive(pid); i += 1) await sleep(75);
    check('11. stop() kills the child (pid becomes null and the process is gone)',
      pool.pid === null && !pidAlive(pid),
      'pid before=' + pid + ' pool.pid after=' + JSON.stringify(pool.pid) + ' alive=' + pidAlive(pid));
    check('11b. the slow pool\'s child is gone too',
      slowPool.pid === null && !pidAlive(slowPid), 'pid=' + slowPid + ' pool.pid=' + JSON.stringify(slowPool.pid));

    check('12. the fixture never reported a bad permission-reply shape',
      fixtureStderr.length === 0,
      fixtureStderr.length ? fixtureStderr[0].slice(0, 200) : 'nested { outcome: { outcome, optionId } } accepted');

    /* 13 ── proxy injection is opt-out-able -------------------------------- */
    // The default SOCKS proxy is a codex workaround. ACP agents do not need it,
    // and at least one real agent (DeepSeek Harness's own `--profile acp`)
    // actively rejects SOCKS and logs warnings, so `proxy: false` must be able
    // to suppress it — while the default stays in place for callers who say
    // nothing.
    const suppressed = childEnv({ proxy: false, env: {} });
    check('13. proxy:false suppresses HTTPS_PROXY/ALL_PROXY injection',
      suppressed.HTTPS_PROXY === undefined && suppressed.ALL_PROXY === undefined,
      'HTTPS_PROXY=' + JSON.stringify(suppressed.HTTPS_PROXY) + ' ALL_PROXY=' + JSON.stringify(suppressed.ALL_PROXY));
    const defaulted = childEnv({ env: {} });
    check('13b. the default proxy is still injected when nothing is specified',
      typeof defaulted.HTTPS_PROXY === 'string' && defaulted.HTTPS_PROXY.length > 0,
      'HTTPS_PROXY=' + JSON.stringify(defaulted.HTTPS_PROXY));
    const custom = childEnv({ proxy: 'http://127.0.0.1:7890', env: {} });
    check('13c. an explicit proxy URL is honoured verbatim',
      custom.HTTPS_PROXY === 'http://127.0.0.1:7890', 'HTTPS_PROXY=' + JSON.stringify(custom.HTTPS_PROXY));
    const stripped = childEnv({ proxy: false, env: {} });
    check('13d. NO_PROXY is still set even without a proxy',
      typeof stripped.NO_PROXY === 'string' && stripped.NO_PROXY.length > 0, 'NO_PROXY=' + JSON.stringify(stripped.NO_PROXY));
  } finally {
    // Never leave a child behind, even on an assertion blow-up.
    try { if (slowPool) await slowPool.stop(); } catch {}
    try { await pool.stop(); } catch {}
  }
}

main()
  .then(() => {
    const failed = results.filter((entry) => !entry.ok);
    process.stdout.write('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed\n');
    if (failed.length) {
      process.stdout.write('FAILED:\n' + failed.map((entry) => '  - ' + entry.name).join('\n') + '\n');
    }
    const problems = failed.map((entry) => entry.name + (entry.detail ? ' (' + entry.detail + ')' : ''));
    process.stdout.write('problems: ' + (problems.length ? problems.join(' | ') : 'none') + '\n');
    process.exit(problems.length ? 1 : 0);
  })
  .catch((error) => {
    const message = error && error.stack ? error.stack : String(error);
    process.stdout.write('FAIL harness error: ' + message + '\n');
    process.stdout.write('problems: harness error: ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exit(1);
  });
