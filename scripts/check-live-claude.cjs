'use strict';
// node scripts/check-live-claude.cjs ["C:/.../claude.exe"] [--chat]
// No --chat: initialize and query models only. --chat: ONE short model request.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { adapt, BackendDiscovery } = require('../standalone/discovery.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
const { queryModels } = require('../standalone/models.cjs');
const { publicError } = require('../standalone/claude-acp.cjs');

(async () => {
  const output = fs.mkdtempSync(path.resolve('output/claude-live-'));
  const report = { testedAt: new Date().toISOString(), output, modelRequestsSent: false, chatVerified: false, passed: false };
  let pool, timer;
  try {
    const cli = process.argv.slice(2).find(arg => !arg.startsWith('--'));
    const candidate = cli ? adapt('claude', cli, 'live check')
      : (await new BackendDiscovery({ dir: output }).scan()).find(row => row.id === 'claude')?.selected;
    if (!candidate) throw new Error('未找到 Claude Code。请传入终端程序或已配置 Gateway API 的 Claude 桌面程序路径。');
    report.runtimePath = candidate.path;
    const model = process.argv.find(arg => arg.startsWith('--model='))?.slice(8);
    const catalog = await queryModels('claude', candidate.launch, output, model);
    report.models = catalog.models; report.selected = catalog.selected; report.initialized = true;
    // Model discovery does not prove account authorization or actual inference.
    report.loginVerified = false;
    pool = new AcpPool({ ...candidate.launch, env: { ...candidate.launch.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32', MAX_THINKING_TOKENS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, cwd: output });
    timer = setTimeout(() => { void pool.stop(); }, 90000);
    const workspaces = ['one'].map(name => path.join(output, name));
    workspaces.forEach(cwd => fs.mkdirSync(cwd));
    const threads = [];
    for (let i = 0; i < workspaces.length; i++) threads.push(await pool.openThread(String(i), {
      cwd: workspaces[i], model: catalog.selected, strictModel: true,
      developerInstructions: '你是本机 Agent Room 的聊天伙伴。只回答用户，不使用工具。',
    }));
    report.sessions = threads.map((thread, i) => ({ id: thread.id, workspace: workspaces[i] }));
    if (process.argv.includes('--chat')) {
      report.modelRequestsSent = true; report.replies = [];
      for (let i = 0; i < threads.length; i++) {
        const marker = 'CLAUDE_ROOM_OK';
        const reply = await pool.runTurn(String(i), { text: 'Reply with exactly ' + marker + '. Do not use tools.', timeoutMs: 45000 });
        report.replies.push({ text: reply.text, status: reply.status, usage: reply.usage });
        assert.equal(reply.status, 'end_turn'); assert.equal(reply.text.trim(), marker);
      }
      report.chatVerified = true; report.loginVerified = true;
    }
    report.passed = true;
  } catch (error) { report.error = publicError(error); process.exitCode = 1; }
  finally {
    clearTimeout(timer); await pool?.stop();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(publicError(error)); process.exitCode = 1; });
