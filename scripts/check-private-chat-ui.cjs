'use strict';
// Real browser + HTTP service + room engine, deterministic simulated models.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { createApplication } = require('../standalone/server.cjs');
const { AgentRoom } = require('../lib/room.cjs');

(async () => {
  const home = fs.mkdtempSync(path.resolve('output/private-chat-ui-'));
  const calls = [];
  const app = createApplication({ dataDir: home, workspaceRoot: path.join(home, 'agents'),
    registerAgent: async () => ({ status: 'registered' }), prepareNativeSession: async () => ({}), afterNativeTurn: async () => {},
    discoveryInventory: async () => ({ rows: [], warning: '' }),
    queryModels: async () => ({ selected: 'test', models: [{ id: 'test', name: 'test', efforts: [] }] }),
    roomFactory: settings => {
      const room = new AgentRoom({ ...settings, segmentMs: 50, queueStallMs: 0 });
      const threads = new Map(); let responded = false, alarmResponded = false;
      room.pools.set('codex', { running: true,
        async start() {}, async stop() {}, async modelCapabilities() { return new Map([['test', { efforts: ['none'], defaultEffort: 'none' }]]); },
        getThread: id => threads.get(id), closeThread: id => threads.delete(id),
        async openThread(id, config) { const thread = { id, ...config }; threads.set(id, thread); return thread; },
        async runTurn(id, input) {
          const label = room.members.find(m => m.id === id).label;
          calls.push({ label, text: input.text });
          let text = label === '架构师' && !responded
            ? '公开结论\n---\n#审查员 secret-ui-789\n---\n@研究员 核对公开资料' : '(无补充)';
          if (label === '架构师' && !alarmResponded && input.text.includes('请设置验收闹钟')) {
            alarmResponded = true;
            text = '/alarm 1s #审查员 alarm-private-456\n---\n/alarm 1s @研究员 alarm-public-123';
          }
          if (label === '架构师') responded = true;
          input.onDelta(text); return { text };
        }, async interrupt() { return true; }
      });
      return room;
    }
  });
  let browser;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const post = async (route, body) => {
      const response = await fetch(base + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    await post('/discovery-consent', { choice: 'manual' });
    const agents = [];
    for (const label of ['架构师', '审查员', '研究员']) agents.push((await post('/agents', { label, backend: 'codex', model: 'test' })).agent);
    const group = (await post('/groups', { title: '私聊验收', agentIds: agents.map(a => a.id) })).conversation;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.getByRole('button', { name: /私聊验收/ }).click();
    const draft = page.locator('#draft');
    await draft.fill('#架');
    await page.locator('#mention-suggestions button').filter({ hasText: '架构师' }).click();
    assert.equal(await draft.inputValue(), '#架构师 ');
    await draft.fill('@架构师 开始讨论');
    await page.locator('#send').click();
    await page.locator('.private-message').waitFor();
    await page.waitForFunction(() => !document.querySelector('#send').disabled && !document.querySelector('.message.live'));
    assert.equal(await page.locator('.private-message').count(), 1);
    assert.match(await page.locator('.private-message').innerText(), /架构师 → 审查员/);
    assert.equal(await page.locator('.private-message .bubble').innerText(), '#审查员 secret-ui-789');
    assert.equal(await page.locator('.message.user .bubble').first().innerText(), '@架构师 开始讨论');
    const colors = await page.evaluate(() => ({ private: getComputedStyle(document.querySelector('.private-message .bubble')).backgroundColor, public: getComputedStyle(document.querySelector('.message:not(.private-message):not(.user) .bubble')).backgroundColor }));
    assert.notEqual(colors.private, colors.public);
    await page.reload();
    await page.locator('.private-message').waitFor();
    assert.equal(await page.locator('.private-message').count(), 1);
    await draft.fill('#不存在 请保密');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#draft').value.includes('#不存在'));
    assert.equal(await page.locator('.private-message').count(), 1);
    assert.ok(calls.some(c => c.label === '审查员' && c.text.includes('#审查员 secret-ui-789')));
    assert.ok(calls.some(c => c.label === '研究员'));
    assert.ok(calls.filter(c => c.label === '研究员').every(c => !c.text.includes('secret-ui-789')));
    await draft.fill('@架构师 请设置验收闹钟');
    await page.locator('#send').click();
    await page.locator('#messages').getByText(/^#审查员 当前时间为：.*alarm-private-456/).waitFor();
    await page.locator('#messages').getByText(/^@研究员 当前时间为：.*alarm-public-123/).waitFor();
    await page.waitForFunction(() => !document.querySelector('#send').disabled && !document.querySelector('.message.live'));
    assert.ok(calls.some(c => c.label === '审查员' && /#系统：#审查员 当前时间为：.*alarm-private-456/.test(c.text)));
    assert.ok(calls.filter(c => c.label === '研究员').every(c => !c.text.includes('alarm-private-456')));
    await draft.fill('/alarm 1h #审查员 cancel-ui'); await page.locator('#send').click();
    await page.getByText(/闹钟已设置：.*cancel-ui/).waitFor();
    await page.locator('#alarms').click();
    await page.locator('.alarm-row').filter({ hasText: 'cancel-ui' }).getByRole('button', { name: '取消闹钟' }).click();
    await page.locator('.alarm-row').filter({ hasText: 'cancel-ui' }).filter({ hasText: '已取消' }).waitFor();
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(home, 'chat.png'), fullPage: true });
    const report = { passed: true, model: 'simulated', checks: ['# completion', 'mixed reply split', 'private label and # body', 'distinct colors', 'reload persistence', 'invalid recipient draft recovery', 'recipient input marker', 'third agent exclusion', 'no browser errors', 'agent alarm commands', 'private and public system envelopes', 'private alarm recipient isolation', 'alarm list and cancellation'], colors };
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ home, ...report }));
  } finally { if (browser) await browser.close(); await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
