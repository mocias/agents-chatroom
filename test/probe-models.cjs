'use strict';
// Probe: which models actually complete a turn, and what does an error look like?
const { CodexThreadPool } = require('../lib/codex-pool.cjs');

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-sol', 'gpt-6-luna'];

async function main() {
  const pool = new CodexThreadPool({ cwd: process.cwd(), log: () => {} });
  await pool.start();
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      await pool.openThread('m-' + model, { model, sandbox: 'read-only', approvalPolicy: 'never' });
      const result = await pool.runTurn('m-' + model, {
        text: 'Reply with exactly: OK',
        effort: 'none',
        onItem: (item) => {
          if (item.type === 'error') console.log('   item.error: ' + item.message);
        },
      });
      console.log(
        `${model.padEnd(16)} OK ${((Date.now() - t0) / 1000).toFixed(1)}s status=${result.status} text=${JSON.stringify(
          (result.text || '').slice(0, 80),
        )} usage=${JSON.stringify(result.usage)}`,
      );
    } catch (error) {
      console.log(`${model.padEnd(16)} FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s ${error.message.slice(0, 300)}`);
    }
  }
  await pool.stop();
  process.exit(0);
}

main().catch((error) => {
  console.error('FATAL ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
