'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const backends = ['codex', 'workbuddy', 'qoder', 'claude'];
function address(dataDir) {
  const canonical = fs.realpathSync(dataDir);
  const hash = crypto.createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? '\\\\.\\pipe\\agent-room-registration-' + hash : path.join(os.tmpdir(), 'agent-room-registration-' + hash + '.sock');
}
function hasPending(dataDir) {
  return backends.some(name => {
    const file = path.join(dataDir, 'desktop-sync', name + '-pending.json');
    if (!fs.existsSync(file)) return false;
    const queue = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的登记队列：' + name);
    return queue.jobs.length > 0;
  });
}
function pruneQueues(dataDir) {
  const catalogFile = path.join(dataDir, 'catalog.json'), catalogRaw = fs.readFileSync(catalogFile, 'utf8');
  const catalog = JSON.parse(catalogRaw);
  for (const backend of backends) {
    const file = path.join(dataDir, 'desktop-sync', backend + '-pending.json');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8'), queue = JSON.parse(raw);
    if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的登记队列：' + backend);
    const jobs = queue.jobs.filter(job => catalog.agents.some(agent => agent.id === job.agentId &&
      (backend === 'workbuddy' ? ['workbuddy', 'workbuddy-ai'].includes(agent.backend) : agent.backend === backend) && require('./desktop-state.cjs').samePath(agent.workspace, job.workspace)));
    if (jobs.length !== queue.jobs.length && fs.readFileSync(catalogFile, 'utf8') === catalogRaw && fs.readFileSync(file, 'utf8') === raw) require('./native-files.cjs').replaceFile(file, raw, JSON.stringify({ version: 1, jobs }, null, 2) + '\n');
  }
}
function command(dataDir, action, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address(dataDir)); let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(Error('后台登记进程应答超时')); }, timeout);
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(action + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.length > 4096) return finish(Error('无效的登记进程应答')); if (data.includes('\n')) { try { finish(null, JSON.parse(data.split('\n')[0])); } catch (error) { finish(error); } } });
    socket.on('end', () => { if (!data.includes('\n')) finish(Error('后台登记进程连接已关闭')); });
  });
}
function recordError(dataDir, backend, error) {
  const file = path.join(dataDir, 'desktop-sync/registration-errors.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, state = raw ? JSON.parse(raw) : {};
  if (error) state[backend] = error.message; else delete state[backend];
  if (raw || Object.keys(state).length) require('./native-files.cjs').replaceFile(file, raw, JSON.stringify(state));
}
async function flushAll(dataDir) {
  await Promise.all(backends.map(async backend => {
    try { await require('./' + backend + '-desktop-registration.cjs').flush(dataDir); recordError(dataDir, backend); }
    catch (error) { recordError(dataDir, backend, error); }
  }));
}
// The named-pipe client above only stops helpers left by version 0.1.27.
// This version never starts a registration process or pipe server.
module.exports = { address, command, hasPending, pruneQueues, flushAll };
