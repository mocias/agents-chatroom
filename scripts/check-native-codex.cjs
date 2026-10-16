'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const { ensureCodexProject } = require('../standalone/desktop-sync.cjs');
const { CodexThreadPool } = require('../lib/codex-pool.cjs');
(async () => {
  const cwd = fs.mkdtempSync(path.resolve('output/native-codex-'));
  const row = (await new BackendDiscovery({ dir: cwd }).scan()).find(r => r.id === 'codex');
  const pool = new CodexThreadPool({ ...row.selected.launch, cwd });
  const agent = { id: 'verify-' + randomUUID(), label: 'Agent Room 同步验证', workspace: cwd };
  const report = { cwd, threads: [] };
  try {
    await pool.start();
    const projectId = await ensureCodexProject(pool, agent);
    assert.equal(await ensureCodexProject(pool, agent), projectId);
    report.projectId = projectId;
    for (const key of ['direct', 'group']) {
      const thread = await pool.openThread(key, { cwd, projectId });
      const reply = await pool.runTurn(key, { text: 'Reply with ONLY SYNC_OK. Do not use tools.', timeoutMs: 60000 });
      assert.match(reply.text, /SYNC_OK/);
      await pool.request('thread/name/set', { threadId: thread.id, name: 'Agent Room 同步验证 · ' + key });
      const saved = await pool.request('thread/read', { threadId: thread.id, includeTurns: false });
      assert.equal(saved.thread.projectId, projectId);
      report.threads.push({ id: thread.id, projectId: saved.thread.projectId, reply: reply.text });
    }
    assert.notEqual(report.threads[0].id, report.threads[1].id);
    fs.writeFileSync(path.join(cwd, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await pool.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
