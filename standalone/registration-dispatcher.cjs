'use strict';
const { command, pruneQueues, flushAll } = require('./registration-worker.cjs');
async function stopLegacyWorker(dataDir) {
  // Upgrade cleanup only: never launch a process. Preserve pending queues.
  try { await command(dataDir, 'stop', 45000); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
}
function createDispatcher(dataDir, options = {}) {
  let pending = null, stopped = false;
  const kick = () => {
    if (stopped) return Promise.resolve();
    if (!pending) pending = (async () => {
      await (options.stopLegacyWorker || stopLegacyWorker)(dataDir);
      if (stopped) return;
      pruneQueues(dataDir);
      await (options.flush || flushAll)(dataDir);
    })().finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => { void kick().catch(options.onError || (() => {})); }, options.intervalMs || 5000);
  timer.unref?.();
  void kick().catch(options.onError || (() => {}));
  return { kick, async close() {
    stopped = true;
    clearInterval(timer);
    // Finish a write already in progress, but never begin another cycle.
    await pending;
  } };
}
module.exports = { createDispatcher, stopLegacyWorker };
