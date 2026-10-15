'use strict';
// Empirical effort probe: model/list lies about `none` (it is absent from every
// entry yet accepted by some models), so measure acceptance directly.
const { CodexThreadPool } = require('../lib/codex-pool.cjs');

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const EFFORTS = ['none', 'low'];

async function main() {
  const pool = new CodexThreadPool({ cwd: process.cwd(), log: () => {} });
  await pool.start();
  for (const model of MODELS) {
    const row = [];
    for (const effort of EFFORTS) {
      const key = `${model}|${effort}`;
      await pool.openThread(key, { model, sandbox: 'read-only', approvalPolicy: 'never' });
      const t0 = Date.now();
      try {
        const result = await pool.runTurn(key, { text: 'Reply with exactly: OK', effort });
        row.push(`${effort}=OK(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (error) {
        const message = error.message || '';
        const marker = /unsupported/i.test(message) ? 'REJECTED' : 'FAIL:' + message.slice(0, 60);
        row.push(`${effort}=${marker}`);
      }
      pool.closeThread(key);
    }
    console.log(model.padEnd(15) + row.join('  '));
  }
  await pool.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
