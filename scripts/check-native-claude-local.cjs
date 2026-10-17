'use strict';
// The REAL installed Code executable talks only to a LOCAL fake gateway.
// No user API configuration, credentials or real model requests are used.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { claudeCodeLaunch } = require('../lib/harnesses.cjs');
const { AcpPool } = require('../lib/acp-backend.cjs');
(async () => {
  const root = fs.mkdtempSync(path.resolve('output/claude-local-gateway-'));
  const requests = [], report = { root, localFakeGateway: true, realModelRequests: 0, passed: false };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body = {}; try { body = JSON.parse(raw); } catch {}
    requests.push({ method: req.method, url: req.url, model: body.model, maxTokens: body.max_tokens,
      userPrompt: JSON.stringify(body.messages || []).includes('LOCAL_CLAUDE_OK'), stage: report.stage });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'claude-haiku-4-5-20251001', type: 'model', display_name: 'Haiku' }], has_more: false }));
    if (req.url.includes('count_tokens')) return res.end(JSON.stringify({ input_tokens: 12 }));
    if (!req.url.startsWith('/v1/messages')) { res.statusCode = 404; return res.end('{}'); }
    if (!/haiku/.test(body.model)) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Local fixture rejects startup model: ' + body.model } }));
    }
    const message = { id: 'msg_local', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'LOCAL_CLAUDE_OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 6 } };
    if (!body.stream) return res.end(JSON.stringify(message));
    res.setHeader('Content-Type', 'text/event-stream');
    for (const frame of [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL_CLAUDE_OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ]) res.write('event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n');
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const launch = claudeCodeLaunch(process.argv[2]);
  const lib = path.join(root, 'configLibrary'), cacheDir = path.join(root, 'model-catalog');
  fs.mkdirSync(lib); fs.mkdirSync(cacheDir);
  const profileId = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(lib, '_meta.json'), JSON.stringify({ appliedId: profileId }));
  fs.writeFileSync(path.join(lib, profileId + '.json'), JSON.stringify({ inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: 'http://127.0.0.1:' + server.address().port,
    inferenceGatewayApiKey: 'LOCAL_FAKE_KEY_ONLY', inferenceGatewayAuthScheme: 'bearer' }));
  const doc = { surfaces: { ccd: { model_selector_config: [{ models: [
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku concrete', offered_on: ['gateway'] },
    { id: 'claude-opus-4-8', name: 'Opus concrete', offered_on: ['gateway'] },
  ], provider_alias_targets: {
    haiku: { default: 'claude-haiku-4-5-20251001' }, sonnet: { default: 'claude-sonnet-4-6' },
  } }] } } };
  fs.writeFileSync(path.join(cacheDir, 'published.json'), JSON.stringify({ documentBytes: Buffer.from(JSON.stringify(doc)).toString('base64') }));
  const native = JSON.parse(launch.agentArgs[1]); native.desktopDataDir = root; launch.agentArgs[1] = JSON.stringify(native);
  const pool = new AcpPool({ ...launch, cwd: root, env: { ...launch.env,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    ANTHROPIC_API_KEY: 'LOCAL_FAKE_KEY_ONLY', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64', MAX_THINKING_TOKENS: '0',
  } });
  try {
    report.stage = 'openThread';
    await pool.openThread('local', { cwd: root, model: 'claude-haiku-4-5-20251001', strictModel: true });
    assert.ok((await pool.listModels()).some(m => m.id === 'claude-opus-4-8'));
    report.stage = 'prompt';
    const reply = await pool.runTurn('local', { text: 'Reply LOCAL_CLAUDE_OK', timeoutMs: 15000 });
    assert.equal(reply.text.trim(), 'LOCAL_CLAUDE_OK');
    assert.ok(requests.length > 0 && requests.every(r => r.model === 'claude-haiku-4-5-20251001' && r.maxTokens <= 64));
    report.passed = true;
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    await pool.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    report.requests = requests; fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
