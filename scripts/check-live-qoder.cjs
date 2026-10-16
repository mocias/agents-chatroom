const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
(async () => {
  const cwd = fs.mkdtempSync(path.resolve('output/qoder-live-'));
  const row = (await new BackendDiscovery({ dir: cwd }).scan()).find(r => r.id === 'qoder');
  assert.equal(row.selected.kind, '桌面后端');
  const pool = new AcpPool({ ...row.selected.launch, cwd });
  try {
    await pool.start();
    const one = await pool.openThread('one', { cwd, sandbox: 'read-only' });
    const two = await pool.openThread('two', { cwd, sandbox: 'read-only' });
    assert.notEqual(one.id, two.id);
    const reply = await pool.runTurn('one', { text: 'Reply with exactly QODER_OK. Do not use tools or change files.', timeoutMs: 60000 });
    assert.match(reply.text, /QODER_OK/);
    const report = { path: row.selected.path, protocol: pool.info?.agentInfo, cwd, independentSessions: true, reply: reply.text, models: await pool.listModels() };
    fs.writeFileSync(path.join(cwd, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await pool.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
