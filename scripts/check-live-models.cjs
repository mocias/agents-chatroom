'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const { queryModels } = require('../standalone/models.cjs');
const { CodexThreadPool } = require('../lib/codex-pool.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
(async () => {
  const cwd = fs.mkdtempSync(path.resolve('output/model-live-'));
  const rows = await new BackendDiscovery({ dir: cwd }).scan();
  const report = [];
  for (const id of ['codex', 'dsh']) {
    const launch = rows.find(r => r.id === id).selected.launch;
    const catalogue = await queryModels(id, launch, cwd);
    const model = catalogue.selected;
    const detail = await queryModels(id, launch, cwd, model);
    const selected = detail.models.find(m => m.id === model);
    assert.ok(selected.efforts.includes('low') && selected.efforts.includes('high'));
    const pool = id === 'codex' ? new CodexThreadPool({ ...launch, cwd }) : new AcpPool({ ...launch, cwd });
    const result = { backend: id, model, models: detail.models, turns: [] };
    try {
      await pool.start();
      const thread = await pool.openThread('test', { model, cwd, sandbox: 'read-only', approvalPolicy: 'never', strictModel: true });
      if (id === 'dsh') assert.equal(thread.appliedModel, true);
      else assert.equal(thread.model, model);
      for (const effort of ['low', 'high']) {
        const reply = await pool.runTurn('test', { text: 'Reply with exactly MODEL_OK. Do not use tools or change any files.', effort, timeoutMs: 60000 });
        assert.match(reply.text, /MODEL_OK/);
        if (id === 'dsh') assert.equal(thread.appliedEffort, effort);
        result.turns.push({ effort, text: reply.text });
      }
      report.push(result);
      console.log(id + ' model selection and low/high real replies passed');
    } finally { await pool.stop(); fs.writeFileSync(path.join(cwd, 'report.json'), JSON.stringify(report, null, 2)); }
  }
  console.log('Report: ' + path.join(cwd, 'report.json'));
})().catch(e => { console.error(e); process.exitCode = 1; });
