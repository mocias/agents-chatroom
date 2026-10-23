'use strict';
// Actual packaged app, additive upgrade fixture, no discovery or model requests.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const { _electron } = require('playwright-core');

(async () => {
  fs.mkdirSync(path.resolve('output'), { recursive: true });
  const home = fs.mkdtempSync(path.resolve('output/packaged-memory-'));
  const archive = path.resolve('dist/win-unpacked/resources/app.asar');
  const packagedSources = ['lib/agent-memory.cjs', 'lib/room.cjs', 'standalone/server.cjs',
    'standalone/workspaces.cjs', 'standalone/public/app.js', 'standalone/public/app.css'];
  for (const file of packagedSources) assert.deepEqual(asar.extractFile(archive, path.normalize(file)), fs.readFileSync(path.resolve(file)), file);
  const archiveFiles = asar.listPackage(archive);
  assert.ok(!archiveFiles.some(file => /(^|[/\\])(memory|agents|output|checks|\.agent-room-data)([/\\]|$)/.test(file)), 'Runtime/private data in ASAR');
  const data = path.join(home, 'data'), roomsDir = path.join(data, 'rooms'), workspaceRoot = path.join(home, 'agents');
  fs.mkdirSync(roomsDir, { recursive: true });
  const now = new Date().toISOString();
  const agents = ['a', 'b'].map(id => ({ id, label: id === 'a' ? 'CC 伙伴甲' : 'CC 伙伴乙', backend: 'claude',
    workspace: path.join(workspaceRoot, id), createdAt: now }));
  for (const agent of agents) { fs.mkdirSync(agent.workspace, { recursive: true }); fs.writeFileSync(path.join(agent.workspace, 'keep.txt'), 'UNCHANGED_' + agent.id); }
  const conversations = agents.map(agent => ({ id: 'direct-' + agent.id, title: agent.label, kind: 'direct', agentIds: [agent.id], updatedAt: now }));
  conversations.push({ id: 'old-group', title: '已有讨论组', kind: 'group', agentIds: ['a', 'b'], updatedAt: now });
  fs.writeFileSync(path.join(data, 'catalog.json'), JSON.stringify({ version: 1, agents, conversations }));
  fs.writeFileSync(path.join(data, 'discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  const record = (id, text, extra = {}) => ({ id, seq: Number(id.slice(1)), ts: now, kind: 'user',
    authorId: 'user', authorLabel: '用户', visibility: 'public', recipientIds: [], text, ...extra });
  fs.writeFileSync(path.join(roomsDir, 'direct-a.log.jsonl'), JSON.stringify(record('m1', '单聊项目约定 DIRECT_MEMORY_7281')) + '\n');
  fs.writeFileSync(path.join(roomsDir, 'old-group.log.jsonl'), [record('m1', '群聊共识 GROUP_MEMORY_521'),
    record('m2', '#CC 伙伴甲 EXPLICIT_PRIVATE_957', { visibility: 'private', recipientIds: ['a'] })].map(item => JSON.stringify(item)).join('\n') + '\n');
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const protectedFiles = [path.join(roomsDir, 'direct-a.log.jsonl'), path.join(roomsDir, 'old-group.log.jsonl'),
    ...agents.map(agent => path.join(agent.workspace, 'keep.txt'))];
  const before = protectedFiles.map(file => ({ file, sha256: hash(file) }));
  const env = { ...process.env, AGENT_ROOM_DESKTOP_HOME: home, AGENT_ROOM_WORKSPACE_ROOT: workspaceRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  let instance, generationRequests = 0;
  const errors = [];
  const launch = async () => {
    instance = await _electron.launch({ executablePath: path.resolve('dist/win-unpacked/Agent Room.exe'), env, timeout: 30000 });
    const page = await instance.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/say') generationRequests++; });
    await page.getByText('本地已连接', { exact: true }).waitFor();
    return page;
  };
  const read = (page, route) => page.evaluate(async route => {
    const response = await fetch('/api' + route); if (!response.ok) throw new Error(await response.text()); return response.json();
  }, route);
  try {
    let page = await launch();
    const version = await instance.evaluate(({ app }) => app.getVersion());
    assert.equal(version, require('../package.json').version);
    const one = await read(page, '/agents/memory?id=a'), two = await read(page, '/agents/memory?id=b');
    assert.equal(one.count, 3); assert.equal(two.count, 1);
    assert.match(JSON.stringify(one), /DIRECT_MEMORY_7281/);
    assert.doesNotMatch(JSON.stringify(two), /DIRECT_MEMORY_7281|EXPLICIT_PRIVATE_957/);
    await page.locator('[data-room="direct-a"]').click();
    await page.locator('#members').click();
    await page.locator('#view-agent-memory').click();
    await page.locator('.memory-entry').first().waitFor();
    assert.match(await page.locator('#memory-entries').textContent(), /已有讨论组/);
    await page.screenshot({ path: path.join(home, 'memory-packaged.png') });
    await instance.close(); instance = null;
    page = await launch();
    assert.equal((await read(page, '/agents/memory?id=a')).count, one.count);
    assert.equal((await read(page, '/agents/memory?id=b')).count, two.count);
    const catalog = await read(page, '/catalog');
    assert.deepEqual(catalog.agents.map(agent => [agent.id, agent.workspace]), agents.map(agent => [agent.id, agent.workspace]));
    assert.deepEqual(catalog.conversations.map(item => item.id), conversations.map(item => item.id));
    for (const { file, sha256 } of before) assert.equal(hash(file), sha256, file);
    assert.equal(generationRequests, 0); assert.deepEqual(errors, []);
    const report = { ok: true, version, home, packagedSources, noPrivateRuntimeInAsar: true,
      isolatedLegacyHistoryBackfilled: true, memoryCounts: { a: one.count, b: two.count },
      restartDeduplication: true, originalWorkspaceAssignmentsRetained: true, protectedFiles: before,
      generationRequests, realModelRequests: 0, browserErrors: errors };
    fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, version, home, generationRequests }));
  } finally { await instance?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
