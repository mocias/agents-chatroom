'use strict';
/**
 * Uploads for the room: the bytes a user attaches to a room message, stored
 * where the room's agents can read them.
 *
 * Why this exists at all, rather than reusing the harness's own uploader: the
 * agents in a room are child processes (codex app-server, an ACP harness) whose
 * only way to receive an image is a **filesystem path**. DSH's own uploader
 * hands the browser a receipt id and keeps the bytes behind its own attachment
 * service, so a receipt cannot be turned into a path from out here. The room
 * therefore stores its own bytes and passes paths, which is also what makes the
 * same upload work in the standalone page, where no DSH uploader exists.
 *
 * Two consequences worth stating:
 *
 *   - **Files are stored per user, not per room.** A path is baked into the
 *     JSONL history when the message is appended, so a room that is deleted and
 *     recreated must not orphan the pictures its history still refers to. The
 *     store is append-only and nothing is deleted automatically; the room's
 *     history is the index.
 *   - **Names never touch the filesystem.** The stored name is a generated id
 *     plus a whitelisted extension; the user's filename is metadata only. That
 *     removes path traversal as a category rather than defending against it.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Extensions an upload may be stored as. Anything else is stored as `.bin`. */
const SAFE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.svg',
  '.txt', '.md', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yml', '.yaml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm',
  '.css', '.scss', '.xml', '.toml', '.ini', '.cfg', '.conf', '.env', '.diff', '.patch',
  '.pdf', '.zip', '.gz', '.tar', '.tgz',
]);

/** Media types treated as an image, i.e. something a model can be shown. */
const IMAGE_MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp',
]);

/**
 * Types that may be served back with their own content-type.
 *
 * Everything else — including anything the client merely claimed — is served as
 * `application/octet-stream`, which a browser downloads instead of rendering.
 *
 * This exists because `/attachment/<id>` is same-origin with the harness. A
 * client-controlled `mediaType` is therefore a stored-XSS primitive: uploading
 * a `.html` file and reporting `text/html` made the route serve an HTML
 * document, inline, whose `<script>` ran in the harness's own origin
 * (`document.title` set to `EXECUTED`, verified in Chromium). `nosniff` does
 * not help — it stops the browser *guessing* a type, not honouring a declared
 * one. The same applies to `image/svg+xml`, which is a scriptable document
 * when navigated to.
 *
 * Only types that are inert when rendered are on the list. Images cannot carry
 * script (SVG deliberately excluded), and `text/plain` is rendered as text.
 */
const SERVEABLE_MEDIA_TYPES = new Set([
  ...IMAGE_MEDIA_TYPES,
  'text/plain',
]);

/**
 * The content-type to serve a stored attachment with.
 *
 * Deliberately narrower than what was stored: `mediaType` is display metadata
 * for a chip, and must never decide how the browser *interprets* the bytes.
 */
function serveMediaType(mediaType) {
  const type = String(mediaType || '').split(';')[0].trim().toLowerCase();
  return SERVEABLE_MEDIA_TYPES.has(type) ? type : 'application/octet-stream';
}

/**
 * A rough media type for a file name.
 *
 * Only used to decide "is this an image" and to label the chip in the UI; the
 * authoritative type for display is the one the browser reported at upload.
 */
function mediaTypeForExtension(ext) {
  const table = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.jsonl': 'application/x-ndjson', '.csv': 'text/csv', '.log': 'text/plain',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
  };
  return table[ext] || 'application/octet-stream';
}

/** The user's file name, reduced to something safe to store and to print. */
function cleanName(name, fallback = 'file') {
  const raw = String(name == null ? '' : name);
  // Strip any directory part: a browser sends a bare name, but a hand-written
  // request may send `../../etc/passwd` and the metadata is displayed verbatim.
  const base = raw.split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 180) || fallback;
}

/** The extension to store under: the name's, when it is on the allowlist. */
function storageExtension(name, mediaType) {
  const ext = path.extname(cleanName(name)).toLowerCase();
  if (SAFE_EXTENSIONS.has(ext)) return ext;
  // No usable extension: derive one from the image type so the file is still
  // recognisable, otherwise fall back to a neutral one.
  if (IMAGE_MEDIA_TYPES.has(mediaType)) {
    const fromType = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/bmp': '.bmp' };
    return fromType[mediaType] || '.bin';
  }
  return '.bin';
}

/** Where uploads live: under the profile, beside the room logs and rosters. */
function defaultFilesDir(roomsDir) {
  if (!roomsDir) return null;
  return path.join(path.dirname(roomsDir), 'agent-room-files');
}

/**
 * Where the theme document lives: its own directory beside the rooms.
 *
 * Not the profile root, even though it is a single file: the profile directory
 * is shared with DSH itself and with every other plugin's state, and
 * `theme.json` is a name another plugin could reasonably also want. It is also
 * not inside `agent-room-rooms/`, because the theme is not a room — it applies
 * to all of them, and its assets would otherwise be swept up by anything that
 * treats that directory as rooms.
 */
function defaultThemeDir(roomsDir) {
  if (!roomsDir) return null;
  return path.join(path.dirname(roomsDir), 'agent-room-theme');
}

class AttachmentStore {
  /**
   * @param options.dir - directory holding uploaded files; `null` disables uploads.
   * @param options.maxBytes - largest single upload accepted.
   * @param options.logger - optional `(line) => void` for best-effort diagnostics.
   */
  constructor(options = {}) {
    this.dir = options.dir || null;
    this.maxBytes = options.maxBytes === undefined ? 64 * 1024 * 1024 : options.maxBytes;
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    /** id -> metadata for everything served in this process, loaded lazily. */
    this.index = new Map();
    /** id -> absolute path, for ids this process has already resolved. */
    this.paths = new Map();
  }

  /** Whether the store can accept anything at all. */
  get enabled() {
    return Boolean(this.dir);
  }

  _pathFor(id, ext) {
    return path.join(this.dir, id + ext);
  }

  /**
   * Store one uploaded file.
   *
   * @param buffer - the bytes, already read into memory by the caller's limit.
   * @param name - the name the user's browser reported; metadata only.
   * @param mediaType - the type the browser reported, used for display.
   * @returns `{ok: true, attachment}` or `{ok: false, error}`.
   */
  save(buffer, name, mediaType) {
    if (!this.dir) return { ok: false, error: 'uploads are unavailable here' };
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: 'empty upload' };
    if (buffer.length > this.maxBytes) {
      return { ok: false, error: `file is too large (limit ${Math.round(this.maxBytes / (1024 * 1024))} MB)` };
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Content-addressed-ish id: unique per upload, so two files with the same
      // name never collide and a re-upload is a new file rather than an
      // overwrite of one an earlier message still points at.
      const id = 'f' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
      const label = cleanName(name);
      const type = String(mediaType || '').split(';')[0].trim().toLowerCase();
      const ext = storageExtension(label, type);
      const target = this._pathFor(id, ext);
      fs.writeFileSync(target, buffer);
      const attachment = {
        id,
        name: label,
        bytes: buffer.length,
        mediaType: type || mediaTypeForExtension(ext),
        isImage: IMAGE_MEDIA_TYPES.has(type),
        /** Absolute path: what a room's agents are told to read. */
        path: target,
      };
      this.index.set(id, attachment);
      this.paths.set(id, target);
      return { ok: true, attachment };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * Resolve an id to metadata, looking on disk when this process did not store it.
   *
   * A room recycles (idle TTL) and a DSH restart both drop the in-memory index
   * while the history keeps its attachment ids, so a re-read must be able to
   * find a file this process never saw. The id embeds nothing about the name, so
   * the search is a directory scan for a matching prefix.
   */
  lookup(id) {
    if (!id || !this.dir) return null;
    const cached = this.index.get(id);
    if (cached && fs.existsSync(cached.path)) return cached;
    const shown = this.paths.get(id);
    if (shown && fs.existsSync(shown)) {
      const attachment = {
        id,
        name: path.basename(shown),
        bytes: fs.statSync(shown).size,
        mediaType: mediaTypeForExtension(path.extname(shown).toLowerCase()),
        isImage: IMAGE_MEDIA_TYPES.has(mediaTypeForExtension(path.extname(shown).toLowerCase())),
        path: shown,
      };
      this.index.set(id, attachment);
      return attachment;
    }
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return null;
    }
    const hit = entries.find((entry) => entry.startsWith(id + '.'));
    if (!hit) return null;
    const full = path.join(this.dir, hit);
    const ext = path.extname(hit).toLowerCase();
    const mediaType = mediaTypeForExtension(ext);
    const attachment = {
      id,
      name: hit,
      bytes: fs.statSync(full).size,
      mediaType,
      isImage: IMAGE_MEDIA_TYPES.has(mediaType),
      path: full,
    };
    this.index.set(id, attachment);
    this.paths.set(id, full);
    return attachment;
  }

  /** The bytes of one stored file, or `null` when it is not there. */
  read(id) {
    const attachment = this.lookup(id);
    if (!attachment) return null;
    try {
      return { attachment, buffer: fs.readFileSync(attachment.path) };
    } catch (error) {
      this.logger?.(`attachment read failed for ${id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Re-attach the paths a stored history's records refer to.
   *
   * Called when a record is revived from JSONL: the record already carries the
   * original metadata (including a path that may since have moved), and the
   * store is the authority on where the bytes are now.
   */
  rehydrate(record) {
    if (!record || !Array.isArray(record.attachments) || !record.attachments.length) return record;
    record.attachments = record.attachments
      .map((entry) => {
        const found = this.lookup(entry && entry.id);
        return found || (entry && entry.path ? entry : null);
      })
      .filter(Boolean);
    return record;
  }
}

module.exports = {
  AttachmentStore,
  IMAGE_MEDIA_TYPES,
  SERVEABLE_MEDIA_TYPES,
  serveMediaType,
  SAFE_EXTENSIONS,
  cleanName,
  storageExtension,
  mediaTypeForExtension,
  defaultFilesDir,
  defaultThemeDir,
};
