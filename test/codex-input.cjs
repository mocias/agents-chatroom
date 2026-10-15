#!/usr/bin/env node
/**
 * How an attachment becomes a codex `input` entry.
 *
 * This is the half of the upload feature that decides whether a model *sees* an
 * image or merely reads a path to one. Codex's `UserInput` is a union, and only
 * `{type:'localImage', path}` puts the picture in front of the model; every other
 * file is text, because there is no generic "here is a file" variant a model can
 * act on.
 *
 * No codex is spawned: `buildInput` is pure, and its shape is checked against the
 * schema this project vendored (`_research/spike-codex/schema/v2/TurnStartParams.json`).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildInput } = require('../lib/codex-pool.cjs');

const problems = [];
const check = (label, ok, detail) => {
  if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
};

const image = { id: 'f1', name: 'shot.png', bytes: 10, mediaType: 'image/png', isImage: true, path: '/tmp/a/f1.png' };
const file = { id: 'f2', name: 'notes.md', bytes: 10, mediaType: 'text/markdown', isImage: false, path: '/tmp/a/f2.md' };

// --- text only ---------------------------------------------------------------
const plain = buildInput('hello', []);
check('a plain turn is one text entry', plain.length === 1, JSON.stringify(plain));
check('the text entry carries the text', plain[0].type === 'text' && plain[0].text === 'hello', JSON.stringify(plain[0]));
check('the text entry declares text_elements', Array.isArray(plain[0].text_elements), JSON.stringify(plain[0]));
check('no attachments still builds an input', buildInput('x', undefined).length === 1);
check('a null attachment list still builds an input', buildInput('x', null).length === 1);

// --- the text entry must stay first -----------------------------------------
// A model shown an image before being told what to do answers the picture
// instead of the question about it.
const withImage = buildInput('what is wrong here?', [image]);
check('an image adds a localImage entry', withImage.length === 2, JSON.stringify(withImage));
check('the text entry is first', withImage[0].type === 'text', JSON.stringify(withImage.map((e) => e.type)));
check('the image entry is second', withImage[1].type === 'localImage', JSON.stringify(withImage.map((e) => e.type)));
check('the image entry carries the path', withImage[1].path === image.path, JSON.stringify(withImage[1]));
check('the image is not duplicated in the text', withImage[0].text === 'what is wrong here?', withImage[0].text);

// --- non-images stay text ----------------------------------------------------
const withFile = buildInput('read this', [file]);
check('a plain file adds no input entry', withFile.length === 1, JSON.stringify(withFile.map((e) => e.type)));
check('a plain file does not become a localImage', !withFile.some((e) => e.type === 'localImage'));

// --- mixed and defensive -----------------------------------------------------
const mixed = buildInput('both', [image, file]);
check('a mixed list yields text + every image', mixed.length === 2 && mixed[1].path === image.path, JSON.stringify(mixed.map((e) => e.type)));

const twoImages = buildInput('two', [image, { ...image, id: 'f3', path: '/tmp/a/f3.png' }]);
check('two images yield two entries', twoImages.length === 3, String(twoImages.length));
check('images keep their order', twoImages[1].path === image.path && twoImages[2].path === '/tmp/a/f3.png');

// Malformed entries must be skipped, never emitted: a `localImage` with no path
// would be rejected by codex and fail the whole turn.
check('a null entry is skipped', buildInput('x', [null]).length === 1);
check('an entry with no path is skipped', buildInput('x', [{ isImage: true, type: 'image/png' }]).length === 1);
check('an image with an empty path is skipped', buildInput('x', [{ isImage: true, path: '' }]).length === 1);
check('an entry flagged non-image but shaped like one is skipped', buildInput('x', [{ isImage: false, path: '/tmp/a/x.png' }]).length === 1);
check('a non-object entry is skipped', buildInput('x', ['nope', 42]).length === 1);

// --- the shape must match the vendored schema -------------------------------
// The schema belongs to the research tree rather than this package, so it is
// looked for upward and the check is skipped when it is absent — a missing
// research tree must not fail an install that has no use for it.
const schemaPath = findSchema();
if (schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const union = findUserInputUnion(schema);
  if (union) {
    const known = union.map((entry) => entry && entry.properties && entry.properties.type && entry.properties.type.enum && entry.properties.type.enum[0]).filter(Boolean);
    check('the schema knows the text variant', known.includes('text'), known.join(','));
    check('the schema knows the localImage variant', known.includes('localImage'), known.join(','));
    const localImage = union.find((e) => e.properties && e.properties.type && e.properties.type.enum && e.properties.type.enum[0] === 'localImage');
    const required = (localImage && localImage.required) || [];
    check('the schema requires localImage.path', required.includes('path'), required.join(','));
    check('the schema requires localImage.type', required.includes('type'), required.join(','));
    // Every key the builder emits must exist in the schema, or codex rejects the turn.
    for (const entry of [...withImage, ...mixed]) {
      const variant = union.find((e) => e.properties && e.properties.type && e.properties.type.enum && e.properties.type.enum[0] === entry.type);
      check(`the schema defines the ${entry.type} variant`, !!variant, entry.type);
      if (variant) {
        for (const key of Object.keys(entry)) {
          check(`the schema allows ${entry.type}.${key}`, !!variant.properties[key], Object.keys(variant.properties).join(','));
        }
      }
    }
  } else {
    check('the schema exposes a UserInput union', false, 'not found');
  }
} else {
  console.log('codex-input  (schema not vendored here; shape checks skipped)');
}

/** Find the `UserInput` union in the vendored schema, wherever it is nested. */
function findUserInputUnion(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'UserInput' && value && Array.isArray(value.anyOf)) return value.anyOf;
    if (key === 'UserInput' && value && Array.isArray(value.oneOf)) return value.oneOf;
    const found = findUserInputUnion(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * The vendored codex schema, if this checkout has one.
 *
 * Searched upward from the package rather than assumed at a fixed path: the
 * schema lives in the research tree beside the plugin, and hardcoding the
 * relative hop would break the moment either moved.
 */
function findSchema(limit = 6) {
  let dir = path.join(__dirname, '..');
  for (let i = 0; i < limit; i += 1) {
    const candidate = path.join(dir, '_research', 'spike-codex', 'schema', 'v2', 'TurnStartParams.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

console.log('codex-input  attachment -> UserInput: text first, images as localImage');
console.log('problems: ' + (problems.length ? '\n  - ' + problems.join('\n  - ') : 'none'));
process.exit(problems.length ? 1 : 0);
