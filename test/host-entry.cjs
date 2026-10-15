#!/usr/bin/env node
/**
 * Host-entry test: exercises `lib/index.js` the way the DSH loader does.
 *
 * What this covers that no other test does:
 *   - the route is registered on `ctx.webServer` with the configured prefix,
 *   - the static files are read from disk at apply time and served with the
 *     right content types and the prefix stripped,
 *   - an unmatched path under the prefix produces agent-room's own 404 (rather
 *     than falling through to some other plugin's route),
 *   - the roster directory is derived from DSH_PROFILE_DIR, so an edited member
 *     list survives a restart,
 *   - disposing the effect unregisters the route and stops the engine.
 *
 * `/state` is deliberately never requested: it would build a real room and spawn
 * a real harness. Everything here is about the wiring around the engine.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

async function main() {
  const problems = [];
  const check = (label, ok, detail) => {
    if (!ok) problems.push(`${label}${detail ? ': ' + detail : ''}`);
  };

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-profile-'));
  const previousProfile = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = profileDir;

  const routes = [];
  const effects = [];
  const logs = [];
  const ctx = {
    logger: { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) },
    webServer: {
      register(route) {
        routes.push(route);
        return () => routes.splice(routes.indexOf(route), 1);
      },
    },
    effect(factory, label) {
      effects.push({ dispose: factory(), label });
      return () => {};
    },
  };

  let server = null;
  try {
    const module = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);

    check('host entry exports the plugin name', module.name === 'dsh-agent-room', String(module.name));
    check('host entry injects webServer', JSON.stringify(module.inject) === '["webServer"]', JSON.stringify(module.inject));
    check('host entry exports apply', typeof module.apply === 'function');

    module.apply(ctx, { routePrefix: '/agent-room' });

    check('exactly one route was registered', routes.length === 1, String(routes.length));
    const route = routes[0];
    check('the route is a prefix route', route.kind === 'prefix', String(route.kind));
    check('the route uses the configured prefix', route.path === '/agent-room', String(route.path));
    check('the route has a handler', typeof route.handler === 'function');
    check('an effect was registered for teardown', effects.length === 1, String(effects.length));

    // The roster directory must come from the profile, not the plugin dir.
    const expectedRosterDir = path.join(profileDir, 'agent-room-rooms');
    check('the roster dir was created under the profile', fs.existsSync(expectedRosterDir), expectedRosterDir);
    // Uploads and the theme live BESIDE the rooms dir, so a profile that already
    // has rooms keeps them: a sibling name cannot collide with a room id.
    const expectedFilesDir = path.join(profileDir, 'agent-room-files');
    const expectedThemeDir = path.join(profileDir, 'agent-room-theme');
    check('the attachment dir was created under the profile', fs.existsSync(expectedFilesDir), expectedFilesDir);
    check('the theme dir was created under the profile', fs.existsSync(expectedThemeDir), expectedThemeDir);
    check('the attachment dir is a sibling of the rooms dir', path.dirname(expectedFilesDir) === path.dirname(expectedRosterDir));
    const info = logs.find((row) => row[0] === 'info' && /agent-room ready/.test(row[1]));
    check('the ready log names the roster dir', info && info[1].includes(expectedRosterDir), info ? info[1] : '(no log)');
    check('the ready log reports the upload and theme dirs', info && info[1].includes('files=') && info[1].includes('theme='), info ? info[1] : '(no log)');

    // Serve the registered handler over a real socket.
    server = http.createServer((request, response) => {
      void Promise.resolve(route.handler(request, response));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const html = await fetch(`${base}/agent-room/index.html`);
    const htmlBody = await html.text();
    check('the UI html is served under the prefix', html.status === 200, String(html.status));
    check('the UI html is typed as html', /text\/html/.test(html.headers.get('content-type') || ''), html.headers.get('content-type'));
    check('the UI html is the real page', /agent-room|AgentRoom|群聊/.test(htmlBody), htmlBody.slice(0, 80));

    const js = await fetch(`${base}/agent-room/app.js`);
    const jsBody = await js.text();
    check('the UI script is served', js.status === 200, String(js.status));
    check('the UI script is typed as javascript', /javascript/.test(js.headers.get('content-type') || ''), js.headers.get('content-type'));
    check('the UI script exports the mount function', /AgentRoomUI/.test(jsBody), jsBody.slice(0, 60));
    check('the UI script carries the member-management UI', /addpanel/.test(jsBody));

    const missing = await fetch(`${base}/agent-room/definitely-not-a-route`);
    const missingBody = await missing.text();
    check('an unknown path is a 404', missing.status === 404, String(missing.status));
    check('the 404 identifies the plugin', /agent-room: not found/.test(missingBody), missingBody);

    // --- the upload and theme routes, through the real wire ----------------
    // `/state` is still avoided (it builds a room), so these are checked through
    // the routes that do not need an engine: the theme store and the attachment
    // store both work before any room exists.
    const themeBefore = await fetch(`${base}/agent-room/theme`);
    check('the theme route is served', themeBefore.status === 200, String(themeBefore.status));
    const themeJson = await themeBefore.json();
    check('the theme route returns colours', !!themeJson.theme && !!themeJson.theme.colors, JSON.stringify(themeJson).slice(0, 120));
    check('the theme route offers presets', Array.isArray(themeJson.presets) && themeJson.presets.length > 0);
    check(
      'the theme route never names a filesystem path',
      !JSON.stringify(themeJson).match(/[A-Za-z]:[\\/]/),
      JSON.stringify(themeJson).slice(0, 200),
    );

    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const uploaded = await fetch(`${base}/agent-room/attach?name=shot.png&type=image/png`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
    });
    check('an upload is accepted', uploaded.status === 200, String(uploaded.status));
    const uploadJson = await uploaded.json();
    check('the upload returns an id', !!uploadJson.attachment && !!uploadJson.attachment.id);
    check('the upload response carries no path', !JSON.stringify(uploadJson).match(/[A-Za-z]:[\\/]/), JSON.stringify(uploadJson).slice(0, 200));
    check('the uploaded bytes landed in the files dir', fs.readdirSync(expectedFilesDir).length > 0, expectedFilesDir);

    const served = await fetch(`${base}/agent-room/attachment/${uploadJson.attachment.id}`);
    check('the attachment is served back', served.status === 200, String(served.status));
    check('the served bytes are the upload', Buffer.from(await served.arrayBuffer()).equals(png));
    check('serving is nosniff', served.headers.get('x-content-type-options') === 'nosniff');

    // Binary must survive the wire byte-for-byte; a UTF-8 round trip would not.
    const bgPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
    const bgUpload = await fetch(`${base}/agent-room/theme/background?type=image/png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: bgPng,
    });
    check('a background upload is accepted', bgUpload.status === 200, String(bgUpload.status));
    const bgJson = await bgUpload.json();
    check('the background is stored as a file', !!bgJson.theme && bgJson.theme.background && bgJson.theme.background.kind === 'file', JSON.stringify(bgJson).slice(0, 160));
    const bgServed = await fetch(`${base}/agent-room/background`);
    check('the background is served', bgServed.status === 200, String(bgServed.status));
    check('the served background is the upload', Buffer.from(await bgServed.arrayBuffer()).equals(bgPng));
    check('the background image landed in the theme dir', fs.existsSync(path.join(expectedThemeDir, 'assets')));

    // The host must refuse a colour that would escape its declaration.
    const hostile = await fetch(`${base}/agent-room/theme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: { colors: { '--ar-bg': 'red;}html{display:none}' } } }),
    });
    const hostileJson = await hostile.json();
    check('an injection attempt is refused over the wire', hostileJson.theme.colors['--ar-bg'] !== 'red;}html{display:none}', JSON.stringify(hostileJson.theme.colors).slice(0, 120));

    // Teardown must remove the route and stop the engine.
    effects[0].dispose();
    check('disposing removed the route', routes.length === 0, String(routes.length));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previousProfile;
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  console.log('apply()      one prefix route + one teardown effect');
  console.log('rosters      under DSH_PROFILE_DIR/agent-room-rooms');
  console.log('GET index    html, served with the prefix stripped');
  console.log('GET app.js   the real UI bundle, member management included');
  console.log('unknown path agent-room\'s own 404');
  console.log('dispose      route unregistered');
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
