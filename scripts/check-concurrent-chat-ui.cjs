'use strict';
// Real UI + HTTP + SSE + room engine; only model inference is held by a fixture.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { AgentRoom } = require('../lib/room.cjs');
const { createApplication } = require('../standalone/server.cjs');

(async () => {
  const output = fs.mkdtempSync(path.resolve('output/concurrent-chat-ui-'));
  const rooms = new Map(), held = new Map(), steers = [], turns = [];
  const app = createApplication({ dataDir: path.join(output, 'data'), workspaceRoot: path.join(output, 'agents'),
    registerAgent: async () => ({ status: 'registered' }), prepareNativeSession: async () => ({}), afterNativeTurn: async () => {},
    discoveryInventory: async () => ({ rows: [] }),
    roomFactory: settings => {
      const room = new AgentRoom(settings); rooms.set(settings.id, room);
      for (const backend of new Set(settings.members.map(m => m.backend))) {
        const threads = new Map();
        room.pools.set(backend, { running: false, supportsInject: false, supportsSteer: backend === 'codex',
          async start() { this.running = true; }, async stop() { this.running = false; },
          async modelCapabilities() { return new Map(); }, getThread: id => threads.get(id),
          async openThread(id, options) { const thread = { id, ...options }; threads.set(id, thread); return thread; },
          closeThread: id => threads.delete(id),
          async steer(id, text) { steers.push({ room: settings.id, id, text }); return { ok: true }; },
          async interrupt(id) { held.get(settings.id + id)?.({ status: 'cancelled', text: '' }); held.delete(settings.id + id); return true; },
          async runTurn(id, input) {
            turns.push({ room: settings.id, id, text: input.text });
            if (backend === 'codex' || input.text.includes('ACP_HOLD') && !input.text.includes('ACP_FOLLOWUP')) {
              return new Promise(resolve => held.set(settings.id + id, resolve));
            }
            input.onDelta('FAST_REPLY'); return { text: 'FAST_REPLY' };
          },
        });
      }
      return room;
    },
  });
  let browser;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + app.server.address().port;
    const call = async (route, body) => {
      const response = await fetch(url + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    };
    await call('/discovery-consent', { choice: 'manual' });
    const slow = await call('/agents', { label: '慢速伙伴', backend: 'codex' });
    const fast = await call('/agents', { label: '快速伙伴', backend: 'dsh' });
    const group = (await call('/groups', { title: '并发发送验证', agentIds: [slow.agent.id, fast.agent.id] })).conversation;
    browser = await chromium.launch({ executablePath: process.env.UI_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    const open = async id => { await page.locator('[data-room="' + id + '"]').click(); await page.waitForFunction(() => !document.querySelector('#send').disabled); };
    const send = async (text, enter = false) => {
      await page.locator('#draft').fill(text);
      if (enter) await page.locator('#draft').press('Enter'); else await page.locator('#send').click();
      await page.waitForFunction(() => !document.querySelector('#send').disabled);
    };
    await open(group.id); await send('@慢速伙伴 first');
    assert.ok(rooms.get(group.id).snapshot().busy.includes(slow.agent.id));
    await send('@快速伙伴 second', true);
    await page.locator('#messages').getByText('FAST_REPLY', { exact: true }).waitFor();
    await send('@慢速伙伴 follow-up');
    assert.match(steers.find(s => s.room === group.id).text, /follow-up/);
    await page.locator('#draft').fill('保留群聊草稿');
    await open(slow.conversation.id); await send('direct first'); await send('direct follow-up', true);
    assert.match(steers.find(s => s.room === slow.conversation.id).text, /direct follow-up/);
    await open(group.id);
    assert.equal(await page.locator('#draft').inputValue(), '保留群聊草稿');
    assert.equal(await page.locator('#send').isEnabled(), true);
    await page.screenshot({ path: path.join(output, 'send-while-thinking.png') });
    await page.locator('#stop').click(); await page.locator('#stop').waitFor({ state: 'hidden' });
    await open(slow.conversation.id); await page.locator('#stop').click(); await page.locator('#stop').waitFor({ state: 'hidden' });
    await open(fast.conversation.id); await send('ACP_HOLD');
    await send('ACP_FOLLOWUP', true);
    await page.locator('#messages').getByText('FAST_REPLY', { exact: true }).waitFor();
    assert.ok(turns.some(t => t.room === fast.conversation.id && t.text.includes('ACP_HOLD') && t.text.includes('ACP_FOLLOWUP')));
    assert.equal(rooms.get(group.id).log.filter(r => r.kind === 'user').length, 3);
    assert.equal(rooms.get(slow.conversation.id).log.filter(r => r.kind === 'user').length, 2);
    assert.equal(rooms.get(fast.conversation.id).log.filter(r => r.kind === 'user').length, 2);
    assert.deepEqual(errors, []);
    const report = { ok: true, checks: ['Group sends while another member thinks', 'Click and Enter sending', 'Same-member steering', 'Direct follow-ups', 'Switch away/back retains draft and enabled composer', 'Stop completes', 'ACP cancellation carries both messages into next turn', 'No duplicate user messages or browser errors'] };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, ...report }));
  } finally {
    for (const resolve of held.values()) resolve({ status: 'cancelled', text: '' });
    await browser?.close(); await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
