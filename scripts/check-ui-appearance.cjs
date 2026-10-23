'use strict';
// Real browser + local HTTP/SSE, isolated data, no discovery or model requests.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { createApplication } = require('../standalone/server.cjs');
const { AgentRoom } = require('../lib/room.cjs');
const { PollStore } = require('../lib/polls.cjs');

(async () => {
  fs.mkdirSync(path.resolve('output/playwright'), { recursive: true });
  const home = fs.mkdtempSync(path.resolve('output/playwright/appearance-'));
  const data = path.join(home, 'data');
  fs.mkdirSync(path.join(data, 'rooms'), { recursive: true });
  const now = new Date().toISOString();
  const agents = [
    { id: 'designer', label: '设计伙伴', backend: 'codex' },
    { id: 'researcher', label: '研究员', backend: 'dsh' },
    { id: 'reviewer', label: '代码审查员', backend: 'qoder' },
    { id: 'writer', label: '写作伙伴', backend: 'claude' },
    { id: 'buddy', label: '协作伙伴', backend: 'workbuddy-ai' },
    { id: 'buddy-cn', label: '任务助手', backend: 'workbuddy' },
  ];
  const conversations = [
    { id: 'studio', kind: 'group', title: '灵感工作室', pinned: true, agentIds: agents.map(a => a.id), preview: '让不同的视角，在这里相遇。', updatedAt: now },
    ...agents.map(a => ({ id: a.id, kind: 'direct', title: a.label, agentIds: [a.id], preview: '随时聊聊你的下一个好想法', updatedAt: now })),
    { id: 'weekend', kind: 'group', title: '周末的好点子', agentIds: agents.slice(0, 2).map(a => a.id), preview: '一个小想法，也可以有很多种可能。', updatedAt: now },
  ];
  fs.writeFileSync(path.join(data, 'catalog.json'), JSON.stringify({ version: 1, agents, conversations }));
  fs.writeFileSync(path.join(data, 'discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  const records = [
    { kind: 'system', text: '欢迎来到灵感工作室 · 让好想法发生' },
    { kind: 'user', authorId: 'user', authorLabel: '你', text: '一起想想，怎样让 agentschat 更舒服、更适合每天使用？' },
    { kind: 'agent', authorId: 'designer', authorLabel: '设计伙伴', text: '先从一个安静、清晰的空间开始。给对话多一点留白，用柔和的绿色标记当前的关注点。' },
    { kind: 'agent', authorId: 'researcher', authorLabel: '研究员', text: '我来整理需求和参考。统一文字层级，让长时间阅读也能保持轻松。' },
    { kind: 'agent', authorId: 'reviewer', authorLabel: '代码审查员', text: '我负责检查实现：深浅主题、窄窗口和键盘操作，都要保持一致。' },
    { kind: 'agent', authorId: 'buddy', authorLabel: '协作伙伴', text: '我把这些想法整理成下一步行动：先打磨阅读，再完善文件分享和群聊协作。' },
    { kind: 'agent', authorId: 'writer', authorLabel: '写作伙伴', text: '留住每一次灵感，下次打开时，还能接着聊。', visibility: 'private', recipientIds: ['user'] },
  ].map((r, i) => ({ id: 'm' + i, seq: i + 1, ts: now, visibility: 'public', ...r }));
  fs.writeFileSync(path.join(data, 'rooms/studio.log.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const polls = new PollStore(path.join(data, 'polls.json'));
  const poll = polls.call('studio', 'designer', 'poll_create', { question: '下次优先打磨哪个使用体验？', options: ['长对话阅读', '文件分享', '群聊协作'], visibility: 'anonymous', duration_seconds: 3600, request_id: 'appearance' }, agents);
  polls.call('studio', 'researcher', 'poll_vote', { poll_id: poll.id, option_id: 'o2' }, agents);
  let modelCalls = 0;
  const app = createApplication({ dataDir: data, pollScheduling: false, discoveryInventory: async () => ({ rows: [], warning: '' }),
    registerAgent: async () => ({}), prepareNativeSession: async () => ({}), afterNativeTurn: async () => {},
    roomFactory: options => {
      const room = new AgentRoom(options);
      for (const backend of ['codex', 'dsh', 'qoder', 'claude', 'workbuddy-ai', 'workbuddy']) room.pools.set(backend, { running: true, stop: async () => {}, getThread: () => null, modelCapabilities: async () => new Map(), prompt: async () => { modelCalls++; throw new Error('Models disabled in appearance check'); } });
      return room;
    } });
  let browser;
  const errors = [];
  const checks = [];
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + app.server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.locator('[data-room="studio"]').waitFor();
    assert.equal(await page.title(), 'agentschat');
    await page.locator('.app-rail [data-filter="direct"]').click();
    assert.equal(await page.locator('[data-room="studio"]').count(), 0);
    assert.equal(await page.locator('[data-open-agent="designer"]').count(), 1);
    assert.equal(await page.locator('.app-rail [data-filter="direct"]').getAttribute('aria-pressed'), 'true');
    await page.locator('.app-rail [data-filter="group"]').click();
    assert.equal(await page.locator('[data-open-agent]').count(), 0);
    assert.equal(await page.locator('[data-room="studio"]').count(), 1);
    await page.locator('.app-rail [data-filter="all"]').click();
    checks.push('agentschat title and functional chat/Agent/group rail filters');
    await page.screenshot({ path: path.join(home, 'welcome-light.png') });
    await page.locator('[data-room="studio"]').click();
    await page.locator('.private-message').waitFor();
    for (const [id, label] of [['designer', 'Codex'], ['researcher', 'DSH'], ['reviewer', 'Qoder'], ['writer', 'Claude Code'], ['buddy', 'WorkBuddy AI'], ['buddy-cn', 'WorkBuddy']]) {
      assert.equal(await page.locator(`[data-room="${id}"] .harness-badge`).textContent(), label);
    }
    assert.ok(await page.locator('#messages .harness-badge').count() >= 5);
    assert.match(await page.locator('#chat-subtitle').textContent(), /Codex.*DSH.*Qoder.*Claude Code.*WorkBuddy AI/);
    checks.push('Harness identity visible in Agent list, group subtitle and message bylines');
    await page.locator('#messages').evaluate(el => { el.scrollTop = 0; });
    assert.ok(await page.evaluate(() => {
      const rail = document.querySelector('.app-rail').getBoundingClientRect();
      const list = document.querySelector('.sidebar').getBoundingClientRect();
      const chat = document.querySelector('.chat').getBoundingClientRect();
      return rail.right === list.left && list.right === chat.left && rail.width <= 60;
    }));
    await page.screenshot({ path: path.join(home, 'chat-light.png') });
    await page.locator('#draft').fill('保留这段草稿');
    await page.locator('#tools-toggle').click();
    await page.locator('#tools-menu').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(home, 'tools-light.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tools-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#draft').inputValue(), '保留这段草稿');
    await page.locator('#settings').click();
    await page.locator('.theme-preview').first().waitFor();
    await page.screenshot({ path: path.join(home, 'appearance-settings.png') });
    for (const preset of ['midnight', 'forest', 'dusk', 'contrast', 'paper']) {
      const changed = page.waitForResponse(r => r.url().endsWith('/api/theme') && r.request().method() === 'POST');
      await page.locator(`[data-preset="${preset}"]`).click();
      await changed;
      await page.waitForFunction(id => document.querySelector(`[data-preset="${id}"]`).getAttribute('aria-pressed') === 'true', preset);
      assert.equal(await page.locator('html').getAttribute('data-appearance'), preset === 'paper' ? 'light' : 'dark');
      await page.screenshot({ path: path.join(home, 'theme-' + preset + '.png') });
    }
    await page.locator('#close-modal').click();
    for (const color of ['rgb(16, 20, 24)', 'hsl(150, 20%, 8%)', '#123f']) {
      const response = await page.request.post(url + '/api/theme', { data: { colors: { '--ar-bg': color } } });
      assert.ok(response.ok());
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
    }
    checks.push('Custom RGB, HSL and short hex background colours restore dark controls after reload');
    await page.locator('#settings').click();
    await page.locator('[data-preset="midnight"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'dark');
    await page.locator('#close-modal').click();
    await page.locator('#messages').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(home, 'chat-dark.png') });
    checks.push('Five themes, selected preset state, native dark controls and saved draft');
    await page.locator('#tools-toggle').click();
    await page.locator('#polls').click();
    await page.locator('#poll-list .poll-card').waitFor();
    assert.ok((await page.locator('#poll-list .poll-options').textContent()).includes('待揭晓'));
    assert.equal(await page.locator('#poll-list .poll-card details').count(), 0);
    await page.screenshot({ path: path.join(home, 'poll-dark.png') });
    await page.locator('#close-modal').click();
    checks.push('Anonymous poll remains hidden before completion; theme-aware poll dialog');
    await page.locator('#settings').click();
    await page.locator('[data-preset="paper"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
    await page.locator('#close-modal').click();
    await page.locator('#draft').fill('@');
    await page.getByRole('option').first().waitFor();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#draft').inputValue(), /@/);
    assert.equal(await page.getByRole('option').count(), 0);
    checks.push('Mention keyboard selection and tool menu dismissal');
    for (const width of [1440, 1000, 720, 390]) {
      await page.setViewportSize({ width, height: 820 });
      const geometry = await page.evaluate(() => {
        const ids = ['.sidebar', '.chat-header', '.composer', '#send'];
        return { overflow: document.documentElement.scrollWidth > innerWidth, boxes: ids.map(id => { const r = document.querySelector(id).getBoundingClientRect(); return { id, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }) };
      });
      assert.equal(geometry.overflow, false, JSON.stringify(geometry));
      for (const box of geometry.boxes) assert.ok(box.x >= 0 && box.y >= 0 && box.right <= width + 1 && box.bottom <= 821, JSON.stringify(box));
      await page.locator('#tools-toggle').click();
      const menu = await page.locator('#tools-menu').boundingBox();
      assert.ok(menu.x >= 0 && menu.x + menu.width <= width + 1);
      await page.screenshot({ path: path.join(home, 'compact-' + width + '.png') });
      await page.keyboard.press('Escape');
    }
    checks.push('1440/1000/720/390px: visible composer/send, no document overflow, tool menu in viewport');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator('#history-current').click();
    await page.locator('.history-result').first().waitFor();
    await page.screenshot({ path: path.join(home, 'history-light.png') });
    await page.locator('#close-modal').click();
    await page.locator('[data-room="designer"]').click();
    await page.locator('.empty-chat strong').waitFor();
    await page.screenshot({ path: path.join(home, 'empty-chat.png') });
    checks.push('History search dialog and empty direct conversation');
    await page.locator('#members').click();
    await page.locator('#agent-memory-status').waitFor();
    await page.locator('#view-agent-memory').click();
    await page.locator('.memory-entry').first().waitFor();
    assert.match(await page.locator('#memory-count').textContent(), /已保存/);
    assert.match(await page.locator('#memory-entries').textContent(), /灵感工作室/);
    assert.ok(!(await page.locator('#memory-entries').textContent()).includes('留住每一次灵感'));
    await page.locator('[name="memoryQuery"]').fill('柔和的绿色');
    await page.locator('#modal-submit').click();
    await page.waitForFunction(() => document.querySelectorAll('.memory-entry').length === 1);
    assert.match(await page.locator('#memory-entries').textContent(), /柔和的绿色/);
    await page.screenshot({ path: path.join(home, 'agent-memory.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#modal').evaluate(element => {
      const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
    }));
    await page.screenshot({ path: path.join(home, 'agent-memory-mobile.png') });
    await page.locator('[name="memoryQuery"]').fill('不存在的记忆关键词');
    await page.locator('#modal-submit').click();
    await page.getByText('没有找到相关记忆。', { exact: true }).waitFor();
    checks.push('Agent memory viewer shows cross-room sources, excludes another Agent private records, searches and fits 390px');
    assert.equal(modelCalls, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify({ ok: true, home, checks, modelCalls, browserErrors: errors }, null, 2));
    console.log(JSON.stringify({ ok: true, home, checks }));
  } finally {
    await browser?.close();
    await app.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
