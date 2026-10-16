'use strict';
// Usage: node scripts/check-live-workbuddy.cjs workbuddy=C:/.../WorkBuddy.exe
//        workbuddy-ai=C:/.../WorkBuddyAI.exe [--chat]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { adapt } = require('../standalone/discovery.cjs');
const { isWorkbuddy } = require('../standalone/workbuddy.cjs');
const { WorkbuddyPool } = require('../lib/workbuddy-pool.cjs');
(async () => {
  const cwd = fs.mkdtempSync(path.resolve('output/workbuddy-live-'));
  const report = { cwd, modelRequestsSent: process.argv.includes('--chat'), editions: [] };
  for (const arg of process.argv.slice(2).filter(a => a.includes('='))) {
    const eq = arg.indexOf('='), id = arg.slice(0, eq), exe = arg.slice(eq + 1);
    assert.ok(isWorkbuddy(id), 'unknown edition: ' + id);
    const launch = adapt(id, exe, 'live check').launch;
    const pool = new WorkbuddyPool({ ...launch, cwd });
    const timer = setTimeout(() => { void pool.stop(); }, 60000);
    const row = { id, exe }; report.editions.push(row);
    try {
      await pool.start(); row.initialize = true; row.protocolVersion = pool.info.protocolVersion;
      row.authMethods = pool.info.authMethods.map(m => ({ id: m.id, name: m.name }));
      const one = await pool.openThread('one', { cwd, sandbox: 'read-only' });
      const two = await pool.openThread('two', { cwd, sandbox: 'read-only' });
      assert.notEqual(one.id, two.id); row.independentSessions = true;
      row.models = await pool.listModels();
      if (process.argv.includes('--chat')) {
        const result = await pool.runTurn('one', { text: 'Reply with exactly WORKBUDDY_LOCAL_OK. Do not use tools or change files.', timeoutMs: 45000 });
        row.reply = result.text; row.status = result.status;
        assert.equal(result.status, 'end_turn'); assert.match(result.text, /WORKBUDDY_LOCAL_OK/);
      }
    } catch (error) { row.error = error.message; process.exitCode = 1; }
    finally { clearTimeout(timer); await pool.stop(); }
  }
  assert.ok(report.editions.length, 'Pass workbuddy=<exe> and/or workbuddy-ai=<exe>');
  fs.writeFileSync(path.join(cwd, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
