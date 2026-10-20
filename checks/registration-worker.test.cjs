'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDispatcher } = require('../standalone/registration-dispatcher.cjs');
const codex = require('../standalone/codex-desktop-registration.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-lifecycle-'));
  const home = path.join(root, 'codex'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  const agent = { id: 'agent', label: 'Lifecycle', backend: 'codex', workspace };
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ agents: [agent], conversations: [] }));
  const target = path.join(home, '.codex-global-state.json'); fs.writeFileSync(target, JSON.stringify({ keep: true }));
  codex.enqueue(root, agent, 'project', { env: { CODEX_HOME: home } });
  const controllers = [];
  t.after(async () => {
    await Promise.all(controllers.map(c => c.close()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, target, create: options => { const c = createDispatcher(root, options); controllers.push(c); return c; } };
}
test('closing registration pauses writes, keeps pending jobs and reopening resumes them', async t => {
  const f = fixture(t); let running = true, cycles = 0;
  const options = { intervalMs: 20, flush: async () => { cycles++; await codex.flush(f.root, { running: async () => running }); } };
  const first = f.create(options); await first.kick(); await first.close();
  const before = cycles; running = false; await wait(100); await first.kick();
  assert.equal(cycles, before);
  assert.equal(JSON.parse(fs.readFileSync(f.target))['local-projects'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'desktop-sync/codex-pending.json'))).jobs.length, 1);
  const second = f.create(options); await second.kick(); await second.close();
  assert.ok(JSON.parse(fs.readFileSync(f.target))['local-projects'].project);
  assert.equal(JSON.parse(fs.readFileSync(f.target)).keep, true);
  assert.equal(fs.existsSync(path.join(f.root, 'desktop-sync/worker')), false);
});
test('close waits for an active write and prevents overlapping or subsequent cycles', async t => {
  const f = fixture(t); let release, entered, cycles = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const c = f.create({ intervalMs: 20, flush: async () => { cycles++; entered(); await gate; } });
  await started;
  const first = c.kick(); assert.equal(c.kick(), first);
  let closed = false; const closing = c.close().then(() => { closed = true; });
  await wait(60); assert.equal(closed, false); assert.equal(cycles, 1);
  release(); await closing; await c.kick(); await wait(60); assert.equal(cycles, 1);
});
test('legacy helper is stopped before native writes and deleted agents are pruned', async t => {
  const f = fixture(t), calls = [];
  fs.writeFileSync(path.join(f.root, 'catalog.json'), JSON.stringify({ agents: [] }));
  const c = f.create({ stopLegacyWorker: async () => calls.push('stop-legacy'), flush: async () => calls.push('flush') });
  await c.kick(); await c.close();
  assert.deepEqual(calls, ['stop-legacy', 'flush']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'desktop-sync/codex-pending.json'))).jobs.length, 0);
});
test('closing Room cancels scheduled registration without handing work to another process', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-close-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ version: 1, agents: [{ id: 'a', backend: 'claude', label: 'a', workspace: root }], conversations: [] }));
  fs.writeFileSync(path.join(root, 'discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  const calls = [];
  const app = require('../standalone/server.cjs').createApplication({ dataDir: root,
    registrationDispatcher: () => ({ kick: async () => calls.push('kick'), close: async () => calls.push('stop') }),
    registerAgent: async () => { calls.push('register'); return { status: 'waiting-for-exit' }; } });
  await app.close(); assert.deepEqual(calls, ['stop']);
});
