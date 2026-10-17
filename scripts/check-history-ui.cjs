'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
(async () => {
  const home = fs.mkdtempSync(path.resolve('output/history-ui-'));
  const dataDir = path.join(home, 'data'); fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true });
  const conversations = ['group', 'direct'].map(kind => ({ id: kind, kind, title: kind === 'group' ? '设计讨论组' : '设计伙伴', agentIds: [], updatedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify({ agents: [], conversations }));
  fs.writeFileSync(path.join(dataDir, 'discovery-consent.json'), '{"choice":"manual"}');
  const records = Array.from({ length: 43 }, (_, i) => ({ id: 'm' + i, seq: i, authorLabel: '设计伙伴', ts: new Date().toISOString(), kind: 'agent', text: '设计方案 ' + i + (i === 0 ? ' <img src=x onerror=alert(1)>' : ''), visibility: i === 1 ? 'private' : 'public', recipientLabels: ['审查员'] }));
  for (const c of conversations) fs.writeFileSync(path.join(dataDir, 'rooms', c.id + '.log.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: process.env.UI_EXECUTABLE || path.resolve('dist/win-unpacked/Agent Room.exe'), ...(process.env.UI_DEV ? { args: ['desktop/main.cjs'] } : {}), env });
  try {
    // Select a deterministic test destination instead of interacting with Save As.
    await app.evaluate(({ session, app }, destination) => { app.historyDownloads = []; session.defaultSession.on('will-download', (_e, item) => { item.setSavePath(destination + '/' + item.getFilename()); item.once('done', (_e, state) => app.historyDownloads.push({ state, path: item.getSavePath() })); }); }, home);
    async function downloaded(index) { for (let i = 0; i < 100; i++) { const value = await app.evaluate(({ app }, index) => app.historyDownloads[index], index); if (value) { assert.equal(value.state, 'completed'); return value.path; } await new Promise(r => setTimeout(r, 50)); } throw new Error('Export download did not complete'); }
    const page = await app.firstWindow();
    await page.locator('#history-all').click();
    await page.locator('#history-count').filter({ hasText: '共 86' }).waitFor();
    assert.equal(await page.locator('[data-export="json"]').isDisabled(), true);
    await page.locator('#history-scope').selectOption('group');
    await page.locator('#history-count').filter({ hasText: '共 43' }).waitFor();
    assert.equal(await page.locator('.history-result').count(), 40);
    assert.equal(await page.locator('#history-results img').count(), 0);
    assert.equal(await page.locator('.private-history').count(), 1);
    await page.locator('#history-next').click(); await page.locator('#history-count').filter({ hasText: '41–43' }).waitFor();
    await page.locator('#history-query').fill('方案 1'); await page.locator('#history-query').press('Enter');
    await page.locator('#history-count').filter({ hasText: '共 11' }).waitFor();
    assert.ok(await page.locator('#history-results mark').count() > 0);
    await page.locator('[data-export="json"]').click();
    assert.equal(JSON.parse(fs.readFileSync(await downloaded(0), 'utf8')).messages.length, 43);
    await page.locator('#history-scope').selectOption('direct');
    await page.locator('#history-count').filter({ hasText: '共 11' }).waitFor();
    await page.locator('[data-export="md"]').click();
    assert.match(fs.readFileSync(await downloaded(1), 'utf8'), /设计伙伴/);
    await page.screenshot({ path: path.join(home, 'history.png') });
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify({ passed: true, groupExportCount: 43, directMarkdownExport: true, searchPagination: true, escapedHtml: true }));
    console.log(JSON.stringify({ passed: true, home }));
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
