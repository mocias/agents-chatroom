#!/usr/bin/env node
/**
 * The room theme: what may be stored, and what must be refused.
 *
 * The theme is the one feature whose input is written straight into CSS custom
 * properties, so most of this file is about refusal rather than success. A
 * custom property is a *live* CSS value: a colour that ends its declaration and
 * opens a new rule is not a theme that "looks wrong", it is arbitrary CSS in the
 * harness's own origin. Every check below is one of those doors.
 *
 * No codex, no HTTP, no DSH: `lib/theme.cjs` is pure and the `ThemeStore` writes
 * into a temp directory.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ThemeStore, normalizeTheme, PRESETS, THEME_TOKENS, DEFAULT_THEME, IMAGE_EXTENSIONS } = require('../lib/theme.cjs');

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

/** A theme document must always be shape-complete: every token, a veil, a background slot. */
function wellFormed(theme, label) {
  check(`${label}: every token present`, THEME_TOKENS.every((token) => typeof theme.colors[token] === 'string'), JSON.stringify(theme.colors));
  check(`${label}: no unexpected keys`, Object.keys(theme.colors).every((key) => THEME_TOKENS.includes(key)), Object.keys(theme.colors).join(','));
  check(`${label}: veil is a number`, Number.isFinite(theme.veil), String(theme.veil));
}

// ------------------------------------------------ the defaults are paintable --

const fresh = normalizeTheme(null);
wellFormed(fresh, 'fresh');
check('fresh install starts on a preset', fresh.preset === 'midnight', String(fresh.preset));
check('fresh install matches the midnight palette', fresh.colors['--ar-bg'] === PRESETS.midnight.colors['--ar-bg']);
check(
  'the default theme is complete, so a one-swatch save cannot drop the rest',
  Object.keys(DEFAULT_THEME.colors).length === THEME_TOKENS.length,
  String(Object.keys(DEFAULT_THEME.colors).length),
);

// ------------------------------------------------------- the injection doors --

const hostile = [
  ['a declaration escape', '--ar-bg', 'red;}html{display:none}'],
  ['a url()', '--ar-text', 'url(javascript:alert(1))'],
  ['a var() indirection', '--ar-panel', 'var(--ar-bg)'],
  ['an expression-ish value', '--ar-line', 'expression(alert(1))'],
  ['a named colour', '--ar-accent', 'red'],
  ['a bare semicolon', '--ar-user', '#fff;background:url(x)'],
  ['a quote break', '--ar-bg', '#fff"'],
];
for (const [what, token, value] of hostile) {
  const theme = normalizeTheme({ colors: { [token]: value } });
  check(`refuses ${what}`, theme.colors[token] !== value, `${token}=${theme.colors[token]}`);
  check(`refuses ${what} (keeps the default)`, theme.colors[token] === DEFAULT_THEME.colors[token]);
}

// A token NOT on the allowlist must be dropped rather than passed through, or a
// caller could repaint the harness's own chrome through this plugin.
const offList = normalizeTheme({
  colors: {
    '--dsw-alias-bg-base': '#ffffff',
    '--ar-nope': '#fff',
    'background-color': '#fff',
    '--ar-bg': '#123456',
  },
});
check('refuses a DSH token', !('--dsw-alias-bg-base' in offList.colors));
check('refuses an unknown --ar- token', !('--ar-nope' in offList.colors));
check('refuses a plain CSS property', !('background-color' in offList.colors));
check('still accepts a legal token in the same request', offList.colors['--ar-bg'] === '#123456');

// Legal notations must survive, or the feature is unusable with anything but hex.
for (const value of ['#abc', '#aabbcc', '#aabbccdd', 'rgb(12, 34, 56)', 'rgba(12,34,56,0.5)', 'hsl(200, 50%, 40%)', 'hsla(200,50%,40%,0.3)']) {
  const theme = normalizeTheme({ colors: { '--ar-bg': value } });
  check(`accepts ${value}`, theme.colors['--ar-bg'] === value, theme.colors['--ar-bg']);
}

// --------------------------------------------------- presets are a starting point --

let picked = normalizeTheme({ preset: 'forest' }, fresh);
check('a preset seeds its palette', picked.colors['--ar-bg'] === PRESETS.forest.colors['--ar-bg']);
check('a preset is remembered by name', picked.preset === 'forest');

let tweaked = normalizeTheme({ colors: { '--ar-accent': '#ff0000' } }, picked);
check(
  'tweaking one swatch keeps the rest of the preset',
  tweaked.colors['--ar-bg'] === PRESETS.forest.colors['--ar-bg'] && tweaked.colors['--ar-accent'] === '#ff0000',
  JSON.stringify(tweaked.colors),
);
check('the preset name survives a tweak', tweaked.preset === 'forest');
check(
  'a partial save does NOT re-apply the preset over a custom colour',
  normalizeTheme({ colors: { '--ar-line': '#000000' } }, tweaked).colors['--ar-accent'] === '#ff0000',
);
check('re-choosing a preset resets the tweak', normalizeTheme({ preset: 'forest' }, tweaked).colors['--ar-accent'] === PRESETS.forest.colors['--ar-accent']);
check('an unknown preset is ignored', normalizeTheme({ preset: 'nope' }, fresh).preset === 'midnight');

// ------------------------------------------------------------- veil and background --

check('the veil is clamped to 0..0.95', normalizeTheme({ veil: 5 }).veil === 0.95 && normalizeTheme({ veil: -3 }).veil === 0);
check('a non-numeric veil keeps the previous value', normalizeTheme({ veil: 'x' }, normalizeTheme({ veil: 0.5 })).veil === 0.5);

for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', '  ', 'http://a b/c', '//evil.example/x.png']) {
  const theme = normalizeTheme({ background: bad });
  check(`refuses background ${JSON.stringify(bad)}`, theme.background === null, JSON.stringify(theme.background));
}
check('accepts an http background', normalizeTheme({ background: 'https://example.com/a.png' }).background.value === 'https://example.com/a.png');
check('accepts a same-origin path background', normalizeTheme({ background: '/agent-room/background?v=2' }).background.value === '/agent-room/background?v=2');
check('`background: null` clears it', normalizeTheme({ background: null }, normalizeTheme({ background: 'https://e.com/a.png' })).background === null);
check('omitting background keeps it', normalizeTheme({ colors: {} }, normalizeTheme({ background: 'https://e.com/a.png' })).background.value === 'https://e.com/a.png');

/**
 * The background lands INSIDE double quotes — the UI paints
 * `url("<value>")` — so the dangerous characters are the ones that end the
 * string, not the ones that are illegal in CSS generally.
 *
 * The earlier list checked only a leading `//` and a scheme, which is why a
 * value that closes the quote and opens a rule (`/a");}html{display:none}/*`)
 * was accepted: the old path test was anchored at the start and never looked
 * past the first character. These are the doors that check found open.
 */
const quoteEscapes = [
  ['a closing quote', '/a"'],
  ['a quote, a rule break and a comment', '/a");}html{display:none}/*'],
  ['a quote that starts a second url()', '/a") , url("https://evil.example/x.png'],
  ['a backslash-escaped quote', '/a\\"'],
  ['a trailing backslash', '/a\\'],
  ['a backslash path', '/a\\b.png'],
  ['a newline inside the string', '/a\nb'],
  ['an angle bracket', '/a<'],
  ['a space', '/a b'],
  ['the same via an https url', 'https://ok.example/a".png'],
  ['an https url with a backslash', 'https://ok.example/a\\b.png'],
  ['an object-shaped value', { kind: 'url', value: '/a");}html{display:none}/*' }],
];
for (const [what, value] of quoteEscapes) {
  const theme = normalizeTheme({ background: value });
  check(`refuses a background with ${what}`, theme.background === null, JSON.stringify(theme.background));
}
// The legitimate shapes must survive the tightened check, or the feature breaks.
for (const good of ['/agent-room/background?v=2', '/assets/a-b_c.png', 'https://example.com/a.png', 'http://example.com/a/b/c.webp']) {
  const theme = normalizeTheme({ background: good });
  check(`still accepts ${good}`, !!theme.background && theme.background.value === good, JSON.stringify(theme.background));
}

// ------------------------------------------------------------------- the store --

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-theme-'));
try {
  const store = new ThemeStore({ dir });
  check('a new store starts on the defaults', store.get().colors['--ar-bg'] === PRESETS.midnight.colors['--ar-bg']);
  check('a new store writes nothing until asked', !fs.existsSync(path.join(dir, 'theme.json')));

  store.update({ preset: 'dusk' });
  check('update persists to disk', fs.existsSync(path.join(dir, 'theme.json')));
  check('update returns the new theme', store.get().preset === 'dusk');

  const reopened = new ThemeStore({ dir });
  check('a second store reads it back', reopened.get().colors['--ar-bg'] === PRESETS.dusk.colors['--ar-bg'], reopened.get().colors['--ar-bg']);
  check('the reopened theme is well formed', THEME_TOKENS.every((t) => typeof reopened.get().colors[t] === 'string'));

  // A truncated file is the normal shape of a crash mid-write. It must cost the
  // theme, never the plugin.
  fs.writeFileSync(path.join(dir, 'theme.json'), '{"colors":{"--ar-bg":', 'utf8');
  const recovered = new ThemeStore({ dir });
  check('a corrupt theme file falls back to the defaults', recovered.get().colors['--ar-bg'] === DEFAULT_THEME.colors['--ar-bg']);

  // A theme file written by hand may contain anything at all.
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ colors: { '--ar-bg': '#000;}' , '--evil': '#fff' } }), 'utf8');
  const sanitized = new ThemeStore({ dir });
  check('a hand-edited hostile value is refused on load', sanitized.get().colors['--ar-bg'] === DEFAULT_THEME.colors['--ar-bg']);
  check('a hand-edited unknown token is dropped', !('--evil' in sanitized.get().colors));

  // Background uploads.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const first = sanitized.saveBackground(png, 'image/png');
  check('saving a background succeeds', first.ok === true, first.error);
  check('the background is remembered as a file', sanitized.get().background.kind === 'file');
  check('the background file exists', fs.existsSync(sanitized.backgroundFile()));
  check('the background file has the right extension', sanitized.backgroundFile().endsWith('.png'), sanitized.backgroundFile());

  const second = sanitized.saveBackground(png, 'image/jpeg');
  check('replacing with another type bumps the version', sanitized.get().background.version > first.theme.background.version);
  check('replacing removes the old file', !fs.existsSync(path.join(dir, 'assets', 'background.png')));
  check('the new file exists', fs.existsSync(sanitized.backgroundFile()));

  check('an unsupported image type is refused', sanitized.saveBackground(png, 'text/plain').ok === false);
  check('an empty upload is refused', sanitized.saveBackground(Buffer.alloc(0), 'image/png').ok === false);

  /**
   * The `ext` of a stored background is the one field in this document that
   * comes from the wire and names a file, so it is validated at the boundary
   * rather than trusted to the path builder's fallback. A value that is not a
   * known image extension becomes `.png` — never stored verbatim, never
   * unbounded — because that string is echoed back to the browser.
   */
  const storedExts = Object.values(IMAGE_EXTENSIONS);
  for (const evil of ['../../../../evil', '/etc/passwd', '..\\..\\evil', 'a'.repeat(500), '', 'png', '.PNG']) {
    const t = normalizeTheme({ background: { kind: 'file', ext: evil, version: 1 } });
    check(`a wire-supplied ext ${JSON.stringify(evil.slice(0, 20))} is not stored verbatim`, t.background.ext !== evil, JSON.stringify(t.background.ext));
    check(`a wire-supplied ext ${JSON.stringify(evil.slice(0, 20))} is a known image extension`, storedExts.includes(t.background.ext), JSON.stringify(t.background.ext));
  }
  check(
    'a legitimate ext round-trips unchanged',
    normalizeTheme({ background: { kind: 'file', ext: '.webp', version: 3 } }).background.ext === '.webp',
  );
  check(
    'the version survives alongside the ext',
    normalizeTheme({ background: { kind: 'file', ext: '.webp', version: 3 } }).background.version === 3,
  );

  sanitized.clearBackgroundFile();
  check('clearing removes the stored image', !fs.existsSync(path.join(dir, 'assets', 'background.jpg')));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// A store with nowhere to write must still be usable in memory: a read-only
// profile should cost persistence, not the feature.
const memoryOnly = new ThemeStore({ dir: null });
check('a store with no directory still holds a theme', memoryOnly.get().colors['--ar-bg'] === DEFAULT_THEME.colors['--ar-bg']);
check('a store with no directory reports no background file', memoryOnly.backgroundFile() === null);
check('a store with no directory refuses a background upload', memoryOnly.saveBackground(Buffer.from('x'), 'image/png').ok === false);
memoryOnly.update({ preset: 'paper' });
check('a store with no directory still updates in memory', memoryOnly.get().preset === 'paper');

console.log('theme       defaults, injection refusal, presets, persistence, background');
console.log('problems: ' + (problems.length ? '\n  - ' + problems.join('\n  - ') : 'none'));
process.exit(problems.length ? 1 : 0);
