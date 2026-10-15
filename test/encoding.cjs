#!/usr/bin/env node
/**
 * Every source file must be valid UTF-8.
 *
 * This exists because it actually happened: a `Get-Content -Raw` /
 * `Set-Content` round trip through PowerShell decoded this plugin's UTF-8 as GBK
 * and re-encoded the result, silently turning every Chinese string into mojibake
 * and truncating multi-byte characters into stray U+FFFD. Nothing failed until a
 * syntax error surfaced much later, and by then the original text was gone.
 *
 * The damage is cheap to detect and unrecoverable to fix, so it is detected here
 * on every run: `lib/`, `public/`, `test/` and the package metadata are all read
 * as strict UTF-8, and non-ASCII text is required to survive a round trip.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

const ROOT = path.join(__dirname, '..');
const DIRS = ['lib', 'public', 'test'];
const FILES = ['package.json', 'README.md', 'REQUIREMENTS.md', 'FEASIBILITY.md'];

/** Every file worth checking, shallowest first. */
function sources() {
  const found = [];
  for (const file of FILES) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) found.push(full);
  }
  for (const dir of DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(cjs|js|mjs|json|css|html|md|yml|yaml)$/.test(entry.name)) continue;
      found.push(path.join(full, entry.name));
    }
  }
  return found;
}

const strict = new TextDecoder('utf-8', { fatal: true });
const loose = new TextDecoder('utf-8', { fatal: false });

let checked = 0;
let withNonAscii = 0;
for (const file of sources()) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const bytes = fs.readFileSync(file);
  checked += 1;

  // A byte-order mark is not wrong, but it is unexpected here and would show up
  // in a diff as an invisible character.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push(`${rel}: has a UTF-8 BOM`);
  }

  let text = null;
  try {
    text = strict.decode(bytes);
  } catch (error) {
    // Name the first offending byte so the report is actionable.
    const looseText = loose.decode(bytes);
    const at = looseText.indexOf('\uFFFD');
    const offset = at >= 0 ? bytes.indexOf(0xef, Math.max(0, at - 2)) : -1;
    problems.push(`${rel}: not valid UTF-8${offset >= 0 ? ` near byte ${offset}` : ''} (${error.message})`);
    continue;
  }

  // U+FFFD must never appear in source: it is what a lossy decode leaves behind,
  // and its presence means text was destroyed, not merely mis-encoded.
  if (text.includes('\uFFFD')) {
    const line = text.split('\n').findIndex((l) => l.includes('\uFFFD')) + 1;
    problems.push(`${rel}: contains U+FFFD (line ${line})`);
    continue;
  }

  if (/[^\x00-\x7f]/.test(text)) withNonAscii += 1;

  // Round trip: valid UTF-8 must re-encode to the same bytes. This catches a
  // file saved in a different encoding that happens to still decode.
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    problems.push(`${rel}: does not round trip through UTF-8`);
  }
}

// Mojibake is the specific signature of a GBK round trip. It is reproduced here
// rather than typed: take a character this plugin legitimately uses, encode it
// as UTF-8, then decode those bytes as GBK. That is exactly what the corrupting
// pipeline did, so the markers are derived from the real transformation instead
// of from characters someone typed and might have typed wrong.
const GBK = new TextDecoder('gbk');
const MOJIBAKE = ['房间', '设置', '背景', '面板', '分隔', '正文', '高亮', '强调', '颜色', '主题']
  .map((sample) => GBK.decode(Buffer.from(sample, 'utf8')))
  .filter((marker) => marker !== '' && !/^[\x00-\x7f]*$/.test(marker));

/** This file, which is allowed to contain the markers. */
const SELF = path.basename(__filename);

for (const file of sources()) {
  if (path.basename(file) === SELF) continue;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  let text = '';
  try {
    text = strict.decode(fs.readFileSync(file));
  } catch {
    continue;
  }
  const hits = MOJIBAKE.filter((marker) => text.includes(marker));
  if (hits.length) problems.push(`${rel}: looks like GBK-mangled UTF-8 (${hits.join(' / ')})`);
}

console.log(`encoding    ${checked} files strictly UTF-8, ${withNonAscii} containing non-ASCII text`);

/**
 * Cross-file constants.
 *
 * These strings are duplicated by design — `lib/client.js` and
 * `public/room-ui.js` are separate worlds (one is a client bundle, the other is
 * served over HTTP), and `lib/theme.cjs` is the host's allowlist. Nothing links
 * them at build time, so a rename in one file is a silent break: the room panel
 * would stop hearing the settings row, or the host would reject a token the UI
 * still renders. Reading all three here is the cheapest place to notice.
 */
const readSource = (rel) => strict.decode(fs.readFileSync(path.join(ROOT, rel)));
try {
  const client = readSource('lib/client.js');
  const ui = readSource('public/room-ui.js');
  const themeStore = readSource('lib/theme.cjs');

  const eventNames = [client, ui].map((text) => {
    const match = text.match(/THEME_EVENT = '([^']+)'/);
    return match ? match[1] : null;
  });
  check('both sides declare a THEME_EVENT', eventNames.every((name) => name !== null), JSON.stringify(eventNames));
  check(
    'both sides agree on the THEME_EVENT',
    eventNames[0] === eventNames[1],
    JSON.stringify(eventNames),
  );

  // The theme store's allowlist and the row's token list must be the same set:
  // a token the row offers but the host drops is a swatch that does nothing.
  //
  // Parse the DECLARATION LISTS, not the whole file. Whole-file scraping is
  // vacuous: `lib/theme.cjs` mentions every token again in the preset palettes,
  // so removing one from `THEME_TOKENS` changed nothing, and any mention in the
  // UI satisfied the "consumes" check. The delimited block is the real contract.
  const listIn = (text, start, end) => {
    const from = text.indexOf(start);
    if (from < 0) return null;
    const to = text.indexOf(end, from + start.length);
    if (to < 0) return null;
    return new Set(text.slice(from, to).match(/--ar-[a-z-]+/g) || []);
  };
  const hostTokens = listIn(themeStore, 'const THEME_TOKENS = [', '];');
  const rowTokens = listIn(client, 'const TOKENS = [', '];');
  check('the host token allowlist was found', hostTokens !== null);
  check('the row token list was found', rowTokens !== null);
  if (hostTokens && rowTokens) {
    const missingFromHost = [...rowTokens].filter((token) => !hostTokens.has(token));
    const missingFromRow = [...hostTokens].filter((token) => !rowTokens.has(token));
    check('the row offers no token the host would drop', missingFromHost.length === 0, missingFromHost.join(','));
    check('the row offers every token the host accepts', missingFromRow.length === 0, missingFromRow.join(','));
    check('the token allowlist is the expected 7', hostTokens.size === 7, String(hostTokens.size));

    // The UI must CONSUME each token as a custom property, i.e. `var(--ar-x)`,
    // not merely mention it (a comment or a stray literal is not a consumer).
    for (const token of hostTokens) {
      check(`the UI reads var(${token})`, ui.includes(`var(${token})`), token);
    }
  }
} catch (error) {
  problems.push(`cross-file constants could not be checked: ${error.message}`);
}
console.log('problems: ' + (problems.length ? '\n  - ' + problems.join('\n  - ') : 'none'));
process.exit(problems.length ? 1 : 0);
