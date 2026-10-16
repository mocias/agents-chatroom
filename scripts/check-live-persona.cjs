'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
(async () => {
  const cwd = fs.mkdtempSync(path.resolve('output/persona-live-'));
  const rows = await new BackendDiscovery({ dir: cwd }).scan();
  const report = [];
  for (const backend of ['dsh', 'qoder']) {
    const pool = new AcpPool({ ...rows.find(r => r.id === backend).selected.launch, cwd });
    try {
      await pool.start();
      const marker = backend.toUpperCase() + '_PERSONA_OK';
      await pool.openThread('a', { cwd, developerInstructions: 'Your identity code is ' + marker + '. When asked for your identity code, reply with that code only. Do not use tools.' });
      const reply = await pool.runTurn('a', { text: 'What is your identity code? Reply with the code only.', timeoutMs: 60000 });
      assert.equal(reply.text.trim(), marker);
      report.push({ backend, reply: reply.text, ok: true });
    } finally { await pool.stop(); fs.writeFileSync(path.join(cwd, 'report.json'), JSON.stringify(report, null, 2)); }
  }
  console.log(JSON.stringify({ cwd, report }));
})().catch(e => { console.error(e); process.exitCode = 1; });
