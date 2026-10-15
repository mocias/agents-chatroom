'use strict';
/**
 * The room's user-configurable theme: which colours the room surface paints
 * with, and what (if anything) it paints behind them.
 *
 * Two decisions shape this file.
 *
 * 1. **The theme belongs to the user, not to a room or a plugin install.** It is
 *    stored as one JSON document under the profile directory, so it survives a
 *    DSH restart, applies to every room, and is shared by both hosts that render
 *    the room UI (the DSH sidebar tab and the standalone `public/index.html`).
 *    Keeping it out of the plugin directory matters for the same reason the
 *    roster does: a reinstall replaces that directory.
 *
 * 2. **Nothing from the wire is ever trusted into CSS.** The room UI applies the
 *    theme by writing custom properties, and a custom property is a live CSS
 *    value: a colour that smuggles in `;}` would not "look wrong", it would end
 *    the declaration and let the rest of the string become arbitrary CSS. Every
 *    value is therefore checked against a strict grammar *here*, on the host,
 *    and a value that fails is dropped rather than sanitised — guessing at what
 *    a malformed colour "meant" is how a filter becomes a bypass. The same rule
 *    covers the token NAMES: only names on the allowlist below can be written,
 *    so a caller cannot define `--dsw-alias-*` and repaint the harness itself.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * The custom properties a theme may set.
 *
 * This is exactly the set the room stylesheet consumes (declared in
 * `public/room-ui.js`). It is deliberately an allowlist and not a prefix test:
 * a `--ar-` prefix would still let a caller set `--ar-bg-image` to `url(...)`
 * of their choosing, or reach any future variable the stylesheet grows.
 */
const THEME_TOKENS = [
  '--ar-bg',
  '--ar-panel',
  '--ar-line',
  '--ar-text',
  '--ar-dim',
  '--ar-user',
  '--ar-accent',
];

/**
 * Colours this file will accept.
 *
 * Hex, `rgb()`/`rgba()` with numeric arguments, and `hsl()`/`hsla()` — the
 * concrete notations a colour picker produces. Named colours, `var()`, `color-mix()`
 * and `url()` are all refused: the first is unbounded, and the rest are
 * indirection, which is the thing being prevented.
 */
const COLOR_PATTERNS = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/i,
  /^hsla?\(\s*\d{1,3}(?:\.\d+)?(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(?:,\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/i,
];

/** A theme's colours, or `null` when nothing about the set is usable. */
function normalizeColors(input, logger) {
  if (!input || typeof input !== 'object') return {};
  const colors = {};
  for (const [name, value] of Object.entries(input)) {
    if (!THEME_TOKENS.includes(name)) {
      logger?.(`theme: ignoring unknown token ${name}`);
      continue;
    }
    if (typeof value !== 'string' || !COLOR_PATTERNS.some((pattern) => pattern.test(value.trim()))) {
      logger?.(`theme: refusing value for ${name}`);
      continue;
    }
    colors[name] = value.trim();
  }
  return colors;
}

/**
 * Presets.
 *
 * Kept here rather than in the UI so the same names resolve in the standalone
 * page, in tests, and in a config file — and so "midnight" cannot mean two
 * different things in two places.
 */
const PRESETS = {
  midnight: {
    label: '午夜（默认）',
    colors: {
      '--ar-bg': '#0f1117',
      '--ar-panel': '#171a22',
      '--ar-line': '#262b36',
      '--ar-text': '#e6e8ee',
      '--ar-dim': '#8b93a7',
      '--ar-user': '#3b82f6',
      '--ar-accent': '#f59e0b',
    },
  },
  paper: {
    label: '纸张（浅色）',
    colors: {
      '--ar-bg': '#f6f5f2',
      '--ar-panel': '#ffffff',
      '--ar-line': '#dcd8d0',
      '--ar-text': '#1f2328',
      '--ar-dim': '#6b7280',
      '--ar-user': '#2563eb',
      '--ar-accent': '#b45309',
    },
  },
  forest: {
    label: '森林',
    colors: {
      '--ar-bg': '#0d1512',
      '--ar-panel': '#13201b',
      '--ar-line': '#22332c',
      '--ar-text': '#e3ece7',
      '--ar-dim': '#8aa79a',
      '--ar-user': '#2f9e6f',
      '--ar-accent': '#e0b341',
    },
  },
  dusk: {
    label: '暮色',
    colors: {
      '--ar-bg': '#141021',
      '--ar-panel': '#1d1730',
      '--ar-line': '#2e2547',
      '--ar-text': '#e9e4f5',
      '--ar-dim': '#9d93bb',
      '--ar-user': '#8b5cf6',
      '--ar-accent': '#f472b6',
    },
  },
  contrast: {
    label: '高对比',
    colors: {
      '--ar-bg': '#000000',
      '--ar-panel': '#101010',
      '--ar-line': '#4a4a4a',
      '--ar-text': '#ffffff',
      '--ar-dim': '#c8c8c8',
      '--ar-user': '#00a3ff',
      '--ar-accent': '#ffd400',
    },
  },
};

/** Every preset reduced to just its colours, which is what a theme stores. */
function presetColors(name) {
  const preset = name && PRESETS[name];
  return preset ? { ...preset.colors } : null;
}

/** Image types a background may use, mapped to the extension it is stored as. */
const IMAGE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
};

/**
 * A background URL may only be http(s) or a site-relative path.
 *
 * The room UI paints this as `url("<value>")` — inside double quotes — so the
 * characters that matter are not the CSS-syntax ones but the ones that can end
 * the string early: `"` closes it, `\` escapes the closing quote (or, at the end
 * of the value, swallows it), and a newline is illegal inside a string. A value
 * that carried any of them would not "look like a broken URL": `/a");}html{display:none}/*`
 * closes the url() and the rest becomes live CSS. Every character is therefore
 * checked, not just the first — an anchored test in both branches, with a value
 * that fails dropped rather than repaired.
 */
const SAFE_URL_CHARS = /^[^\s"'<>\\]+$/;

function normalizeBackgroundUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  // One anchored test over the WHOLE value, in both branches: every character is
  // inspected, so nothing can hide after the first one.
  if (/^https?:\/\//i.test(text) && SAFE_URL_CHARS.test(text)) return text;
  /**
   * A path this same origin serves, which is how an uploaded background is
   * referenced. `//host/x` is deliberately NOT accepted even though it starts
   * with a slash: a browser reads it as scheme-relative, i.e. a request to a
   * different host, so accepting it would let a saved theme point the room at
   * somebody else's server. `\\host` and `/\host` are the same trick spelled for
   * other parsers, and excluding `/` and `\` from the FIRST character refuses
   * both. Later characters may contain `/` (`/agent-room/background` does), so
   * the remainder is checked against the same class without that exclusion.
   */
  if (/^\/[^\s"'<>\\/][^\s"'<>\\]*$/.test(text)) return text;
  return null;
}

/**
 * The theme a fresh install paints with.
 *
 * Seeded from the `midnight` preset rather than left empty so that "no saved
 * theme" and "the default theme" are the same thing. An empty colour map would
 * mean the stylesheet's own defaults show through, and then the first save —
 * which sends one swatch — would persist a theme that names only that swatch,
 * silently dropping every other colour back to the stylesheet. The user would
 * see their room change shape when they picked a colour.
 */
const DEFAULT_THEME = {
  colors: { ...PRESETS.midnight.colors },
  background: null,
  veil: 0.35,
  preset: 'midnight',
};

/**
 * Fold arbitrary input into a theme that is safe to store and to paint.
 *
 * `previous` is supplied by the caller when it wants an *edit* — a save that
 * names only `colors` must not silently drop the background. Passing no
 * `previous` gives a clean parse, which is what startup and tests want.
 */
function normalizeTheme(input, previous = null, logger = null) {
  const source = input && typeof input === 'object' ? input : {};
  const base = previous || DEFAULT_THEME;

  /**
   * A preset applies **only when this save names one**.
   *
   * This is the difference between "start from forest" and "be forest": if a
   * remembered preset re-applied its palette on every save, then changing one
   * swatch after having customized another would silently revert the other —
   * the user would watch colours they had already chosen snap back. The name is
   * still remembered, so the picker can show which palette the theme began as,
   * but only an explicit choice re-seeds the colours.
   */
  const chosen = typeof source.preset === 'string' && PRESETS[source.preset] ? source.preset : null;
  const preset = chosen || base.preset || null;
  const colors = chosen ? { ...presetColors(chosen) } : { ...(base.colors || {}) };
  Object.assign(colors, normalizeColors(source.colors, logger));

  let background = base.background || null;
  if ('background' in source) {
    const raw = source.background;
    if (raw === null || raw === undefined || raw === '') {
      background = null;
    } else if (typeof raw === 'string') {
      const url = normalizeBackgroundUrl(raw);
      background = url ? { kind: 'url', value: url } : null;
    } else if (typeof raw === 'object') {
      if (raw.kind === 'file') {
        // The bytes live in a file the host owns; the theme only records that
        // there is one and which generation it is, so a re-upload busts the
        // browser cache without the UI having to know the path.
        //
        // The extension is validated HERE, at the wire boundary, and not only
        // where the path is built. `backgroundFile()` does fall back to `.png`
        // for an unknown extension, so a bad value was never a traversal — but
        // it was still stored verbatim and echoed back to the browser, which
        // makes the file the one field in this document that is not ours. It is
        // also what `saveBackground` itself would have written, so a legitimate
        // value round-trips unchanged.
        const ext = Object.values(IMAGE_EXTENSIONS).includes(raw.ext) ? raw.ext : '.png';
        background = { kind: 'file', ext, version: Number(raw.version) || 1 };
      } else if (raw.kind === 'url') {
        const url = normalizeBackgroundUrl(raw.value);
        background = url ? { kind: 'url', value: url } : null;
      }
    }
  }

  /**
   * An unusable veil keeps the previous one rather than falling back to the
   * built-in default, for the same reason a refused colour keeps the previous
   * colour: this is a partial save, and a caller who sent garbage for one field
   * did not thereby ask for the other fields to change.
   *
   * Note the value is computed into a local, never written back into `base`:
   * `base` is `DEFAULT_THEME` itself on a from-scratch parse, and mutating it
   * would make every later call inherit this caller's value.
   */
  let veil = Number.isFinite(base.veil) ? base.veil : DEFAULT_THEME.veil;
  if (source.veil !== undefined) {
    const veilRaw = Number(source.veil);
    if (Number.isFinite(veilRaw)) veil = Math.min(0.95, Math.max(0, veilRaw));
    else logger?.('theme: ignoring a non-numeric veil');
  }

  return { colors, background, veil, preset };
}

/**
 * The theme document: one JSON file, read once and written through.
 *
 * Writes are best-effort for the same reason the roster's are: a user whose
 * profile directory is read-only should still get a themed room for this
 * session, not a plugin that refuses to load.
 */
class ThemeStore {
  constructor(options = {}) {
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.dir = options.dir || null;
    this.file = this.dir ? path.join(this.dir, 'theme.json') : null;
    /** Where an uploaded background image is kept; `null` disables uploads. */
    this.assetsDir = this.dir ? path.join(this.dir, 'assets') : null;
    this.theme = normalizeTheme(options.theme || null, null, this.logger);
    this.load();
  }

  load() {
    if (!this.file) return this.theme;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.(`theme read failed: ${error.message}`);
      return this.theme;
    }
    try {
      this.theme = normalizeTheme(JSON.parse(raw), null, this.logger);
    } catch (error) {
      // A truncated write must not take the plugin down; the defaults are a
      // valid theme, so falling back to them is strictly better than throwing.
      this.logger?.(`theme parse failed: ${error.message}`);
    }
    return this.theme;
  }

  get() {
    return this.theme;
  }

  /** Replace the theme, keeping whatever the patch does not mention. */
  update(patch) {
    this.theme = normalizeTheme(patch, this.theme, this.logger);
    this.save();
    return this.theme;
  }

  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Write-then-rename: a crash mid-write leaves the previous theme intact
      // rather than a half-document that fails to parse on the next boot.
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.theme, null, 2), 'utf8');
      fs.renameSync(temp, this.file);
      return true;
    } catch (error) {
      this.logger?.(`theme save failed: ${error.message}`);
      return false;
    }
  }

  /** Absolute path of the stored background image, or `null` when there is none. */
  backgroundFile() {
    const background = this.theme.background;
    if (!this.assetsDir || !background || background.kind !== 'file') return null;
    const ext = Object.values(IMAGE_EXTENSIONS).includes(background.ext) ? background.ext : '.png';
    return path.join(this.assetsDir, `background${ext}`);
  }

  /**
   * Store one uploaded background image and point the theme at it.
   *
   * The previous file is removed after the new one is in place. Leaving both
   * would be harmless but confusing: `backgroundFile()` resolves by extension,
   * so a user who switches from a `.png` to a `.jpg` would keep a stale PNG on
   * disk and re-serving it after a theme reset would look like the delete
   * failed.
   */
  saveBackground(buffer, mediaType) {
    const ext = IMAGE_EXTENSIONS[String(mediaType || '').toLowerCase()];
    if (!ext) return { ok: false, error: 'unsupported image type: ' + mediaType };
    if (!this.assetsDir) return { ok: false, error: 'background uploads are unavailable here' };
    if (!buffer || !buffer.length) return { ok: false, error: 'empty upload' };
    try {
      fs.mkdirSync(this.assetsDir, { recursive: true });
      const target = path.join(this.assetsDir, `background${ext}`);
      for (const other of new Set(Object.values(IMAGE_EXTENSIONS))) {
        if (other === ext) continue;
        try {
          fs.unlinkSync(path.join(this.assetsDir, `background${other}`));
        } catch {}
      }
      fs.writeFileSync(target, buffer);
      const version = (Number(this.theme.background && this.theme.background.version) || 0) + 1;
      this.theme = { ...this.theme, background: { kind: 'file', ext, version } };
      this.save();
      return { ok: true, theme: this.theme, file: target };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** Drop the stored image, if any. Used when the background becomes a URL. */
  clearBackgroundFile() {
    if (!this.assetsDir) return;
    for (const ext of new Set(Object.values(IMAGE_EXTENSIONS))) {
      try {
        fs.unlinkSync(path.join(this.assetsDir, `background${ext}`));
      } catch {}
    }
  }
}

module.exports = {
  THEME_TOKENS,
  PRESETS,
  DEFAULT_THEME,
  IMAGE_EXTENSIONS,
  normalizeTheme,
  normalizeColors,
  normalizeBackgroundUrl,
  presetColors,
  ThemeStore,
};
