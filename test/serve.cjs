'use strict';
/**
 * Standalone server for the room, used to verify the HTTP/SSE layer without
 * DSH in the loop. Inside DSH the same `RoomApi.handle` runs behind a
 * `ctx.webServer.register` prefix route.
 *
 * Run:  node test/serve.cjs [port]
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoomApi } = require('../lib/server.cjs');

/**
 * Where a throwaway standalone run keeps its state.
 *
 * Deliberately NOT inside the package. `lib/index.js` derives the upload and
 * theme directories from the rooms directory's PARENT, so pointing `roomsDir` at
 * `<package>/.rooms` made every probe drop `agent-room-files/` and
 * `agent-room-theme/` — uploaded screenshots, background images, a `theme.json`
 * — straight into the plugin source tree. Set `AGENT_ROOM_DIR` to reuse one
 * deliberately (the online tests do).
 */
const defaultRoomsDir = path.join(os.tmpdir(), 'agent-room-standalone', 'rooms');

const port = Number(process.argv[2] || 8791);
const api = new RoomApi({
  cwd: process.cwd(),
  title: 'Agent Room (standalone)',
  /**
   * Same persistence story as inside DSH, so a roster edited against the
   * standalone server also survives a restart.
   */
  roomsDir: process.env.AGENT_ROOM_DIR || defaultRoomsDir,
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
  process.stdout.write(`agent-room standalone on http://127.0.0.1:${port}/\n`);
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
