const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const { CodexThreadPool } = require('../lib/codex-pool.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
const { chooseWorkspace } = require('../standalone/workspaces.cjs');
(async () => {
  const root = fs.mkdtempSync(path.resolve('output/live-workspaces-'));
  const rows = await new BackendDiscovery({ dir: root }).scan();
  const report = [];
  for (const backend of ['codex', 'dsh']) {
    const cwd = chooseWorkspace(root, backend, '工作区验收');
    const launch = rows.find(r => r.id === backend).selected.launch;
    const pool = backend === 'codex' ? new CodexThreadPool(launch) : new AcpPool(launch);
    try {
      await pool.start();
      const one = await pool.openThread('group-one', { cwd, sandbox: 'read-only' });
      const two = await pool.openThread('group-two', { cwd, sandbox: 'read-only' });
      assert.notEqual(one.id, two.id);
      assert.equal(one.cwd, cwd);
      assert.equal(two.cwd, cwd);
      report.push({ backend, cwd, sessions: [one.id, two.id] });
    } finally { await pool.stop(); }
  }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, report }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
