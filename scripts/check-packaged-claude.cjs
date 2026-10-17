'use strict';
// Validate the shipped ASAR bridge, with and without a system Node on PATH.
// Uses only the deterministic protocol fixture, never a real Claude account.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

(async () => {
  if (process.argv[2] === '--child') {
    const [, , , archive, fixture, cwd] = process.argv;
    const { claudeCodeLaunch } = require(path.join(archive, 'lib/harnesses.cjs'));
    if (process.env.CLAUDE_DESKTOP_CHECK_PATH) {
      const desktop = claudeCodeLaunch(process.env.CLAUDE_DESKTOP_CHECK_PATH);
      assert.equal(desktop.claudeDesktop, true);
      assert.ok(JSON.parse(desktop.agentArgs[1]).desktopDataDir);
    }
    const { AcpPool } = require(path.join(archive, 'lib/acp-backend.cjs'));
    const pool = new AcpPool({ ...claudeCodeLaunch(fixture), cwd });
    try {
      await pool.openThread('packed', { cwd, model: 'opus-test', strictModel: true, developerInstructions: 'PERSONA_FIXTURE' });
      const reply = JSON.parse((await pool.runTurn('packed', { text: 'packaged check' })).text);
      assert.equal(reply.model, 'opus-test'); assert.equal(reply.hasPersona, true); assert.equal(reply.cwd, cwd);
      console.log(JSON.stringify({ passed: true, version: require(path.join(archive, 'package.json')).version, reply }));
    } finally { await pool.stop(); }
    return;
  }
  const home = fs.mkdtempSync(path.resolve('output/claude-packaged-'));
  const exe = path.resolve('dist/win-unpacked/Agent Room.exe');
  const archive = path.resolve('dist/win-unpacked/resources/app.asar');
  const fixture = path.resolve('checks/fixtures/claude-stream-fixture.cjs');
  const report = { home, fixtureOnly: true, checks: [] };
  for (const noNode of [false, true]) {
    const cwd = path.join(home, noNode ? '无系统 Node 工作区' : '有系统 Node 工作区'); fs.mkdirSync(cwd);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    if (noNode) {
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
      env.Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    }
    const { stdout } = await promisify(execFile)(exe, [__filename, '--child', archive, fixture, cwd], {
      env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    });
    report.checks.push({ noSystemNode: noNode, ...JSON.parse(stdout.trim()) });
  }
  report.passed = report.checks.every(row => row.passed);
  fs.writeFileSync(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
