'use strict';
// Explicit live acceptance: creates/reuses two review contacts and a group in
// the running local app, then sends one fixed-text test to the real backend.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = process.env.AGENT_ROOM_URL || 'http://127.0.0.1:4318';
const exe = process.argv[2];
if (!exe || !path.isAbsolute(exe)) throw new Error('Pass the full WorkBuddyAI.exe path');
const reportDir = fs.mkdtempSync(path.resolve('output/workbuddy-group-'));
const report = { base, reportDir, reusedDesktopLogin: true, loginStarted: false, passed: false };
async function api(route, body) {
  const response = await fetch(base + '/api' + route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
  return result;
}
(async () => {
  try {
    await api('/backends', { id: 'workbuddy-ai', path: exe });
    const models = await api('/models', { backend: 'workbuddy-ai', model: 'fast-model', refresh: true });
    report.models = models.models; report.selectedModel = models.selected;
    const catalog = await api('/catalog'), agents = [];
    for (const label of ['WorkBuddy AI', 'WorkBuddy AI 测试伙伴']) {
      let agent = catalog.agents.find(a => a.label === label && a.backend === 'workbuddy-ai');
      if (!agent) agent = (await api('/agents', { label, backend: 'workbuddy-ai', model: models.selected })).agent;
      agents.push(agent);
    }
    assert.notEqual(agents[0].workspace, agents[1].workspace);
    report.agents = agents.map(({ id, label, workspace, model, modelLocked }) => ({ id, label, workspace, model, modelLocked }));
    let group = catalog.conversations.find(c => c.title === 'WorkBuddy AI 接入验证' && c.kind === 'group' && agents.every(a => c.agentIds.includes(a.id)));
    if (!group) group = (await api('/groups', { title: 'WorkBuddy AI 接入验证', agentIds: agents.map(a => a.id) })).conversation;
    report.group = group;
    const previous = (await api('/conversation?id=' + group.id)).snapshot.log;
    await api('/say', { room: group.id, text: '@所有人 请各自只回复 WORKBUDDY_GROUP_OK，不要调用工具、读取或修改文件。' });
    const deadline = Date.now() + 150000;
    let state;
    do {
      await new Promise(resolve => setTimeout(resolve, 1000));
      state = await api('/conversation?id=' + group.id);
    } while ((state.pending || state.snapshot.busy.length) && Date.now() < deadline);
    report.members = state.snapshot.members;
    report.log = state.snapshot.log.slice(previous.length);
    assert.equal(state.pending, false, 'group request must finish');
    assert.equal(state.snapshot.busy.length, 0);
    const ids = state.snapshot.members.map(m => m.threadId);
    assert.ok(ids.every(Boolean)); assert.equal(new Set(ids).size, 2);
    for (const member of state.snapshot.members) {
      assert.equal(member.error, null);
      assert.ok(report.log.some(row => row.authorId === member.id && row.text?.includes('WORKBUDDY_GROUP_OK')), 'missing real group reply from ' + member.label);
    }
    report.passed = true;
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
