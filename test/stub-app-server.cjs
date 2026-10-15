#!/usr/bin/env node
/**
 * A miniature `codex app-server`, for tests that need the pool's child-process
 * lifecycle without spending the owner's real ChatGPT quota.
 *
 * Speaks just enough of the protocol for `room.cjs` to hold a conversation:
 * `initialize`, `model/list`, `thread/start`, `thread/inject_items`,
 * `turn/start` (with the item notifications a real turn emits), `turn/steer`
 * and `thread/unsubscribe`, plus the `project/*` + `thread/list` surface that
 * session grouping reads and writes. Unknown methods get a proper JSON-RPC error
 * instead of silence, so a test that drifts out of the supported surface fails
 * loudly.
 *
 * Control hooks, all via environment:
 *   STUB_DIE_ON_TURN  path; when this file exists, the process exits *instead*
 *                     of answering the turn. That is how the tests simulate a
 *                     crashed app-server mid-conversation.
 *   STUB_EXIT_AFTER   milliseconds; exit this long after `initialize`. Used to
 *                     simulate a child that dies while the pool believes it is
 *                     healthy.
 *   STUB_TURN_MS      milliseconds; hold a turn open this long before emitting
 *                     its item notifications and `turn/completed`. Without it
 *                     every turn finishes in the same tick and there is no
 *                     window in which a mid-turn `turn/steer` could land, so
 *                     the steer tests would be untestable. Default 0 = the
 *                     original synchronous behaviour, unchanged.
 *   STUB_STEER_JOINS_TEXT  when set, a steer that landed during a turn is
 *                     appended to the turn's final `agentMessage` text as
 *                     `<original>|<steer>`. The reply is otherwise a pure echo
 *                     of the prompt, so this is the only way a test can prove
 *                     the steered words actually reached the in-flight turn.
 *   STUB_STATE_FILE   path; when set, the thread/project store is loaded from and
 *                     saved to this file. Two pool instances then share one
 *                     store, which is what two real app-servers do (they both
 *                     read codex's own sqlite), and is the only way an offline
 *                     test can prove that grouping a harness's threads is a
 *                     process-wide operation rather than a per-connection one.
 *   STUB_INPUT_FILE   path; when set, every `turn/start` appends one JSON line —
 *                     the `input` array EXACTLY as the pool sent it — to this
 *                     file. The reply only ever echoes `input[0].text`, so
 *                     without this hook a test cannot see whether an image
 *                     attachment actually became a `localImage` entry on the
 *                     wire; asserting on `buildInput`'s return value alone leaves
 *                     the pool→server hop unverified.
 *
 * The reply echoes the prompt it received, which is what lets a test assert
 * that a restarted thread was handed the replayed room transcript.
 */
'use strict';

const fs = require('node:fs');

const DIE_ON_TURN = process.env.STUB_DIE_ON_TURN || '';
const EXIT_AFTER = Number(process.env.STUB_EXIT_AFTER || 0);
const TURN_MS = Number(process.env.STUB_TURN_MS || 0);
const STEER_JOINS_TEXT = !!process.env.STUB_STEER_JOINS_TEXT;
const STATE_FILE = process.env.STUB_STATE_FILE || '';
const INPUT_FILE = process.env.STUB_INPUT_FILE || '';

const threads = new Map();
/**
 * threadId -> the turn running on it right now. A real server keeps exactly one
 * active turn per thread and `turn/steer` addresses it, so the stub has to hold
 * the same state: without it, steering could not distinguish "nothing is
 * running" from "you named the wrong turn", which are the two errors the pool
 * classifies differently.
 */
const activeTurns = new Map();
/** turnId -> steer texts that arrived while that turn was in flight. */
const steerTexts = new Map();
/**
 * threadId -> projectId, mirroring the real store's `Thread.projectId`.
 *
 * Grouping is the one feature whose real behaviour is "the store is the only
 * authority", so the stub holds the same two pieces of state the real server
 * does: an assignment per thread, and a set of projects. A test can then assert
 * against `thread/list` exactly the way the plugin reads it.
 */
const threadProjects = new Map();
/** threadId -> has this thread ever run a turn. `project/import` rejects the rest. */
const spokenThreads = new Set();
/** projectId -> {id, name, roots, position}. */
const projects = new Map();
/**
 * idempotencyKey -> cached `project/import` response.
 *
 * This cache is the whole reason grouping has to rotate instead of grow: the
 * real server replays the cached answer without attaching anything, no matter
 * how different the payload is. Reproducing it here is what lets an offline test
 * prove the plugin never relies on growing a project in place.
 */
const importCache = new Map();
let projectSeq = 0;
/**
 * Thread ids and turn ids come from separate counters on purpose. They used to
 * share one, which meant `thread/start` and `turn/start` could mint the same
 * string, and — because `threadSeq` was read without ever being declared — the
 * whole process died with a `ReferenceError` the moment a test started a thread.
 */
let threadSeq = 0;
let turnSeq = 0;
let buffer = '';

/**
 * Shared-store mode. The file is the store, exactly as codex's sqlite is: every
 * write goes straight to disk, so a second process that loads it sees the first
 * process's projects and thread assignments.
 */
function loadState() {
  if (!STATE_FILE) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return;
  }
  for (const [threadId, projectId] of Object.entries(parsed.threadProjects || {})) threadProjects.set(threadId, projectId);
  for (const threadId of parsed.spokenThreads || []) spokenThreads.add(threadId);
  // Only the ids are shared, not the transcripts: `thread/list` — the surface
  // grouping reads — reports ids and assignments, not text.
  for (const threadId of parsed.threadIds || []) if (!threads.has(threadId)) threads.set(threadId, []);
  for (const project of parsed.projects || []) projects.set(project.id, project);
  projectSeq = parsed.projectSeq || 0;
  threadSeq = parsed.threadSeq || 0;
  turnSeq = parsed.turnSeq || 0;
}

function saveState() {
  if (!STATE_FILE) return;
  const payload = {
    threadIds: Array.from(threads.keys()),
    threadProjects: Object.fromEntries(threadProjects),
    spokenThreads: Array.from(spokenThreads),
    projects: Array.from(projects.values()),
    projectSeq,
    threadSeq,
    turnSeq,
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload), 'utf8');
  } catch {}
}

loadState();

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

/**
 * `thread/start` accepts a `SandboxMode` string but its response carries a
 * `SandboxPolicy` object. The real server behaves this way; the stub must too,
 * or it cannot catch a client that compares the two shapes directly.
 */
function sandboxPolicyOf(mode) {
  switch (mode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'workspace-write':
      return { type: 'workspaceWrite', writableRoots: [], networkAccess: false };
    default:
      return { type: 'readOnly', networkAccess: false };
  }
}

function handle(frame) {
  const { id, method, params } = frame;
  switch (method) {
    case 'initialize':
      if (EXIT_AFTER > 0) setTimeout(() => process.exit(7), EXIT_AFTER);
      return send({ jsonrpc: '2.0', id, result: { userAgent: 'stub-app-server' } });
    case 'model/list':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          data: [
            {
              id: 'stub-model',
              displayName: 'Stub',
              serviceTiers: [],
              defaultReasoningEffort: 'none',
            },
          ],
        },
      });
    case 'thread/start': {
      // A monotonic counter, not `threads.size + 1`: with a shared store the map
      // is preloaded with ids another process minted, and deriving the next id
      // from the size would re-mint an existing one.
      const threadId = 'stub-thread-' + ++threadSeq;
      threads.set(threadId, []);
      saveState();
      // Mirror the REAL server: `thread/start` takes a `SandboxMode` string but
      // echoes a `SandboxPolicy` OBJECT (`{type:'readOnly'|…}`). An earlier stub
      // echoed the string straight back, which hid a live defect where the pool
      // recorded the object and then rebuilt the thread on every single turn.
      return send({
        jsonrpc: '2.0',
        id,
        result: { thread: { id: threadId }, model: 'stub-model', sandbox: sandboxPolicyOf(params.sandbox) },
      });
    }
    case 'thread/inject_items': {
      const list = threads.get(params.threadId);
      if (list) list.push(...params.items.map((item) => item.content[0].text));
      return send({ jsonrpc: '2.0', id, result: {} });
    }
    case 'turn/start': {
      const seq = ++turnSeq;
      const turnId = 'turn-' + seq;
      const { threadId } = params;
      // Recorded BEFORE anything reads `input[0]`, so the test sees the wire
      // shape verbatim rather than a value this stub normalised on the way in.
      if (INPUT_FILE) {
        try {
          fs.appendFileSync(INPUT_FILE, JSON.stringify({ threadId, turnId, input: params.input }) + '\n');
        } catch {}
      }
      const text = params.input[0].text;
      const list = threads.get(threadId);
      if (list) list.push(text);
      // `project/import` only accepts a thread the store already knows, and a
      // thread enters that store by speaking. Recorded here so a test that
      // syncs before the first turn sees the real "thread not found" failure.
      spokenThreads.add(threadId);
      activeTurns.set(threadId, turnId);
      saveState();
      send({ jsonrpc: '2.0', id, result: { turn: { id: turnId, status: 'inProgress' } } });
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      if (DIE_ON_TURN && fs.existsSync(DIE_ON_TURN)) {
        // Crash instead of replying: the caller is left waiting on a turn whose
        // server no longer exists.
        setTimeout(() => process.exit(9), 20);
        return;
      }
      const finish = () => {
        // Read the steers at completion time, not at turn/start: a steer that
        // landed during the hold is exactly what this is here to observe.
        const steers = steerTexts.get(turnId) || [];
        const base = 'stub#' + seq + ' heard[' + text.replace(/\s+/g, ' ').slice(0, 120) + ']';
        const reply = STEER_JOINS_TEXT && steers.length ? base + '|' + steers.join('|') : base;
        if (list) list.push(...steers);
        activeTurns.delete(threadId);
        send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, delta: reply } });
        send({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { threadId, item: { type: 'agentMessage', text: reply } },
        });
        send({
          jsonrpc: '2.0',
          method: 'thread/tokenUsage/updated',
          params: { threadId, usage: { total: { totalTokens: 11, cachedInputTokens: 0 }, modelContextWindow: 4000 } },
        });
        send({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
        });
      };
      // STUB_TURN_MS=0 (the default) keeps the original same-tick completion, so
      // every pre-existing test sees byte-identical traffic. A hold exists only
      // so a steer test has a running turn to steer into.
      if (TURN_MS > 0) setTimeout(finish, TURN_MS);
      else finish();
      return;
    }
    case 'turn/steer': {
      const { threadId, expectedTurnId } = params;
      const current = activeTurns.get(threadId);
      if (!current) {
        // Mirrors the real server's wording; the pool classifies on these exact
        // strings, so a paraphrase here would silently change the reason code.
        return send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'no active turn to steer' } });
      }
      if (expectedTurnId !== current) {
        return send({
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'expected active turn id `' + expectedTurnId + '` but found `' + current + '`' },
        });
      }
      const text = params.input[0].text;
      const seen = steerTexts.get(current) || [];
      seen.push(text);
      steerTexts.set(current, seen);
      // The real server answers with the SAME active turn id: steering does not
      // start a new turn, it inserts a user message into the one in flight.
      return send({ jsonrpc: '2.0', id, result: { turnId: current } });
    }
    case 'thread/unsubscribe':
      return send({ jsonrpc: '2.0', id, result: {} });
    case 'project/list': {
      const data = Array.from(projects.values()).map((project) => ({
        ...project,
        position: project.position,
        recencyAt: null,
      }));
      return send({ jsonrpc: '2.0', id, result: { data } });
    }
    case 'project/import': {
      const key = params.idempotencyKey;
      // Replay semantics of the real server: same key -> the cached response,
      // and NOTHING new is attached. This is the trap that makes rotation
      // necessary, so the stub must reproduce it faithfully.
      if (importCache.has(key)) {
        return send({ jsonrpc: '2.0', id, result: importCache.get(key) });
      }
      const wanted = params.threads || [];
      // A thread that has not spoken yet is not in the store the import
      // consults, and the real server refuses the whole call for it.
      const missing = wanted.filter((threadId) => !spokenThreads.has(threadId));
      if (missing.length) {
        return send({
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'stub: thread not found ' + missing.join(',') },
        });
      }
      const project = {
        id: 'stub-project-' + ++projectSeq,
        name: params.name,
        roots: params.roots || [],
        position: projects.size,
      };
      projects.set(project.id, project);
      for (const threadId of wanted) threadProjects.set(threadId, project.id);
      const result = { project };
      importCache.set(key, result);
      saveState();
      return send({ jsonrpc: '2.0', id, result });
    }
    case 'project/delete': {
      projects.delete(params.projectId);
      for (const [threadId, projectId] of threadProjects) {
        if (projectId === params.projectId) threadProjects.delete(threadId);
      }
      saveState();
      return send({ jsonrpc: '2.0', id, result: {} });
    }
    case 'thread/list': {
      const limit = params && Number.isFinite(params.limit) ? params.limit : 100;
      const data = Array.from(threads.keys()).slice(0, limit).map((threadId) => ({
        id: threadId,
        projectId: threadProjects.get(threadId) || null,
        cwd: process.cwd(),
        originator: 'dsh-agent-room',
      }));
      return send({ jsonrpc: '2.0', id, result: { data } });
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'stub: unknown method ' + method } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    handle(frame);
  }
});
