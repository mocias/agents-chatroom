/**
 * Probe whether the DSH host has composed our client bundle into its web plugin
 * graph, and whether the `/plugins` route serves it.
 *
 * The graph is composed by @deepseek-ai/dsh-client-modules from Loader entries
 * that declare `dsh.client`. A row installed after boot only appears once the
 * loader fires `internal/plugin` and the registry flushes.
 *
 * Usage: node test/probe-boot.cjs [baseUrl]
 */
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:19387';
const CLIENT = join(__dirname, '..', 'lib', 'client.js');

function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0');
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
  return hash.digest('hex').slice(0, 12);
}

function artifactRevision(baseline) {
  return framedHash('plugin-artifact', [
    String(baseline.mtimeMs),
    String(baseline.ctimeMs),
    String(baseline.size),
  ]);
}

(async () => {
  const meta = statSync(CLIENT);
  const rev = artifactRevision(meta);
  console.log('clientPath', CLIENT);
  console.log('baseline', { mtimeMs: meta.mtimeMs, ctimeMs: meta.ctimeMs, size: meta.size });
  console.log('rev', rev);

  const urls = [
    `/plugins/??dsh-agent-room/client.js&rev=${rev}`,
    `/plugins/dsh-agent-room/client.js?rev=${rev}`,
    `/plugins/??dshmarket/client.js&rev=${rev}`,
    '/agent-room/state?room=default',
  ];
  for (const path of urls) {
    const url = BASE + path;
    try {
      const response = await fetch(url);
      const body = await response.text();
      console.log(`${response.status} ${url}  bytes=${body.length}  head=${JSON.stringify(body.slice(0, 90))}`);
    } catch (error) {
      console.log(`ERR ${url}  ${error.message}`);
    }
  }
})();
