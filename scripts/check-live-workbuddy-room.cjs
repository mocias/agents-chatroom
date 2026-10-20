'use strict';
const fs = require('node:fs');
const path = require('node:path');
const installed = process.argv.includes('--installed');
const { createApplication } = require(installed
  ? 'D:/Agent Room/resources/app.asar/standalone/server.cjs'
  : '../standalone/server.cjs');
const { publicError } = require('../standalone/claude-acp.cjs');

(async () => {
  const executable = process.argv[2], model = process.argv[3] || 'deepseek-v4.1-flash';
  const effort = process.argv[4] || null;
  if (!executable) throw new Error('Pass the selected WorkBuddy AI executable');
  const output = fs.mkdtempSync(path.resolve('output/workbuddy-room-live-'));
  const dataDir = path.join(output, 'data'), workspace = path.join(output, 'agent');
  fs.mkdirSync(dataDir); fs.mkdirSync(workspace);
  const agent = { id: 'probe', label: 'WorkBuddy诊断', backend: 'workbuddy-ai', model, effort, modelLocked: true, workspace, aliases: [], createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify({ version: 1, agents: [agent],
    conversations: [{ id: 'probe-chat', kind: 'direct', title: agent.label, agentIds: [agent.id], updatedAt: agent.createdAt }] }));
  fs.writeFileSync(path.join(dataDir, 'discovery-consent.json'), JSON.stringify({ choice: 'manual' }));
  fs.writeFileSync(path.join(dataDir, 'backend-preferences.json'), JSON.stringify({ 'workbuddy-ai': { path: executable } }));
  const app = createApplication({ dataDir, workspaceRoot: output, registerAgent: async () => ({ status: 'test-isolated' }),
    prepareNativeSession: async () => ({}), afterNativeTurn: async () => {}, discoveryInventory: async () => ({ rows: [] }) });
  const report = { testedAt: new Date().toISOString(), output, model, effort, installed, isolatedData: true, userMessagesSent: 0 };
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + app.server.address().port;
    const call = async (route, body) => {
      const response = await fetch(url + '/api' + route, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || String(response.status));
      return result;
    };
    await call('/say', { room: 'probe-chat', text: '只回复 WORKBUDDY_ROOM_OK。不要使用工具、读取或修改文件。' });
    report.userMessagesSent++;
    const deadline = Date.now() + 60000;
    let view;
    do {
      await new Promise(resolve => setTimeout(resolve, 250));
      view = await call('/conversation?id=probe-chat');
    } while ((view.pending || view.snapshot.busy.length || !view.snapshot.log.some(r => r.kind === 'agent' || r.kind === 'system')) && Date.now() < deadline);
    report.reply = view.snapshot.log.find(r => r.kind === 'agent')?.text;
    report.errors = view.snapshot.log.filter(r => r.kind === 'system').map(r => publicError(r.text));
    report.memberError = view.snapshot.members[0]?.error || null;
    report.finished = !view.pending && !view.snapshot.busy.length;
    report.passed = report.finished && report.reply?.trim() === 'WORKBUDDY_ROOM_OK' && !report.memberError;
  } catch (error) { report.passed = false; report.error = publicError(error); }
  finally {
    await app.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(publicError(error)); process.exitCode = 1; });
