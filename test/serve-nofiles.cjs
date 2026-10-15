'use strict';
/**
 * Standalone room server with uploads deliberately DISABLED (`filesDir: null`).
 *
 * Needed to check the live UI, not just the shim: the point of the capability
 * flag is that the browser disables `＋` before opening a picker, and only a real
 * browser proves the browser-side half. Same code path as `serve.cjs`, one
 * option different.
 *
 * Run:  node test/serve-nofiles.cjs [port]
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoomApi } = require('../lib/server.cjs');

// Same reasoning as `serve.cjs`: keep a probe run's state out of the package.
const defaultRoomsDir = path.join(os.tmpdir(), 'agent-room-standalone-nofiles', 'rooms');

const port = Number(process.argv[2] || 8792);
const api = new RoomApi({
  cwd: process.cwd(),
  title: 'Agent Room (uploads disabled)',
  roomsDir: process.env.AGENT_ROOM_DIR || defaultRoomsDir,
  filesDir: null,
});

const staticFiles = {
  '/index.html': { body: fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8') },
  '/app.js': {
    body: fs.readFileSync(path.join(__dirname, '..', 'public', 'room-ui.js'), 'utf8'),
    type: 'text/javascript; charset=utf-8',
  },
};

const server = http.createServer(async (request, response) => {
  const handled = await api.handle(request, response, { staticFiles });
  if (!handled) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`agent-room standalone (no uploads) on http://127.0.0.1:${port}/\n`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  process.stdout.write('\nshutting down…\n');
  await api.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
