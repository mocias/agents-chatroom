#!/usr/bin/env node
'use strict';

/**
 * A minimal ACP *agent* for testing `lib/acp-backend.cjs`.
 *
 * This is the other end of the wire: it speaks the agent side of the Agent
 * Client Protocol over stdio (newline-delimited JSON-RPC 2.0, one object per
 * line, both directions) so the ACP backend can be exercised with no external
 * dependency, no network, and no real agent harness.
 *
 * Protocol facts it implements, pinned to the real sources:
 *   - `initialize` is a REQUEST; the reply carries `protocolVersion`,
 *     `agentInfo`, `agentCapabilities`, `authMethods`. ACP has NO standard
 *     model-list field, so the fixture advertises one nonstandardly under
 *     `_meta.availableModels` (and `agentCapabilities.currentModelId`) — the
 *     backend is required to tolerate its absence on real agents, and this is
 *     how the test proves the tolerance path also *works* when present.
 *   - `session/new` is a REQUEST: `{ cwd, mcpServers }` -> `{ sessionId,
 *     configOptions }`. The `configOptions` array is the only STANDARD place
 *     ACP exposes models (`category: 'model'`) and reasoning efforts
 *     (`category: 'thought_level'`), so the fixture sends both.
 *   - `session/prompt` is a REQUEST: `{ sessionId, prompt: [{type:'text',text}] }`
 *     -> `{ stopReason }`. Everything the assistant "says" is emitted as
 *     `session/update` NOTIFICATIONS *before* that reply lands.
 *   - `session/cancel` is a NOTIFICATION (no id) that aborts the in-flight
 *     prompt, which then resolves with `stopReason: 'cancelled'`.
 *   - `session/close` is a REQUEST -> `{}`.
 *
 * The fixture also sends an agent->client `session/request_permission` REQUEST
 * on every turn. That is deliberate: it is the one agent->client request that
 * carries BOTH `id` and `method`, and a backend that fails to answer it wedges
 * the turn forever. The fixture validates the reply is the NESTED
 * `{ outcome: { outcome: 'selected', optionId } }` shape and, if it is not,
 * writes `PERMISSION-BAD-SHAPE` to stderr so the smoke test can assert on it.
 *
 * Options:
 *   --slow <ms>   delay (ms) before each agent_message_chunk, so cancellation
 *                 can be tested deterministically.
 *   --quiet-models  do NOT advertise models in the `initialize` reply, i.e.
 *                 behave like a real agent (dsh-acp): the ONLY place its
 *                 catalogue appears is `session/new` -> `configOptions`. This is
 *                 the shape that makes a pool's pre-session catalogue empty, so
 *                 a client must not treat that emptiness as "no models" and
 *                 re-label its members.
 *
 * stdout is protocol-only, always. Diagnostics go to stderr.
 */

const MODELS = [
  { modelId: 'fixture-a', name: 'Fixture A' },
  { modelId: 'fixture-b', name: 'Fixture B' },
];

const args = process.argv.slice(2);
let slowMs = 0;
let quietModels = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--slow') {
    const value = Number(args[i + 1]);
    slowMs = Number.isFinite(value) && value >= 0 ? value : 0;
    i += 1;
  } else if (args[i] === '--quiet-models') {
    quietModels = true;
  }
}

function log(line) {
  // stderr only: stdout must stay a clean protocol stream.
  try {
    process.stderr.write('[acp-fixture] ' + line + '\n');
  } catch {}
}

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ state */

let nextSession = 0;
let nextClientRequestId = 1000;
const sessions = new Map(); // sessionId -> { cwd, prompts: [string], cancelled }
const pendingClientRequests = new Map(); // id -> { resolve }

function newClientRequest(method, params) {
  const id = nextClientRequestId++;
  return new Promise((resolve) => {
    pendingClientRequests.set(id, { resolve });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

/* --------------------------------------------------------------- handlers */

function handleInitialize(params) {
  log('initialize protocolVersion=' + (params && params.protocolVersion));
  return {
    protocolVersion: 1,
    agentInfo: { name: 'acp-fixture', title: 'ACP Test Fixture', version: '0.1.0' },
    agentCapabilities: {
      // The fixture services none of the client capabilities, so it claims none.
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
      ...(quietModels ? {} : { currentModelId: MODELS[0].modelId }),
    },
    authMethods: [],
    // NONSTANDARD. There is no model-list field in ACP; real agents expose
    // models via `session/new` -> configOptions instead. See the header.
    // `--quiet-models` drops this so the fixture matches a real agent, leaving
    // `session/new` as the only source of its catalogue.
    ...(quietModels
      ? {}
      : { _meta: { availableModels: MODELS.map((entry) => ({ ...entry })), currentModelId: MODELS[0].modelId } }),
  };
}

function modelConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: MODELS[0].modelId,
      options: MODELS.map((entry) => ({ value: entry.modelId, name: entry.name })),
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ];
}

function handleSessionNew(params) {
  nextSession += 1;
  const sessionId = 'fixture-' + nextSession;
  sessions.set(sessionId, {
    cwd: (params && params.cwd) || null,
    prompts: [],
    cancelled: false,
    // Config state, applied through `session/set_config_option` only.
    model: MODELS[0].modelId,
    effort: null,
    configCalls: [],
  });
  log('session/new -> ' + sessionId + ' cwd=' + ((params && params.cwd) || ''));
  return { sessionId, configOptions: modelConfigOptions() };
}

/**
 * `session/set_config_option` is the ONLY standard way a client selects a model
 * or a reasoning effort (`session/new` merely advertises the choices). The real
 * shape is `{ sessionId, configId, value }` with a STRING value; dsh-acp throws
 * on a non-string (index.js:388-410). Ids are 'model' / 'reasoning_effort' and
 * the values are the option values this fixture advertised, so an unknown value
 * is rejected the way a real agent would.
 */
function handleSessionSetConfig(params) {
  const sessionId = params && params.sessionId;
  const record = sessions.get(sessionId);
  if (!record) {
    throw Object.assign(new Error('unknown session: ' + sessionId), { code: -32602 });
  }
  const configId = params && params.configId;
  const value = params && params.value;
  if (typeof value !== 'string') {
    throw Object.assign(new Error('value must be a string'), { code: -32602 });
  }
  if (configId === 'model') {
    const known = MODELS.some((entry) => entry.modelId === value);
    if (!known) {
      throw Object.assign(new Error('unknown model option: ' + value), { code: -32602 });
    }
    record.model = value;
  } else if (configId === 'reasoning_effort') {
    const efforts = modelConfigOptions().find((option) => option.category === 'thought_level').options;
    if (!efforts.some((entry) => entry.value === value)) {
      throw Object.assign(new Error('unknown reasoning effort: ' + value), { code: -32602 });
    }
    record.effort = value;
  } else {
    throw Object.assign(new Error('unknown session config option: ' + configId), { code: -32602 });
  }
  record.configCalls.push(configId + '=' + value);
  log('session/set_config_option ' + sessionId + ' ' + configId + '=' + value);
  return { configOptions: modelConfigOptions() };
}

function sessionUpdate(sessionId, update) {
  notify('session/update', { sessionId, update });
}

/** Extract the plain text of a prompt: `[{ type: 'text', text }]`. */
function promptText(params) {
  const blocks = (params && Array.isArray(params.prompt)) ? params.prompt : [];
  const parts = [];
  for (const block of blocks) {
    if (!block) continue;
    if (typeof block === 'string') parts.push(block);
    else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

async function handleSessionPrompt(params) {
  const sessionId = params && params.sessionId;
  const record = sessions.get(sessionId);
  if (!record) {
    throw Object.assign(new Error('unknown session: ' + sessionId), { code: -32602 });
  }
  const text = promptText(params);
  const isRecall = /RECALL/i.test(text);

  // Exercise the agent->client REQUEST path (both `id` and `method` present).
  // A backend that does not answer this wedges the turn, so awaiting it here is
  // itself a test.
  const permission = await newClientRequest('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'call-' + record.prompts.length, title: 'fixture tool', kind: 'other' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const outcome = permission && permission.outcome;
  const selected = outcome && outcome.outcome === 'selected' ? outcome.optionId : null;
  if (!selected) {
    // Not fatal for the turn (we proceed), but loud, because it means the
    // backend's permission reply does not satisfy the real ACP shape.
    log('PERMISSION-BAD-SHAPE ' + JSON.stringify(permission));
  }

  if (record.cancelled) return { stopReason: 'cancelled' };

  // A thought chunk first: `onItem` must show it as a codex 'reasoning' item.
  sessionUpdate(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    messageId: 'thought-' + sessionId,
    content: { type: 'text', text: 'thinking about ' + text.slice(0, 40) },
  });

  // One tool_call update: `onItem` must map it to a codex 'command' item.
  sessionUpdate(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-' + record.prompts.length,
    title: 'fixture-tool',
    kind: 'other',
    status: 'in_progress',
    rawInput: { echo: text.slice(0, 40) },
  });
  sessionUpdate(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-' + record.prompts.length,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  });

  const base = isRecall
    ? recallAnswer(sessionId, record, text)
    : 'FIXTURE[' + sessionId + '] echo: ' + text.slice(0, 60);
  // Proof that `session/set_config_option` really landed: the session reports the
  // model and effort it is now actually running with, not what was requested.
  const answer = base + ' [model=' + record.model + ' effort=' + (record.effort || 'default') + ']';

  record.prompts.push(text);

  // Stream the answer in several chunks so a single turn proves `onDelta`
  // fires incrementally rather than once at the end.
  const chunks = splitChunks(answer, 3);
  for (const chunk of chunks) {
    if (record.cancelled) break;
    if (slowMs > 0) await sleep(slowMs);
    if (record.cancelled) break;
    sessionUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-' + sessionId,
      content: { type: 'text', text: chunk },
    });
  }

  if (record.cancelled) return { stopReason: 'cancelled' };

  // Exercise usage plumbing: `{ used, size }` -> `{ total, modelContextWindow }`.
  sessionUpdate(sessionId, {
    sessionUpdate: 'usage_update',
    used: 1234,
    size: 200000,
  });

  return { stopReason: 'end_turn' };
}

/** The RECALL answer: every earlier prompt this session saw, verbatim. */
function recallAnswer(sessionId, record, recallPrompt) {
  const earlier = record.prompts.slice();
  if (!earlier.length) return 'FIXTURE[' + sessionId + '] recall: (nothing earlier)';
  return 'FIXTURE[' + sessionId + '] recall: ' + earlier.join(' || ');
}

function splitChunks(text, count) {
  if (text.length <= count) return text.split('');
  const size = Math.ceil(text.length / count);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function cancelSession(sessionId) {
  const record = sessions.get(sessionId);
  if (!record) return;
  record.cancelled = true;
  log('session/cancel ' + sessionId);
}

function resetCancelled(sessionId) {
  const record = sessions.get(sessionId);
  if (record) record.cancelled = false;
}

/* ------------------------------------------------------------------- loop */

function dispatch(frame) {
  if (!frame || typeof frame !== 'object') return;
  const { id, method, params } = frame;

  // A reply to one of OUR agent->client requests.
  if (id !== undefined && method === undefined) {
    const entry = pendingClientRequests.get(id);
    if (entry) {
      pendingClientRequests.delete(id);
      entry.resolve(frame.error ? { error: frame.error } : frame.result);
    }
    return;
  }
  if (typeof method !== 'string') return;

  // The one agent method that arrives as a NOTIFICATION.
  if (method === 'session/cancel') {
    cancelSession(params && params.sessionId);
    return;
  }

  const respond = (produce) => {
    Promise.resolve()
      .then(produce)
      .then((result) => reply(id, result === undefined ? {} : result))
      .catch((error) => {
        log('error in ' + method + ': ' + (error && error.message));
        replyError(id, (error && error.code) || -32603, (error && error.message) || 'internal error');
      });
  };

  if (id === undefined) {
    // An unknown notification: nothing to reply to.
    log('ignoring notification ' + method);
    return;
  }

  switch (method) {
    case 'initialize':
      respond(() => handleInitialize(params));
      return;
    case 'session/new':
      respond(() => handleSessionNew(params));
      return;
    case 'session/set_config_option':
      respond(() => handleSessionSetConfig(params));
      return;
    case 'session/prompt': {
      const sessionId = params && params.sessionId;
      resetCancelled(sessionId);
      respond(() => handleSessionPrompt(params));
      return;
    }
    case 'session/close': {
      const sessionId = params && params.sessionId;
      log('session/close ' + sessionId);
      sessions.delete(sessionId);
      respond(() => ({}));
      return;
    }
    case 'session/load':
    case 'session/resume':
      respond(() => ({ configOptions: modelConfigOptions() }));
      return;
    case 'authenticate':
      respond(() => ({}));
      return;
    default:
      respondError(id, -32601, 'method not found: ' + method);
      return;
  }
}

function respondError(id, code, message) {
  replyError(id, code, message);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      log('unparsable line from client: ' + line.slice(0, 200));
      continue;
    }
    try {
      dispatch(frame);
    } catch (error) {
      log('dispatch failed: ' + (error && error.message));
    }
  }
});
process.stdin.on('end', () => {
  log('stdin closed; exiting');
  process.exit(0);
});

log('ready slow=' + slowMs + ' pid=' + process.pid);
