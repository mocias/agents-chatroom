'use strict';
/**
 * The room engine: one public broadcast log, many listening agents.
 *
 * Model (the "design B" the user chose):
 *   - The room owns ONE public log. Every message — from the human or from any
 *     agent — is appended to it and is visible to everyone.
 *   - Each agent keeps its own durable harness session (a codex thread, an ACP
 *     session, …). It is NOT a shared model conversation: the illusion of a
 *     group chat comes from delivering the log to every session separately.
 *   - `@name` is public emphasis, not a private channel. It is printed in the
 *     log like everything else. It buys exactly two things: immediacy (the
 *     named member is served now instead of at the next tick) and emphasis in
 *     the text the member reads.
 *   - `replyPolicy` no longer decides WHO RECEIVES anything — a segment is
 *     always delivered to every member. It only decides whether members are
 *     asked to answer. See `_turnInstruction`.
 *
 * Delivery (`R3`), the one and only channel:
 *   - Records accumulate into a per-member SEGMENT. A tick every `segmentMs`
 *     (default 30s) hands each member the content it has not read yet — "the
 *     latest stretch, between the last delivery and now" — as one turn.
 *   - A segment is merged into an earlier one only while that earlier segment
 *     has NOT been started. Once a member has begun reading a segment, new
 *     content starts a new segment behind it. That is the rule that stops the
 *     "waiting → new content → queue → waiting" spiral the user described.
 *   - A segment longer than `maxSegmentChars` is closed and a new one opened,
 *     so one tick can produce several turns rather than one unbounded prompt.
 *   - A member that is busy queues its segments instead of dropping them.
 *     (The old engine dropped the whole turn when the member was mid-answer.)
 *   - The FIRST message of a room, and any `@`, are served immediately; every
 *     other delivery waits for the tick.
 *   - This replaces real-time per-record overhearing (`thread/inject_items`),
 *     which is why `_overhear` is gone: one channel, not two.
 *
 * History (`R1`):
 *   - Every appended record is also written as one JSON line to
 *     `<roomsDir>/<roomId>.log.jsonl`, and replayed into `this.log` on startup.
 *     Members' cursors are persisted with the roster so a restart does not make
 *     every member re-read (and re-answer) the entire history.
 *
 * Members are not hard-wired to one provider. Each member carries a `backend`
 * name (`'codex'` by default`) and the room keeps one pool per backend, so a
 * single room can hold a codex thread and, say, an ACP harness side by side.
 * Every pool must offer the same method face — see `_createPool`.
 *
 * Working directories (`R2`) are per BACKEND, not per room: every codex session
 * in every room shares `workspaceDirs.codex`, every ACP session shares
 * `workspaceDirs.acp`. The table is read from configuration and never mutated
 * at runtime; a backend with no entry falls back to
 * `<roomsDir>/../agent-room-workspace/<backend>`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { CodexThreadPool, CodexError } = require('./codex-pool.cjs');

/** How often each member is handed the content it has not read yet. */
const DEFAULT_SEGMENT_MS = 30000;
/** A segment is closed before it can grow past this many characters. */
const DEFAULT_MAX_SEGMENT_CHARS = 2500;
/** How many sealed segments may wait behind a busy member before we shed. */
const DEFAULT_MAX_QUEUED_SEGMENTS = 8;
/** A segment that has waited this long behind a stuck turn is reported. */
const DEFAULT_QUEUE_STALL_MS = 120000;

const MODES = {
  chat: {
    label: 'CHAT',
    effort: 'none',
    serviceTierForTurn: 'priority',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    instruction:
      '现在是 CHAT 模式：像群聊一样快速、简短地回答。默认 1-3 句话，除非被明确要求否则不要使用任何工具、不要读写文件、不要执行命令。',
  },
  work: {
    label: 'WORK',
    effort: 'high',
    serviceTierForTurn: null,
    sandboxPolicy: { type: 'dangerFullAccess' },
    instruction:
      '现在是 WORK 模式：以完成实际工作为目标。可以读写文件、执行命令、修改代码。先简要说明你要做什么，做完后用几句话汇报结果。',
  },
};

/**
 * The model a codex member gets when none is given. Only codex, because this is
 * a codex model name — see `_newMember` for why an ACP member must not inherit
 * it.
 */
const DEFAULT_MODEL = 'gpt-5.6-sol';

const DEFAULT_MEMBERS = [
  {
    id: 'codex',
    label: 'Codex',
    model: 'gpt-5.6-sol',
    persona: '你擅长写代码、修改文件、执行命令。回答直接、务实，先给结论再给理由。',
  },
  {
    id: 'astra',
    label: 'Astra',
    model: 'gpt-6-astra',
    persona: '你擅长分析与方案设计。喜欢先拆解问题，再给出结构化建议，并明确指出风险与取舍。',
  },
  {
    id: 'terra',
    label: 'Terra',
    model: 'gpt-5.6-terra',
    persona: '你擅长审查与挑错。你的职责是质疑别人的结论、找出漏洞、提出反例，不要随声附和。',
  },
];

/** Parse `@token` handles out of a message body. */
function parseMentions(text, members) {
  const handles = new Map();
  for (const member of members) {
    handles.set(member.id.toLowerCase(), member.id);
    handles.set(member.label.toLowerCase(), member.id);
    if (member.aliases) for (const alias of member.aliases) handles.set(String(alias).toLowerCase(), member.id);
  }
  const found = [];
  const pattern = /@([A-Za-z0-9_\-\u4e00-\u9fa5]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1].toLowerCase();
    if (raw === 'all' || raw === '全体' || raw === '所有人') {
      for (const member of members) if (!found.includes(member.id)) found.push(member.id);
      continue;
    }
    const id = handles.get(raw);
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * One attachment, reduced to the fields a record durably needs.
 *
 * The path is kept because it is the whole point (see `AttachmentStore`), but
 * nothing else about the host's filesystem is: the stored shape is exactly what
 * the history file should be able to carry forever.
 */
function normalizeAttachment(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' ? entry.id : '';
  const filePath = typeof entry.path === 'string' ? entry.path : '';
  if (!id || !filePath) return null;
  return {
    id,
    name: String(entry.name || id).slice(0, 180),
    bytes: Number(entry.bytes) || 0,
    mediaType: String(entry.mediaType || 'application/octet-stream'),
    isImage: !!entry.isImage,
    path: filePath,
  };
}

/** Every attachment on a record, in order, with unusable entries dropped. */
function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeAttachment).filter(Boolean);
}

/**
 * What a message that was nothing but attachments reads as in the transcript.
 *
 * A record with an empty `text` would render as a nameless blank bubble, and the
 * room's own replay would hand members a line with no content at all. Naming the
 * files keeps the log readable without pretending the user typed something.
 */
function attachmentSummary(attachments) {
  const names = attachments.map((entry) => entry.name).filter(Boolean);
  if (!names.length) return '（附件）';
  return `（附件：${names.join('、')}）`;
}

/**
 * The lines that tell a member which files a record carried.
 *
 * Written as explicit paths rather than as prose because every harness reads
 * files by path: this is the difference between an agent that can open the
 * picture and one that merely knows a picture exists. Images are called out as
 * images so a member that supports vision reaches for the image entry point
 * instead of trying to read a PNG as text.
 */
function attachmentLines(attachments, indent = '    ') {
  if (!attachments.length) return [];
  return attachments.map((entry) => {
    const kind = entry.isImage ? '图片' : '文件';
    const size = entry.bytes ? `（${Math.round(entry.bytes / 1024)} KB）` : '';
    return `${indent}↳ ${kind}：${entry.path}${size}`;
  });
}

/**
 * The passive-turn instruction offers "(无补充)" as the way to decline. Models
 * echo it verbatim (sometimes with a stray prefix/suffix), so match the marker
 * instead of posting it as a real utterance.
 */
const NO_ADDENDUM = /^[\s（(【\[]*无补充[\s）)】\]。.!！?？~～]*$/;

function isNoAddendum(text) {
  return NO_ADDENDUM.test(String(text || '').trim());
}

/**
 * Wall-clock time-of-day for a record's ISO timestamp, or '' if unparseable.
 *
 * The user wants each line of the shared transcript to carry when it was said,
 * and no harness protocol has a timestamp field on a prompt — so the stamp has
 * to be baked into the text. Local time, not UTC: a room is read by a human
 * sitting in one timezone, and a UTC stamp would silently disagree with the
 * clock on their wall.
 */
function timeOfDay(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

/**
 * Read a saved roster, tolerating every way a hand-edited file can be wrong.
 *
 * A malformed roster must never stop the room from starting: the file is UI
 * state, and losing it costs a member list, not the product.
 */
function readRoster(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.members && !Array.isArray(parsed.members)) return null;
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Surface it: a roster that silently fails to load looks like "my members
      // disappeared", which is much harder to diagnose than a log line.
      process.emitWarning(`agent-room: ignoring unreadable roster ${file}: ${error.message}`);
    }
    return null;
  }
}

class AgentRoom extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.id = options.id || 'default';
    this.title = options.title || 'Agent Room';
    this.cwd = options.cwd || process.cwd();
    this.replyPolicy = options.replyPolicy || 'addressed';
    this.mode = options.mode === 'work' ? 'work' : 'chat';
    /**
     * How far an agent-to-agent `@` chain may run before mentions only buy
     * emphasis. Each human message resets the budget. Without a bound, two
     * agents that mention each other would deliver segments to each other
     * forever, since a mention is now an immediate delivery.
     */
    this.maxRelayHops = options.maxRelayHops === undefined ? 2 : options.maxRelayHops;
    this.maxParallel = options.maxParallel === undefined ? 8 : options.maxParallel;
    /**
     * Open every member's session during `connect()` instead of waiting for that
     * member's first turn. Delivery is per member with no in-flight gate that
     * needs a warm thread, but prewarming still buys the first segment a warm
     * session instead of paying a cold start inside the tick.
     */
    this.prewarm = options.prewarm !== false;
    this.codexPath = options.codexPath;
    this.proxy = options.proxy;
    /** Where the member roster is persisted, so it survives a DSH restart. */
    this.rosterFile = options.rosterFile || null;
    /** Where the public log is appended as JSONL, so history survives too. */
    this.logFile = options.logFile || null;
    /**
     * One working directory per BACKEND (`{codex: '…', acp: '…'}`), read from
     * configuration and never mutated. Members do not get a per-member cwd:
     * every codex session in every room shares the codex directory, every ACP
     * session shares the ACP one. That is the point — the harness's own project
     * grouping then puts all of a room's codex threads in one place.
     */
    this.workspaceDirs = options.workspaceDirs || {};
    /**
     * The name the codex side files this harness's threads under, or `null` to
     * leave codex's own project list alone.
     *
     * It is named after the harness, not the room: the user asked for one
     * workspace per harness holding *all* of that harness's conversations, so
     * every room's pool must ask for the same group.
     */
    this.projectName = options.projectName === undefined ? 'agent-room' : options.projectName;
    this.segmentMs = options.segmentMs === undefined ? DEFAULT_SEGMENT_MS : options.segmentMs;
    this.maxSegmentChars =
      options.maxSegmentChars === undefined ? DEFAULT_MAX_SEGMENT_CHARS : options.maxSegmentChars;
    this.maxQueuedSegments =
      options.maxQueuedSegments === undefined ? DEFAULT_MAX_QUEUED_SEGMENTS : options.maxQueuedSegments;
    this.queueStallMs = options.queueStallMs === undefined ? DEFAULT_QUEUE_STALL_MS : options.queueStallMs;
    this.log = [];
    this.logSeq = 0;
    this.busy = new Set();
    /** Records whose agent-to-agent `@` has already been served this cascade. */
    this.relayBudget = new Map();
    /** How many hops of agent-to-agent mention chaining remain in this cascade. */
    this.cascadeRemaining = this.maxRelayHops;
    /** Segment ids are minted from here; never reused, so a stale one is detectable. */
    this.segmentSeq = 0;
    this.tickTimer = null;
    /** Backends waiting to have their sessions filed by `_scheduleGrouping`. */
    this._pendingGroups = [];
    this._groupTimer = null;
    this.shedSegments = 0;
    /**
     * One pool per provider, keyed by backend name. `this.pool` stays the
     * primary (codex) pool so an embedder — or a test — can swap it wholesale
     * and have every default-backend member follow along.
     */
    this.primaryBackend = options.backend || 'codex';
    this.backendOptions = options.backends || {};
    this.pools = new Map();
    this.pool = this._createPool(this.primaryBackend);
    this.memberConfig = options.members || DEFAULT_MEMBERS;
    /**
     * A roster saved by an earlier process wins over the built-in default, so a
     * member list edited in the UI survives a DSH restart. An explicit
     * `options.members` still wins over the file: config is the operator's
     * statement, the file is accumulated UI state.
     */
    let savedRoster = null;
    if (!options.members && this.rosterFile) {
      savedRoster = readRoster(this.rosterFile);
      if (savedRoster) {
        if (Array.isArray(savedRoster.members) && savedRoster.members.length) this.memberConfig = savedRoster.members;
        if (savedRoster.replyPolicy) this.replyPolicy = savedRoster.replyPolicy;
      }
    }
    this.members = this.memberConfig.map((member) => this._newMember(member));
    // History first, then each member's read position: a member whose cursor was
    // persisted must not be handed the whole room again on restart. Without the
    // cursor the room would restart deaf-but-verbose — every member re-reading
    // (and re-answering) a conversation it already knows.
    this._loadLog();
    if (savedRoster && Array.isArray(savedRoster.members)) {
      for (const entry of savedRoster.members) {
        const member = this.members.find((m) => m.id === entry.id);
        if (member && Number.isFinite(entry.cursor)) member.cursor = entry.cursor;
      }
    }
    this.ready = false;
  }

  /**
   * A pool for one backend.
   *
   * Every backend must answer the same method face — `start`/`stop`/`pid`,
   * `modelCapabilities`, `openThread`/`getThread`/`closeThread`, `runTurn`,
   * `interrupt`, and optionally `steer` (codex can join a running turn; ACP
   * cannot) — so the engine above this line never learns which harness it is
   * talking to. `acp-backend.cjs` is required lazily: a room that only uses
   * codex must keep working even where that file is absent.
   */
  _createPool(backend) {
    const shared = {
      // R2: the working directory belongs to the BACKEND, not to the room. Every
      // codex session in every room shares `workspaceDirs.codex`, so the
      // harness's own project grouping collects a room's threads in one place.
      // Falling back to the host cwd keeps an unconfigured backend working.
      cwd: this._workspaceDirFor(backend) || this.cwd,
      // The harness's own grouping: codex files its threads into a named
      // "project", which is what the desktop list shows as a workspace. The name
      // is the harness's, not the room's, so every room's threads land together.
      // ACP ignores both keys (it has no project concept; its side of the
      // grouping is a DSH workspace, which only the host half can create).
      projectName: this.projectName,
      projectRoot: this._workspaceDirFor(backend) || this.cwd,
      codexPath: this.codexPath,
      proxy: this.proxy,
      log: (line) => this.emit('log', line),
      onServerRequest: (method, params) => this._onServerRequest(method, params),
      ...(this.backendOptions[backend] || {}),
    };
    if (backend === 'codex') return new CodexThreadPool(shared);
    if (backend === 'acp') {
      // Loaded on demand so the codex-only path has no hard dependency on it.
      const { AcpPool } = require('./acp-backend.cjs');
      return new AcpPool(shared);
    }
    throw new Error(`unknown backend: ${backend}`);
  }

  /**
   * The primary backend's pool.
   *
   * This is an accessor, not a plain field, so that assigning it replaces the
   * pool the room actually uses: `this.pools` is the single source of truth, and
   * a test (or an embedder) swapping in a stub cannot leave a second, real pool
   * behind to be started by `connect()`.
   */
  get pool() {
    return this.pools.get(this.primaryBackend);
  }

  set pool(value) {
    this.pools.set(this.primaryBackend, value);
  }

  /** The pool that owns this member's thread. */
  _poolFor(member, create = true) {
    const backend = member.backend || this.primaryBackend;
    const existing = this.pools.get(backend);
    if (existing) return existing;
    if (!create) return null;
    const pool = this._createPool(backend);
    this.pools.set(backend, pool);
    return pool;
  }

  /**
   * The working directory for one backend.
   *
   * R2: one directory per harness, not per room and not per member — the whole
   * point is that codex's own project list sees a room's threads together. The
   * table is read from configuration and never mutated, so a member that changes
   * backend (or a room that is rebuilt) lands in the same place every time.
   * `undefined` means "not configured": the caller keeps the host cwd.
   */
  _workspaceDirFor(backend) {
    const dir = this.workspaceDirs ? this.workspaceDirs[backend] : null;
    return dir ? String(dir) : undefined;
  }

  /** The member with this id, or null. */
  _member(id) {
    return this.members.find((member) => member.id === id) || null;
  }

  /**
   * Ask the backend to file its sessions into the harness's own workspace.
   *
   * Called after a turn rather than after a session is opened because that is
   * the first moment codex's store admits the thread exists — `project/import`
   * answers "thread not found" for a thread that has not spoken yet. The pool
   * owns the machinery (`syncProject`); this method only decides *when*, and it
   * batches a burst of replies so three members answering at once ask for the
   * same grouping once rather than three times.
   */
  _scheduleGrouping(backend, threadId) {
    this._pendingGroups.push({ backend, threadId: threadId || null });
    if (this._groupTimer) return;
    this._groupTimer = setTimeout(() => {
      this._groupTimer = null;
      const pending = this._pendingGroups;
      this._pendingGroups = [];
      /** backend -> the thread ids that spoke during this window. */
      const byBackend = new Map();
      for (const entry of pending) {
        if (!byBackend.has(entry.backend)) byBackend.set(entry.backend, new Set());
        if (entry.threadId) byBackend.get(entry.backend).add(entry.threadId);
      }
      for (const [name, threadIds] of byBackend) {
        const pool = this.pools.get(name);
        if (!pool || typeof pool.syncProject !== 'function') continue;
        void Promise.resolve(pool.syncProject(Array.from(threadIds))).catch((error) => {
          this.emit('log', `grouping ${name} sessions failed: ${error.message}`);
        });
      }
    }, 0);
    if (this._groupTimer.unref) this._groupTimer.unref();
  }

  /**
   * Forget where a member had read up to, because the session it was reading
   * from is gone.
   *
   * Both callers in `ensureThread` are "the thread was rebuilt" cases, and a
   * rebuilt thread has no history: the cursor must go back to zero and the next
   * turn must re-brief the member from the log. Buffers are dropped because
   * their lines came from the old read position and their ids meant nothing to
   * the new session; `_replayLines` rebuilds them wholesale, so nothing is lost.
   */
  _rewindMember(member) {
    member.cursor = 0;
    member.segments = [];
    member.needsReplay = true;
  }

  /**
   * The whole room as this member should re-read it, after its session was
   * rebuilt and its history went with it.
   *
   * This is the one place that still reads the log directly: a rebuilt thread
   * needs everything, not "what arrived since the last delivery". The cursor is
   * advanced to the end at the same time, because the lines returned here ARE
   * the member's new read position — leaving it at zero would make the next
   * capture replay the room a second time.
   */
  _replayLines(member) {
    const lines = [];
    for (const record of this.log) {
      if (record.kind === 'system') continue;
      if (record.authorId === member.id) continue;
      lines.push(this._formatRecord(member, record));
    }
    member.cursor = this.logSeq;
    return lines;
  }

  /** Normalise one member config into runtime state. */
  _newMember(config) {
    const backend = config.backend || this.primaryBackend;
    return {
      id: config.id,
      label: config.label || config.id,
      /**
       * A member with no model gets a default chosen by its BACKEND, never a
       * hardcoded codex name: `gpt-5.6-sol` on an ACP member is a model that
       * backend has never heard of, and the first catalogue refresh would
       * "correct" it and report a scary `not offered` error for a model the user
       * never chose. `null` means "let the agent decide", which is exactly what
       * an ACP session does when no `session/set_config_option` is sent.
       */
      model: config.model || (backend === 'codex' ? DEFAULT_MODEL : null),
      persona: config.persona || '',
      aliases: config.aliases || [],
      backend,
      status: 'cold',
      /** Every record with `seq <= cursor` has been captured into a segment. */
      cursor: 0,
      /**
       * The member's accumulation buffers, oldest first. The LAST one is the
       * open segment: content still joins it, because the member has not begun
       * reading it. Everything before it is sealed and waiting for the member's
       * turn to come free.
       */
      segments: [],
      /** The segment currently being read, or null. */
      running: null,
      /** Bumped whenever the thread is rebuilt; invalidates a stale completion. */
      threadGen: 0,
      /**
       * Text a PREEMPTED turn had already consumed. An ACP session cannot tell
       * us whether that prompt reached its history, and our own cursor has
       * already moved past it, so the only safe answer is to say it again: this
       * is prepended to the member's next segment.
       */
      carryOver: '',
      /** How many segments this member has been handed. */
      segmentsSent: 0,
      /** Segments dropped because a stuck turn filled the queue. */
      shed: 0,
      /** Times an `@` was steered into a running turn (codex) or preempted it. */
      steered: 0,
      preempted: 0,
      /** Warned once about a segment waiting longer than `queueStallMs`. */
      stallWarned: false,
      /** Times this member's turn had to be abandoned as wedged. */
      stalls: 0,
      /**
       * Set when the member's session was rebuilt (model change, persona change,
       * crash), because a rebuilt session has no history. The next turn then
       * carries the whole room instead of one segment, and this flag is cleared.
       */
      needsReplay: false,
      turns: 0,
      silentTurns: 0,
      tokens: 0,
      cachedTokens: 0,
      contextWindow: null,
      error: null,
      lastText: '',
    };
  }

  /** What a member looks like when written back to the member file. */
  toConfig(member) {
    return {
      id: member.id,
      label: member.label,
      model: member.model,
      persona: member.persona,
      aliases: member.aliases,
      backend: member.backend,
    };
  }

  snapshot() {
    const mode = MODES[this.mode];
    return {
      roomId: this.id,
      title: this.title,
      cwd: this.cwd,
      mode: this.mode,
      modeLabel: mode.label,
      replyPolicy: this.replyPolicy,
      prewarm: this.prewarm,
      connected: this.ready && this._poolsAlive(),
      backend: this.primaryBackend,
      backends: this.backends(),
      // Delivery/configuration facts, so the UI can show what the room is
      // actually doing instead of guessing: how often it hands content over,
      // where the history lives, and which directory each harness works in.
      logFile: this.logFile,
      segmentMs: this.segmentMs,
      maxSegmentChars: this.maxSegmentChars,
      maxQueuedSegments: this.maxQueuedSegments,
      queueStallMs: this.queueStallMs,
      workspaceDirs: { ...this.workspaceDirs },
      // Reported so a restart can be confirmed from outside: the grouping name
      // travels config -> RoomApi -> here -> the codex pool, and an empty value
      // here means the running process predates that wiring.
      projectName: this.projectName,
      // Process facts for the primary backend. `codexPid`/`codexBinary` are kept
      // because the existing e2e test and README read them, but they must not
      // claim to describe codex when codex is not even in the room — an ACP-only
      // room would otherwise report the ACP agent's pid as "codexPid".
      pid: this.pools.get(this.primaryBackend)?.pid ?? null,
      binary: this.pools.get(this.primaryBackend)?.binary ?? null,
      codexPid: this.pools.has('codex') ? this.pools.get('codex').pid : null,
      codexBinary: this.pools.has('codex') ? this.pools.get('codex').binary : null,
      log: this.log,
      members: this.members.map((member) => ({
        id: member.id,
        label: member.label,
        model: member.model,
        persona: member.persona,
        aliases: member.aliases,
        backend: member.backend,
        status: member.status,
        turns: member.turns,
        silentTurns: member.silentTurns || 0,
        tokens: member.tokens,
        cachedTokens: member.cachedTokens,
        contextWindow: member.contextWindow,
        error: member.error,
        threadId: this._poolFor(member, false)?.getThread(member.id)?.id || null,
        // Delivery state. `queued` is the honest name for what the old engine
        // called "overheard": content captured and waiting, NOT content the
        // member has read. `activeSegment` names the segment being read now.
        queued: member.segments.length,
        queuedChars: member.segments.reduce((sum, segment) => sum + segment.chars, 0),
        activeSegment: member.running ? member.running.id : null,
        segmentsSent: member.segmentsSent || 0,
        steered: member.steered || 0,
        preempted: member.preempted || 0,
        shed: member.shed || 0,
        stalls: member.stalls || 0,
      })),
      busy: Array.from(this.busy),
    };
  }

  /**
   * Is every backend this room uses actually running?
   *
   * `this.ready` only records "connect() succeeded once". A backend process can
   * die at any time afterwards, and reporting `connected: true` then is a lie the
   * UI would render as a healthy room that answers nothing.
   */
  _poolsAlive() {
    for (const pool of this.pools.values()) {
      if (typeof pool.running === 'boolean' && !pool.running) return false;
    }
    return true;
  }

  async connect() {
    if (this.ready) return;
    // Start every backend this roster actually uses — lazily created pools for
    // members that were added at runtime included.
    for (const member of this.members) this._poolFor(member);
    for (const pool of this.pools.values()) {
      await pool.start();
    }
    await this._refreshCapabilities();
    this.ready = true;
    this.emit('update', this.snapshot());
    if (this.prewarm) await this.prewarmMembers();
  }

  /**
   * Open every member's thread before anyone speaks.
   *
   * A member's first delivery needs a thread; opening it lazily would put a cold
   * start (seconds) inside the first turn a member is asked to answer, and the
   * room's whole point is that everyone is already able to read when the first
   * message lands.
   *
   * Warming is best-effort: a backend that fails to open a thread (a missing ACP
   * agent, an unadvertised model) records the error on that member and leaves the
   * rest of the room usable, because the next delivery will retry the thread on
   * demand.
   */
  async prewarmMembers() {
    const results = await Promise.all(
      this.members.map(async (member) => {
        try {
          const pool = this._poolFor(member);
          // Opening an ACP session costs a real agent process, and the add-member
          // path promises to spawn it lazily. The fixture and DSH agents are
          // cheap, but a third-party harness need not be, so ACP members wait for
          // their first delivery. Codex app-servers are already running for the
          // room, so warming those threads costs nothing extra.
          if (pool.supportsInject === false) return null;
          await this.ensureThread(member);
          if (!member.error) member.error = null;
          return null;
        } catch (error) {
          member.error = error.message;
          return `${member.id}: ${error.message}`;
        }
      }),
    );
    const failed = results.filter(Boolean);
    if (failed.length) this.emit('log', `prewarm failed for ${failed.join(' | ')}`);
    this.emit('update', this.snapshot());
    return failed.length;
  }

  /**
   * The models a backend genuinely offers.
   *
   * A pool may answer `modelCapabilities()` with a synthetic placeholder before
   * it has ever opened a session: ACP reveals its catalogue only inside
   * `session/new`'s `configOptions`, so the backend advertises `acp-default` in
   * the meantime. Treating that placeholder as a real model made the room
   * "correct" a perfectly good configured model down to it — every ACP member
   * ended up reading `model: acp-default` with a bogus
   * `model deepseek-v4-flash not offered` error, and because the room then asked
   * the agent for a model that does not exist, the requested model was never
   * applied at all. Only real entries count here.
   */
  _offeredModels(backend) {
    const caps = (this.capabilitiesByBackend && this.capabilitiesByBackend.get(backend)) || new Map();
    return new Map(Array.from(caps).filter(([, entry]) => !entry || !entry.synthetic));
  }

  /**
   * Re-read each backend's model list and re-point members whose configured
   * model that backend does not offer.
   *
   * Capabilities are per backend, not per room: an ACP harness advertises a
   * different catalogue from codex, so a member's fallback must be chosen from
   * its own provider's list.
   *
   * Pass `{ correct: false }` to only re-read the catalogues. That is what the
   * thread-opening path wants: an agent may reveal its real catalogue there, and
   * the UI must be able to offer those models — but a member must not be
   * silently re-labelled, because the thread just opened is pinned to the model
   * it was handed, so a new `member.model` would be a claim the session is not
   * honouring.
   */
  async _refreshCapabilities(options = {}) {
    const correct = options.correct !== false;
    this.modelCapabilities = new Map();
    for (const [backend, pool] of this.pools) {
      let capabilities;
      try {
        capabilities = await pool.modelCapabilities();
      } catch (error) {
        this.emit('log', `capabilities ${backend} failed: ${error.message}`);
        capabilities = new Map();
      }
      this.capabilitiesByBackend = this.capabilitiesByBackend || new Map();
      this.capabilitiesByBackend.set(backend, capabilities);
      for (const [model, caps] of capabilities) this.modelCapabilities.set(model, caps);
    }
    const primary = this._offeredModels(this.primaryBackend);
    this.availableModels = Array.from(primary.keys());
    if (!correct) return;
    for (const member of this.members) {
      const offered = this._offeredModels(member.backend);
      // A backend that offers nothing real (an ACP harness whose catalogue we
      // have not seen yet) must not be "corrected" — its model is whatever the
      // agent says it is. A member with no model at all is in the same position:
      // the request was "let the agent decide", so there is nothing to correct
      // and inventing one would be a claim the user never made.
      if (!offered.size || !member.model) {
        member.error = null;
        continue;
      }
      if (!offered.has(member.model)) {
        const fallback = offered.has('gpt-5.6-sol') ? 'gpt-5.6-sol' : Array.from(offered.keys())[0];
        member.error = `model ${member.model} not offered; using ${fallback}`;
        member.model = fallback;
      } else {
        member.error = null;
      }
    }
  }

  /**
   * Pick a legal reasoning effort. The advertised capability table is not
   * trustworthy — `model/list` omits `none` from every entry, yet 5 of 7 models
   * accept it while `gpt-6.1-sol` and `gpt-6-astra` reject it with HTTP 400 —
   * so CHAT's "cheapest" setting is negotiated per member, and once the server
   * has rejected one we use its own answer instead of advertising.
   */
  effortFor(member) {
    const caps = this.modelCapabilities && this.modelCapabilities.get(member.model);
    const wanted = MODES[this.mode].effort;
    const supported = (caps && caps.efforts) || [];
    if (!supported.length) return wanted;
    if (supported.includes(wanted)) return wanted;
    if (this.mode === 'chat') {
      // Ascend through the cheapest available settings.
      for (const candidate of ['none', 'low', 'medium']) {
        if (supported.includes(candidate)) return candidate;
      }
    } else {
      for (const candidate of ['high', 'xhigh', 'medium', 'max', 'low']) {
        if (supported.includes(candidate)) return candidate;
      }
    }
    return caps.defaultEffort || supported[0];
  }

  serviceTierFor(member) {
    const caps = this.modelCapabilities && this.modelCapabilities.get(member.model);
    if (!caps || !caps.serviceTiers || !caps.serviceTiers.includes('priority')) return undefined;
    return this.mode === 'chat' ? 'priority' : undefined;
  }

  /**
   * Make sure one member has a warm thread, with the persona pinned.
   *
   * A thread is rebuilt whenever the sandbox mode changes (CHAT is `read-only`,
   * WORK is `danger-full-access`, and sandbox is a thread-level codex
   * parameter). A rebuilt thread has empty model-visible history, so the member
   * cursor must rewind to 0 — otherwise the next turn's delta would be empty and
   * the fresh thread would answer with no idea what the room has been saying.
   */
  async ensureThread(member) {
    const pool = this._poolFor(member);
    // A backend whose process died (crashed, was killed, ran out of memory) must
    // be brought back before we try to talk to it. Without this the room would
    // keep answering HTTP 200 while every turn vanished into a dead pipe: the
    // pools clear their memoized `ready` on exit precisely so this can work.
    if (typeof pool.running === 'boolean' && !pool.running && typeof pool.start === 'function') {
      try {
        await pool.start();
        await this._refreshCapabilities();
        this.emit('log', `restarted backend ${member.backend || this.primaryBackend}`);
      } catch (error) {
        member.error = error.message;
        throw error;
      }
    }
    const existing = pool.getThread(member.id);
    const sandbox = this.mode === 'work' ? 'danger-full-access' : 'read-only';
    if (existing && existing.sandbox === sandbox) return existing;
    if (existing) {
      pool.closeThread(member.id);
      // A rebuilt thread has no history at all, so every past record must be
      // replayed into it on the next turn: rewind the cursor to zero and drop
      // whatever was buffered against the old thread (its ids meant nothing to
      // the new one).
      this._rewindMember(member);
      member.threadGen += 1;
    } else if (member.cursor > 0 || member.turns > 0) {
      // No thread, yet this member had already been reading the room: the thread
      // it was reading from is gone. That is the crash case — the pool drops its
      // thread records when the child dies (those ids belong to a dead process),
      // so `getThread` returns nothing and the `existing` branch above never
      // runs. Without rewinding here, the member would open a brand-new empty
      // thread and be handed an empty delta: it would answer with no idea what
      // the room had been saying, silently, forever.
      this._rewindMember(member);
      member.threadGen += 1;
      this.emit('log', `${member.id}: thread vanished (backend restarted?) — replaying the room`);
    }
    const developer = [
      `你在一个多 AI 群聊房间里，你的身份是 @${member.id}（显示名 ${member.label}）。`,
      '房间里的对话对所有成员公开，你能看到别人说了什么。',
      member.persona,
      '只以你自己的身份发言。不要假装是别人，不要冒充人类用户，不要输出 "@你: " 这样的前缀。',
      '需要点名其他成员时在正文里写 @对方的 id。',
    ]
      .filter(Boolean)
      .join('\n');
    const thread = await pool.openThread(member.id, {
      model: member.model,
      // R2: the working directory is chosen by BACKEND, not by room. Every codex
      // session in the process shares one directory; every ACP session shares
      // another. It comes from configuration only — a room cannot pick it, and
      // neither can a member — because a session's cwd is fixed when it is
      // created (ACP has no `session/set_cwd`; codex pins cwd at `thread/start`).
      cwd: this._workspaceDirFor(member.backend) || this.cwd,
      sandbox,
      approvalPolicy: 'never',
      developerInstructions: developer,
    });
    /**
     * A session now exists that the host may want to file somewhere.
     *
     * Emitted rather than handled here because the filing is host business: the
     * codex side wants a codex project, the ACP side wants a DSH workspace row,
     * and neither concept exists in this engine (which the offline tests run
     * with no host attached at all). `thread.id` is the session id on both
     * backends — for ACP it is verbatim the `session/new` id, which is also the
     * id DSH stores the session under.
     */
    this.emit('session', {
      roomId: this.id,
      memberId: member.id,
      backend: member.backend || this.primaryBackend,
      sessionId: thread && thread.id,
      cwd: (thread && thread.cwd) || this._workspaceDirFor(member.backend) || this.cwd,
      model: member.model,
      label: member.label,
    });
    // Opening a session is where an ACP agent finally reveals its real model
    // catalogue (inside `session/new`'s `configOptions`). Re-read the catalogues
    // so `GET /models` can offer those models — but do NOT re-point members
    // (`correct: false`): this thread is already pinned to the model it was
    // handed, so a new `member.model` would be a claim the session is not
    // honouring.
    try {
      await this._refreshCapabilities({ correct: false });
    } catch (error) {
      this.emit('log', `capabilities refresh after opening ${member.id} failed: ${error.message}`);
    }
    return thread;
  }

  /** Answer a codex approval request without stalling the turn. */
  async _onServerRequest(method) {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval':
        return { decision: 'accept' };
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval':
        return { decision: 'accept' };
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' };
      case 'item/tool/requestUserInput':
        return { answers: {} };
      case 'mcpServer/elicitation/request':
        return { action: 'decline' };
      case 'attestation/generate':
        return {};
      default:
        return {};
    }
  }

  setMode(mode) {
    if (!MODES[mode]) throw new Error('unknown mode: ' + mode);
    if (this.mode === mode) return this.mode;
    this.mode = mode;
    this.pushSystem(`房间切换到 ${MODES[mode].label} 模式。`);
    this.emit('update', this.snapshot());
    return this.mode;
  }

  setReplyPolicy(policy) {
    if (!['addressed', 'everyone', 'mentioned-only'].includes(policy)) {
      throw new Error('unknown replyPolicy: ' + policy);
    }
    this.replyPolicy = policy;
    this._saveRoster();
    this.emit('update', this.snapshot());
    return policy;
  }

  pushSystem(text) {
    return this.append({ authorId: 'system', authorLabel: '系统', text, kind: 'system' });
  }

  append(entry) {
    this.logSeq += 1;
    /**
     * The attachments are normalized before the text, because the text may
     * depend on them: a message that is nothing but a file still needs a
     * readable record, and the fallback has to name the files. Done here rather
     * than in `say` so every other caller (`pushSystem`, the roster notices, a
     * test that appends directly) gets a record with real text too.
     */
    const attachments = normalizeAttachments(entry.attachments);
    const text = String(entry.text == null ? '' : entry.text) || (attachments.length ? attachmentSummary(attachments) : '');
    const record = {
      seq: this.logSeq,
      id: 'm' + this.logSeq,
      ts: nowIso(),
      authorId: entry.authorId,
      authorLabel: entry.authorLabel || entry.authorId,
      text,
      kind: entry.kind || (entry.authorId === 'user' ? 'user' : 'agent'),
      mentions: entry.mentions || [],
      streaming: !!entry.streaming,
      mode: this.mode,
      /**
       * Files and images the author attached, already stored on disk.
       *
       * Persisted with the record because the path IS the message as far as a
       * room's agents are concerned: a replayed history that dropped these would
       * show the user saying "look at this" with nothing to look at. The store
       * owns the bytes and is append-only, so a stored path stays valid.
       */
      attachments,
    };
    this.log.push(record);
    this._appendLogLine(record);
    this.emit('message', record);
    this.emit('update', this.snapshot());
    this._capture(record);
    return record;
  }

  /**
   * Fold a new record into every member's accumulation buffer.
   *
   * There is no longer any "push it into the thread right now" path: the one
   * delivery channel is the segment (see the file header). Capturing is pure
   * bookkeeping — no I/O, no awaits — so `append` stays synchronous and the
   * HTTP handler can answer as soon as the message is in the log.
   *
   * The author is skipped: its own line is already in its own session as its
   * own output, and repeating it back would read as a teammate quoting it.
   */
  _capture(record) {
    if (record.kind === 'system') return;
    for (const member of this.members) {
      if (member.id === record.authorId) continue;
      this._addLineToSegment(member, record);
    }
    if (this.segmentMs > 0 || this.queueStallMs > 0) this._ensureTicker();
  }

  /**
   * Put one record into a member's buffer, honoring the merge rule.
   *
   * The rule the user asked for is "merge only while the previous stretch has
   * NOT been started". A buffer the member has not begun reading is exactly the
   * one at the tail of `member.segments`, so merging is legal there; a buffer
   * that has been sealed and queued behind a running turn is also unread, but
   * merging into the middle of the queue would reorder the room for that
   * member, so the tail is the only place a merge happens.
   */
  _addLineToSegment(member, record) {
    const line = this._formatRecord(member, record);
    const cost = line.length + 1;
    let tail = member.segments.length ? member.segments[member.segments.length - 1] : null;
    // Length truncation: rather than let one segment grow without bound, close
    // it and open a new one, so one tick can become several turns instead of one
    // enormous prompt. That is the "分为多个" half of the user's rule.
    if (tail && tail.chars + cost > this.maxSegmentChars) {
      tail.sealedAt = tail.sealedAt || Date.now();
      tail = null;
    }
    if (!tail) {
      tail = {
        id: `${member.id}-s${this.segmentSeq++}`,
        lines: [],
        chars: 0,
        firstSeq: record.seq,
        lastSeq: record.seq,
        createdAt: Date.now(),
        sealedAt: null,
        /**
         * Who this segment named. `_turnInstruction` reads it to tell a member
         * "this segment points at you" from "you are only reading along", which
         * is the one thing `replyPolicy` still needs to know.
         */
        mentions: new Set(),
        /**
         * Every attachment named by the records in this segment.
         *
         * Separate from `lines` because the line only carries a path as prose:
         * a backend that can show an image to its model needs the structured
         * entry, and re-deriving one by parsing the transcript back out would be
         * a parser nobody asked for.
         */
        attachments: [],
      };
      member.segments.push(tail);
    }
    tail.lines.push(line);
    tail.chars += cost;
    tail.lastSeq = record.seq;
    for (const id of record.mentions || []) tail.mentions.add(id);
    for (const attachment of normalizeAttachments(record.attachments)) tail.attachments.push(attachment);
    member.cursor = Math.max(member.cursor, record.seq);
    this._boundQueue(member);
  }

  /**
   * Keep the backlog bounded without dropping anyone's words.
   *
   * A member stuck behind one very long turn accumulates a segment per tick.
   * Shedding the oldest would silently lose room content, so adjacent old
   * segments are instead coalesced while the result still fits a single
   * `maxSegmentChars` chunk. That bounds growth in the normal case; the true
   * escape hatch for a genuinely wedged turn is `_enforceStall`, which
   * interrupts it (see `queueStallMs`).
   */
  _boundQueue(member) {
    const limit = Math.max(1, this.maxQueuedSegments);
    let guard = member.segments.length;
    while (member.segments.length > limit && guard-- > 0) {
      const first = member.segments[0];
      const second = member.segments[1];
      if (!second || second.chars + first.chars > this.maxSegmentChars) {
        // Cannot merge without breaking the length bound. Drop the oldest
        // segment's *lines* into an explicit truncation notice rather than
        // pretending they were delivered.
        if (!first.truncated) {
          first.truncated = true;
          first.lines.push(`（更早的 ${first.lines.length} 条记录因积压被略过）`);
          member.shed += 1;
          this.emit('log', `${member.id}: backlog over ${limit} segments — dropping the oldest`);
        }
        member.segments.splice(0, 1);
        continue;
      }
      first.lines = first.lines.concat(second.lines);
      first.chars += second.chars;
      first.lastSeq = second.lastSeq;
      for (const id of second.mentions) first.mentions.add(id);
      // Coalescing must not lose the structured attachments: the merged segment
      // is delivered as one turn, so it has to name every file either half had.
      first.attachments = (first.attachments || []).concat(second.attachments || []);
      member.segments.splice(1, 1);
    }
  }

  /**
   * One record as this member should read it, stamped with when it entered the
   * room.
   *
   * The time is written by the plugin at append time, never taken from an
   * agent's output — the user asked for exactly that. No harness protocol
   * carries a timestamp on a prompt (codex's `UserInput` has no such field, ACP
   * has none either), so the only place it can live is the text itself.
   *
   * Attribution is the other half: the codex wire treats a turn's `input` as
   * user-role content, which the model correctly reads as *someone else's*
   * speech. Injecting an equivalent transcript with `role:"assistant"` instead
   * makes the model claim those words as its own (verified in
   * `_research/spike-codex/INJECT_ITEMS_REPORT.md`), so lines are framed as a
   * quoted transcript and never as assistant output.
   */
  _formatRecord(member, record) {
    const clock = timeOfDay(record.ts);
    const stamp = clock ? `[${clock}] ` : '';
    /**
     * Attachment paths ride along with the record they belong to, indented
     * under it, so a member reads "the user said X, and X came with these two
     * files" as one thought rather than as a file list unrelated to its message.
     * They are appended after the text for both branches: a user message and an
     * agent message can each carry attachments.
     */
    const files = attachmentLines(normalizeAttachments(record.attachments));
    const first = record.kind === 'user'
      ? `${stamp}[用户] ${record.text}`
      : (() => {
          const prefix = record.authorId === member.id ? `[你自己 @${record.authorId}]` : `[@${record.authorId}]`;
          const unfinished = record.partial ? '（未说完就被打断）' : '';
          return `${stamp}${prefix} ${record.text}${unfinished}`;
        })();
    return [first, ...files].join('\n');
  }

  /** Append one record to the JSONL history file. Best-effort, never throws. */
  _appendLogLine(record) {
    if (!this.logFile) return;
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (error) {
      this.emit('log', `log append failed: ${error.message}`);
    }
  }

  /**
   * Rebuild `this.log` from the JSONL history file.
   *
   * A room that was recycled (idle TTL) keeps its memory this way: only the
   * processes go away. A corrupt trailing line — the normal shape of a crash
   * mid-append — is skipped rather than admitted, because one bad line must not
   * cost the whole history.
   */
  _loadLog() {
    if (!this.logFile) return 0;
    let raw;
    try {
      raw = fs.readFileSync(this.logFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.emit('log', `log read failed: ${error.message}`);
      return 0;
    }
    const records = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed);
        if (record && typeof record.text === 'string' && record.kind !== 'system') records.push(record);
      } catch {
        // Partial write at the tail of the file: ignore this one line only.
      }
    }
    if (!records.length) return 0;
    this.log = records;
    this.logSeq = records.reduce((max, record) => Math.max(max, Number(record.seq) || 0), 0);
    return records.length;
  }

  /**
   * Start the segment ticker if it is not already running.
   *
   * Deliberately not started in the constructor: a room that is never spoken to
   * should not hold a timer, and `dispose()` must be able to prove it stopped
   * one. `unref` so a pending tick never keeps the DSH process alive.
   */
  _ensureTicker() {
    if (this.tickTimer) return;
    // The tick does two jobs — hand over pending segments and abandon wedged
    // turns — so it must run if EITHER is configured. A room with
    // `segmentMs: 0` (delivery only on `say`/`@`) still needs the stall check.
    const interval = this.segmentMs > 0 ? this.segmentMs : this.queueStallMs;
    if (!(interval > 0)) return;
    this.tickTimer = setInterval(() => {
      void this._tick();
    }, interval);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  /**
   * The escape hatch for a turn that will never come back.
   *
   * A wedged turn blocks its member's queue indefinitely — the queue drains
   * only when the previous turn settles on the server, and a stuck turn has
   * been observed to hold a queue for over a minute with no sign of draining.
   * Worse, `turn/interrupt` on a turn that already ended by interruption never
   * gets a JSON-RPC reply at all, so we may send it exactly once per running
   * segment. If the turn is still there one `queueStallMs` after we asked, we
   * stop waiting on the process and reset the member's delivery state, then let
   * the pending segments flow: the alternative is a member that is silently
   * mute for the rest of the process's life.
   */
  async _enforceStall(now = Date.now()) {
    if (!(this.queueStallMs > 0)) return;
    for (const member of this.members) {
      const segment = member.running;
      if (!segment) continue;
      if (!segment.startedAt) {
        segment.startedAt = now;
        continue;
      }
      if (now - segment.startedAt < this.queueStallMs) continue;
      const pool = this._poolFor(member, false);
      if (!member.stallWarned) {
        member.stallWarned = true;
        member.stalls = (member.stalls || 0) + 1;
        // Ask once. A second `turn/interrupt` on an already-interrupted turn is
        // the documented way to hang a request forever.
        try {
          if (pool && typeof pool.interrupt === 'function') await pool.interrupt(member.id);
        } catch (error) {
          this.emit('log', `stall interrupt ${member.id} failed: ${error.message}`);
        }
        this.emit('log', `${member.id}: turn stuck for ${Math.round((now - segment.startedAt) / 1000)}s — interrupting`);
        continue;
      }
      // Still stuck after the warning: unblock the queue by hand. The segment's
      // text goes back to the front of the backlog so the next turn still reads
      // it, and the provider is abandoned as unusable for this member.
      segment.interrupted = true;
      member.carryOver = [segment.lines.join('\n'), member.carryOver].filter(Boolean).join('\n');
      member.running = null;
      this.busy.delete(member.id);
      member.status = 'idle';
      member.stalls = (member.stalls || 0) + 1;
      this.emit('log', `${member.id}: turn still stuck — requeueing its text and freeing the queue`);
      this.emit('stream', { type: 'agent-end', memberId: member.id, liveId: `live-${member.id}-${segment.id}`, timedOut: true });
      this.emit('update', this.snapshot());
      if (this._hasPending(member)) {
        setTimeout(() => {
          void this._deliver(member).catch((error) => this.emit('log', `post-stall delivery for ${member.id} failed: ${error.message}`));
        }, 0);
      }
    }
  }

  /**
   * Is there anything this member has not been handed yet?
   *
   * Two shapes, and forgetting the second one is easy: queued segments, and the
   * `carryOver` a preemption leaves behind. Both must count everywhere "is this
   * member done" is asked, or a member whose only pending text is carryOver
   * looks finished while it silently holds unread lines forever.
   */
  _hasPending(member) {
    return member.segments.length > 0 || Boolean(member.carryOver);
  }

  async _tick() {
    await this._enforceStall();
    const idle = this.members.filter((member) => !member.running && this._hasPending(member));
    if (!idle.length) return;
    await Promise.all(
      idle.map(async (member) => {
        try {
          await this._deliver(member);
        } catch (error) {
          this.emit('log', `segment tick for ${member.id} failed: ${error.message}`);
        }
      }),
    );
  }

  /**
   * Hand a member its oldest unread segment, if it is free.
   *
   * This is the only path that starts a turn, which is what makes "busy queues"
   * true by construction rather than by a check somebody can forget.
   */
  async _deliver(member) {
    if (member.running) return { memberId: member.id, skipped: 'busy' };
    let segment = member.segments.shift();
    if (!segment && member.carryOver) {
      // Text a preempted turn never got to read has no segment of its own — the
      // preemption took it out of the buffer on purpose. Without this the member
      // would report `empty` forever while its unread text sat in `carryOver`.
      // The id still comes from the same counter, so a stale one stays detectable.
      segment = {
        id: `${member.id}-s${this.segmentSeq++}`,
        lines: [],
        chars: 0,
        firstSeq: member.cursor,
        lastSeq: member.cursor,
        createdAt: Date.now(),
        sealedAt: Date.now(),
        mentions: new Set(),
        carryOnly: true,
        // Text carried over from a preempted turn may have named files; the
        // paths are already inside the carried text, so nothing structured is
        // replayed for them — a second copy would re-send the same image.
        attachments: [],
      };
    }
    if (!segment) return { memberId: member.id, skipped: 'empty' };
    return this._runSegment(member, segment);
  }

  /**
   * Read one segment and let the member answer.
   *
   * The turn body is the segment's lines and nothing else: no "since the last
   * delivery" recomputation, no replay of the whole room. What the member reads
   * is exactly what was captured for it, which is what makes the delivery
   * auditable from the snapshot.
   */
  async _runSegment(member, segment) {
    const pool = this._poolFor(member);
    member.running = segment;
    member.segmentsSent += 1;
    member.stallWarned = false;
    segment.startedAt = Date.now();
    this.busy.add(member.id);
    member.status = 'thinking';
    member.error = null;
    this.emit('update', this.snapshot());
    const mode = MODES[this.mode];
    const liveId = `live-${member.id}-${segment.id}`;
    this.emit('stream', { type: 'agent-start', memberId: member.id, liveId, segmentId: segment.id });

    try {
      const thread = await this.ensureThread(member);
      let lines = segment.lines.slice();
      // A session that was just rebuilt has no history, so it gets the whole
      // room rather than "what arrived since the last delivery". The replay also
      // advances the cursor, so nothing here is delivered twice.
      if (member.needsReplay) {
        member.needsReplay = false;
        lines = this._replayLines(member);
      }
      // Text a PREEMPTED turn may have already half-consumed goes in first: the
      // session cannot tell us whether it reached the model's history, and
      // saying it twice is recoverable while never saying it is not.
      if (member.carryOver) {
        lines.unshift(member.carryOver);
        member.carryOver = '';
      }
      const instruction = [mode.instruction, this._turnInstruction(member, segment)].filter(Boolean).join('\n');
      const body = [
        '[房间广播] 以下是你还没读到的群聊记录，每一行都标了发言人（方括号里是房间时钟）。',
        lines.length ? lines.join('\n') : '(没有新内容)',
        '---',
        instruction,
      ].join('\n\n');

      const result = await pool.runTurn(member.id, {
        text: body,
        /**
         * The structured files this segment named, for backends that can hand a
         * model an actual image instead of a path. Every pool must tolerate the
         * field: one that only speaks text ignores it and relies on the paths
         * already embedded in `text`.
         */
        attachments: segment.attachments || [],
        effort: this.effortFor(member),
        serviceTierForTurn: this.serviceTierFor(member),
        sandboxPolicy: mode.sandboxPolicy,
        onDelta: (text) => this.emit('stream', { type: 'delta', memberId: member.id, liveId, delta: text }),
        onItem: (item) => this.emit('stream', { type: 'item', memberId: member.id, liveId, item: summarizeItem(item) }),
      });

      member.status = 'idle';
      member.turns += 1;
      // The thread is in the store the harness's own grouping consults only
      // after it has spoken, so this is the first moment a sync can succeed. The
      // thread id is passed along because the pool must not guess: it also holds
      // prewarmed threads that never spoke, and importing one of those fails the
      // whole rotation.
      this._scheduleGrouping(member.backend || this.primaryBackend, thread && thread.id);
      const usage = result.usage || {};
      const total = usage.total || {};
      if (total.totalTokens) {
        member.tokens += total.totalTokens;
        member.cachedTokens += total.cachedInputTokens || 0;
      }
      if (usage.modelContextWindow) member.contextWindow = usage.modelContextWindow;
      const text = (result.text || '').trim();
      member.lastText = text;
      if (!text) {
        this.emit('stream', { type: 'agent-end', memberId: member.id, liveId, segmentId: segment.id, empty: true });
        return { memberId: member.id, empty: true };
      }
      // A member told to answer only if it has something to add replies with
      // this marker when it does not. That is protocol, not room speech: posting
      // it as a bubble would put a fake utterance in the shared log that later
      // agents would read back as something a teammate actually said.
      if (isNoAddendum(text)) {
        member.silentTurns = (member.silentTurns || 0) + 1;
        this.emit('stream', { type: 'agent-end', memberId: member.id, liveId, segmentId: segment.id, empty: true, silent: true });
        return { memberId: member.id, empty: true, silent: true };
      }
      const record = this.append({
        authorId: member.id,
        authorLabel: member.label,
        text,
        kind: 'agent',
        mentions: parseMentions(text, this.members),
      });
      this.emit('stream', { type: 'agent-end', memberId: member.id, liveId, segmentId: segment.id, record });
      // An agent that names another agent wakes them now, within the hop budget.
      this._enqueueRelay(record, 0, segment);
      return { memberId: member.id, record };
    } catch (error) {
      member.status = 'error';
      member.error = error.message;
      this.emit('stream', { type: 'agent-end', memberId: member.id, liveId, segmentId: segment.id, error: error.message });
      return { memberId: member.id, error: error.message };
    } finally {
      member.running = null;
      this.busy.delete(member.id);
      if (member.status === 'thinking') member.status = 'idle';
      this.emit('update', this.snapshot());
      // A segment that arrived while this one ran must not wait for the next
      // tick: the member is free right now, and making it idle for up to 30s
      // with work already queued is exactly the stall the user complained about.
      if (this._hasPending(member) && !this.busy.has(member.id)) {
        setTimeout(() => {
          void this._deliver(member).catch((error) => this.emit('log', `chained delivery for ${member.id} failed: ${error.message}`));
        }, 0);
      }
    }
  }

  /**
   * R4: make an `@` land NOW.
   *
   * Two mechanisms, because the harnesses differ:
   *   - codex can accept mid-turn input (`turn/steer`), so the content that was
   *     waiting goes straight into the turn already running. Nothing is
   *     interrupted and nothing is repeated.
   *   - ACP has no such call at all (the whole protocol has no steering verb),
   *     so the running turn is cancelled and the content is carried over to the
   *     member's next delivery.
   *
   * Returns `{memberId, steered|preempted|skipped|record|error}`, or `null` when
   * the member had nothing pending at all.
   */
  async _preempt(member) {
    if (!member.running) {
      // Nothing in flight, so there is nothing to interrupt: hand the pending
      // stretch over as an ordinary delivery. Taking ownership of the text and
      // then discovering there is no turn to put it in would lose it.
      if (!this._hasPending(member)) return null;
      return this._deliver(member);
    }
    const pool = this._poolFor(member);
    // Everything captured but not yet handed over is "the current stretch".
    const pending = this._takePending(member);
    if (typeof pool.supportsSteer === 'boolean' && pool.supportsSteer && typeof pool.steer === 'function') {
      try {
        const result = await pool.steer(member.id, pending || '(无新内容)');
        if (result && result.ok) {
          member.steered = (member.steered || 0) + 1;
          this.emit('stream', { type: 'steer', memberId: member.id, text: pending });
          // Steered, not answered: the text joined a turn that is still
          // running, so there is no new record to report yet.
          return { memberId: member.id, steered: true };
        }
      } catch (error) {
        this.emit('log', `steer ${member.id} failed: ${error.message}`);
      }
    }
    // No steering: cancel, and hand the in-flight text to the next segment
    // because we cannot know whether the model had already read it.
    const inflight = member.running.lines.join('\n');
    member.carryOver = [inflight, pending, member.carryOver].filter(Boolean).join('\n');
    member.running.interrupted = true;
    member.preempted = (member.preempted || 0) + 1;
    try {
      await pool.interrupt(member.id);
    } catch (error) {
      this.emit('log', `interrupt ${member.id} failed: ${error.message}`);
    }
    return { memberId: member.id, preempted: true };
  }

  /**
   * Pull everything the member has captured but not yet read, and forget it.
   *
   * Used by preemption, which takes ownership of that text: either it is steered
   * into the running turn or carried into the next one. Leaving it in the buffer
   * as well would deliver it twice.
   */
  _takePending(member) {
    const lines = [];
    for (const segment of member.segments) lines.push(...segment.lines);
    member.segments = [];
    return lines.join('\n').trim();
  }

  /** Append a human message, then serve it. */
  async say(text, options = {}) {
    const body = String(text || '').trim();
    const attachments = normalizeAttachments(options.attachments);
    // A message may be *only* an attachment: "look at this" is often just the
    // file. Requiring prose would make the common case impossible.
    if (!body && !attachments.length) return { delivered: [], entries: [] };
    const authorId = options.authorId || 'user';
    const mentions = parseMentions(body, this.members);
    this.relayBudget.clear();
    this.cascadeRemaining = this.maxRelayHops;
    const first = this.log.length === 0;
    const entry = this.append({
      authorId,
      authorLabel: options.authorLabel || (authorId === 'user' ? '你' : authorId),
      // `append` supplies the attachment-only placeholder, so `say` passes the
      // text through as written rather than inventing a second fallback.
      text: body,
      mentions,
      kind: authorId === 'user' ? 'user' : 'agent',
      attachments,
    });
    // The room's opening message and any `@` are served now; everything else
    // waits for the tick so that a busy human typing three lines gets one turn,
    // not three.
    const delivered = first || mentions.length ? await this._serveNow(mentions) : [];
    return { entry, delivered, served: delivered, mentions };
  }

  /**
   * Serve the members an immediate trigger names, or the whole room when the
   * trigger is the room's first message.
   *
   * Each entry is `{memberId, record?, empty?, error?}`. `record` is present
   * only when that member actually produced room speech in this call, which is
   * what lets a caller tell "answered" from "was woken and declined" without
   * re-reading the log — and is why a declined turn carries no `record` rather
   * than an empty one.
   */
  async _serveNow(mentions) {
    const targets = mentions.length
      ? mentions.map((id) => this._member(id)).filter(Boolean)
      : this.members.slice();
    const results = [];
    for (const member of targets) {
      try {
        // `_preempt` also handles the idle case (deliver straight away) and
        // returns null when the member had nothing pending.
        const outcome = await this._preempt(member);
        if (outcome) results.push(outcome);
      } catch (error) {
        results.push({ memberId: member.id, error: error.message });
      }
    }
    return results;
  }

  /**
   * Wake members an agent named, within the cascade budget.
   *
   * An immediate `@` between agents is the one way this room can spend money
   * without a human in the loop, so it is budgeted rather than trusted: two
   * agents that keep naming each other would otherwise hand the room back and
   * forth forever. The budget refills on every human message and bounds only
   * *immediacy* — the words themselves were already captured for every member,
   * so a member that does not get an instant turn still reads the same segment
   * on the next tick.
   */
  _enqueueRelay(record, hop, segment) {
    const named = (record.mentions || []).filter((id) => id !== record.authorId && this._member(id));
    if (!named.length) return;
    const key = record.id;
    if (this.relayBudget.has(key)) return;
    this.relayBudget.set(key, true);
    for (const id of named) {
      const member = this._member(id);
      if (!member) continue;
      if (!member.running && !this._hasPending(member)) continue;
      if (this.cascadeRemaining <= 0) {
        this.emit('log', `relay budget spent — @${id} will read it on the next tick`);
        continue;
      }
      this.cascadeRemaining -= 1;
      // The naming agent's own words are already in that member's buffer (every
      // record is captured for every member), so the only thing an agent-to-agent
      // `@` needs to add is immediacy — same rule as a human `@`.
      void this._preempt(member).catch((error) => this.emit('log', `relay preempt ${id} failed: ${error.message}`));
    }
  }

  /**
   * How this member should read this segment.
   *
   * `replyPolicy` no longer chooses the audience — the segment has already gone
   * to everyone. It chooses only whether a member that was NOT named is being
   * asked to answer, or merely given the room to read. Either way the member
   * decides for itself, and the agreed marker for "nothing to add" is
   * `(无补充)`.
   */
  _turnInstruction(member, segment) {
    const named = segment && segment.mentions && segment.mentions.has(member.id);
    if (named) {
      return `这一段点到了你（@${member.id}），请给出你的回答。房间里的其他成员也能看到这段内容，所以不要写只对某个人说的私密内容。`;
    }
    if (this.replyPolicy === 'everyone') {
      return `房间里出现了新内容。你是这个房间的成员，请给出你的观点；如果确实没有补充，只回复 “(无补充)”。`;
    }
    if (this.replyPolicy === 'mentioned-only') {
      return `房间里出现了新内容，但这一段没有点名你。你只是在旁听：请只回复 “(无补充)”，除非你发现了必须立刻指出的严重问题。`;
    }
    return `这一段没有点名你，但你在房间里，可以读到全部内容。请给出你的观点；如果确实没有补充，只回复 “(无补充)”。`;
  }

  /**
   * Ask every busy member to stop.
   *
   * `turn/interrupt` is only safe to send once per active turn — a second call
   * on an already-interrupted turn has been observed to hang with no JSON-RPC
   * reply at all — so the pool owns a timeout and this never retries.
   */
  async interruptAll() {
    const busy = Array.from(this.busy);
    const stopped = [];
    for (const id of busy) {
      try {
        const member = this._member(id);
        const pool = member ? this._poolFor(member, false) : null;
        if (pool && (await pool.interrupt(id))) stopped.push(id);
      } catch (error) {
        this.emit('log', `interrupt ${id} failed: ${error.message}`);
      }
    }
    return stopped;
  }

  /**
   * Add a member at runtime.
   *
   * "Adding a teammate" is exactly "opening one more session with a backend" —
   * the member carries its own `backend`, so a room may mix a codex thread and,
   * say, an ACP harness without the engine noticing. The new thread is opened
   * lazily on its first turn so adding five members costs nothing until they
   * speak; `connect()` is called for a backend that has never been started.
   */
  async addMember(config) {
    const id = String(config && config.id ? config.id : '').trim();
    if (!id) throw new Error('member id is required');
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(id)) {
      throw new Error(`member id must be a single word (letters, digits, _ , -): ${id}`);
    }
    if (this._member(id)) throw new Error(`member already exists: ${id}`);
    const backend = config.backend || this.primaryBackend;
    const member = this._newMember({ ...config, id, backend });
    // A backend whose catalogue has not been read yet must be started and merged
    // before its member can be validated. The test is "do we know its models",
    // not "does a pool object exist": a pool can be pre-registered (or created
    // by `_poolFor` just now) without ever having been started, and validating a
    // model against a catalogue we never read would reject every model.
    const known = !!(this.capabilitiesByBackend && this.capabilitiesByBackend.has(backend));
    const pool = this._poolFor(member);
    if (!known) {
      try {
        // Only once the room itself is live: before `connect()` there is no
        // subprocess to talk to, and `connect()` will start every pool anyway.
        if (this.ready) {
          await pool.start();
          await this._refreshCapabilities();
        }
      } catch (error) {
        this.emit('log', `backend ${backend} failed to start: ${error.message}`);
        member.error = error.message;
      }
    }
    const offered = this._offeredModels(backend);
    // `!member.model` is "the user left it blank": keep the agent's own default
    // instead of substituting one of ours, and do not call that an error.
    if (member.model && offered.size && !offered.has(member.model)) {
      const fallback = offered.has('gpt-5.6-sol') ? 'gpt-5.6-sol' : Array.from(offered.keys())[0];
      member.error = `model ${member.model} not offered; using ${fallback}`;
      member.model = fallback;
    }
    this.members.push(member);
    // Warm the newcomer right away for the same reason `connect()` pre-warms: a
    // member with no thread pays the harness's cold start on its first turn, and
    // that stall happens while the room is already waiting on it. Best-effort —
    // a failure is recorded on the member and retried by `_runSegment`.
    if (this.ready && this.prewarm) {
      try {
        const pool = this._poolFor(member);
        if (pool.supportsInject !== false) await this.ensureThread(member);
      } catch (error) {
        member.error = error.message;
      }
    }
    this.pushSystem(`@${member.id}（${member.label}）加入了房间。`);
    this._saveRoster();
    this.emit('update', this.snapshot());
    return member;
  }

  /**
   * Remove a member.
   *
   * A running turn is interrupted first: closing a thread under an in-flight
   * turn leaves the pool's queue holding a promise that can never settle, and
   * the member would keep showing up in `busy` forever.
   */
  async removeMember(id) {
    const index = this.members.findIndex((member) => member.id === id);
    if (index < 0) throw new Error(`no such member: ${id}`);
    const member = this.members[index];
    if (this.busy.has(id)) {
      try {
        await this._poolFor(member, false)?.interrupt(id);
      } catch (error) {
        this.emit('log', `interrupt ${id} before removal failed: ${error.message}`);
      }
    }
    this.busy.delete(id);
    this.members.splice(index, 1);
    try {
      this._poolFor(member, false)?.closeThread(id);
    } catch (error) {
      this.emit('log', `closeThread ${id} failed: ${error.message}`);
    }
    this.pushSystem(`@${id} 离开了房间。`);
    this._saveRoster();
    this.emit('update', this.snapshot());
    return member;
  }

  /**
   * Re-point one member at another model.
   *
   * The thread is closed, not patched: a codex thread's model is fixed at
   * `thread/start`. The next turn opens a fresh thread on the new model, and
   * because a fresh thread has empty history the cursor rewinds to zero, so the
   * member is re-briefed from the log rather than answering with amnesia. The
   * cost is one cold start, not a lost conversation.
   */
  setMemberModel(id, model) {
    const member = this._member(id);
    if (!member) throw new Error(`no such member: ${id}`);
    const offered = this._offeredModels(member.backend);
    if (offered.size && !offered.has(model)) {
      throw new Error(`model not offered by ${member.backend}: ${model}`);
    }
    member.model = model;
    member.error = null;
    const pool = this._poolFor(member, false);
    if (pool && pool.getThread(id)) {
      pool.closeThread(id);
      this._rewindMember(member);
      member.threadGen += 1;
    }
    this._saveRoster();
    this.emit('update', this.snapshot());
    return member;
  }

  /** Change what a member is for. Rebuilds the thread, since persona is pinned there. */
  setMemberPersona(id, persona) {
    const member = this._member(id);
    if (!member) throw new Error(`no such member: ${id}`);
    member.persona = String(persona || '');
    const pool = this._poolFor(member, false);
    if (pool && pool.getThread(id)) {
      pool.closeThread(id);
      this._rewindMember(member);
      member.threadGen += 1;
    }
    this._saveRoster();
    this.emit('update', this.snapshot());
    return member;
  }

  /** Every model any backend in this room offers, tagged with its backend. */
  modelsByBackend() {
    const out = [];
    for (const [backend, caps] of this.capabilitiesByBackend || []) {
      for (const [model, entry] of caps) {
        // Skip synthetic placeholders: offering `acp-default` in the UI would be
        // offering a model that cannot be selected.
        if (entry && entry.synthetic) continue;
        out.push({ backend, model });
      }
    }
    return out;
  }

  /**
   * The backend names this room can put a member on.
   *
   * Configured-but-unused backends count, not just live pools: pools are created
   * lazily, so `{ acp: {...} }` in the config would otherwise stay invisible in
   * the add-member form until somebody had already added an ACP member — which
   * is exactly the state the user is in when they want to add one. Listing the
   * configuration is what makes the second path ("接别家 harness") reachable
   * from the UI at all.
   */
  backends() {
    const names = new Set(this.pools.keys());
    for (const name of Object.keys(this.backendOptions || {})) names.add(name);
    return Array.from(names);
  }

  setMemberLabel(id, label) {
    const member = this._member(id);
    if (!member) throw new Error(`no such member: ${id}`);
    member.label = String(label || id);
    this._saveRoster();
    this.emit('update', this.snapshot());
    return member;
  }

  /**
   * Persist the roster.
   *
   * Best-effort and synchronous: it runs on the way out of a mutating call, and
   * a room that cannot write its roster file must still serve the room.
   */
  _saveRoster() {
    if (!this.rosterFile) return;
    try {
      fs.mkdirSync(path.dirname(this.rosterFile), { recursive: true });
      const payload = { version: 1, replyPolicy: this.replyPolicy, members: this.members.map((m) => this.toConfig(m)) };
      fs.writeFileSync(this.rosterFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    } catch (error) {
      this.emit('log', `roster save failed: ${error.message}`);
    }
  }

  async dispose() {
    for (const pool of this.pools.values()) {
      try {
        await pool.stop();
      } catch (error) {
        this.emit('log', `pool stop failed: ${error.message}`);
      }
    }
    this.ready = false;
    this.emit('update', this.snapshot());
  }
}

function summarizeItem(item) {
  if (!item || !item.type) return { type: 'unknown' };
  switch (item.type) {
    case 'reasoning':
      return { type: 'reasoning', text: (item.text || '').slice(0, 400) };
    case 'commandExecution':
      return { type: 'command', command: item.command, status: item.status, exitCode: item.exitCode };
    case 'fileChange':
      return { type: 'fileChange', status: item.status, changes: (item.changes || []).length };
    case 'agentMessage':
      return { type: 'agentMessage', text: (item.text || '').slice(0, 2000) };
    case 'webSearch':
      return { type: 'webSearch', query: item.query };
    case 'error':
      return { type: 'error', message: item.message };
    default:
      return { type: item.type };
  }
}

module.exports = { AgentRoom, MODES, DEFAULT_MEMBERS, parseMentions, summarizeItem, isNoAddendum };
