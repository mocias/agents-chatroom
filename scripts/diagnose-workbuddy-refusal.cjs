'use strict';
// One isolated runtime and one short prompt. Persist only allowlisted diagnostics.
const fs = require('node:fs');
const path = require('node:path');
const { adapt } = require('../standalone/discovery.cjs');
const { WorkbuddyConnection } = require('../lib/workbuddy-pool.cjs');
const { publicError } = require('../standalone/claude-acp.cjs');

(async () => {
  const executable = process.argv[2];
  const model = process.argv[3] || 'deepseek-v4.1-flash';
  if (!executable) throw new Error('Pass the selected WorkBuddy AI executable');
  const output = fs.mkdtempSync(path.resolve('output/workbuddy-diagnosis-'));
  const launch = adapt('workbuddy-ai', executable).launch;
  const pool = new WorkbuddyConnection({ ...launch, cwd: output });
  const report = { testedAt: new Date().toISOString(), model, output, promptRequests: 0, sessionsCreated: 0 };
  const request = pool.request.bind(pool);
  pool.request = async (method, params, options) => {
    if (method === 'session/new') report.sessionsCreated++;
    if (method === 'session/prompt') report.promptRequests++;
    const result = await request(method, params, options);
    if (method === 'session/set_config_option') {
      report.appliedModel = result.configOptions?.find(o => o.category === 'model')?.currentValue;
    }
    if (method === 'session/prompt') {
      report.stopReason = result.stopReason;
      const raw = result.errorMessage ?? result._meta?.['codebuddy.ai/errorMessage'] ?? result._meta?.errorMessage;
      let error = raw;
      if (typeof raw === 'string') { try { error = JSON.parse(raw); } catch {} }
      report.providerError = typeof error === 'string' ? { message: publicError(error) } : error && {
        rpcCode: error.code, message: publicError(error.message),
        httpStatus: error.data?.statusCode, businessCode: error.data?.code,
        category: error.data?.category, subcategory: error.data?.subcategory,
        retryPolicy: error.data?.retryPolicy,
        detailKeys: Object.keys(error.data || {}),
      };
    }
    return result;
  };
  const timeout = setTimeout(() => { void pool.stop(); }, 60000);
  try {
    await pool.start();
    report.runtimeReady = true;
    await pool.openThread('probe', { cwd: output, model, strictModel: true, sandbox: 'read-only' });
    const result = await pool.runTurn('probe', {
      text: 'Reply with exactly WORKBUDDY_LOCAL_OK. Do not use tools or change files.', timeoutMs: 45000,
    });
    report.reply = result.text; report.status = result.status;
    report.passed = result.status === 'end_turn' && result.text.trim() === 'WORKBUDDY_LOCAL_OK';
  } catch (error) {
    report.passed = false; report.error = publicError(error);
  } finally {
    clearTimeout(timeout); await pool.stop();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(publicError(error)); process.exitCode = 1; });
