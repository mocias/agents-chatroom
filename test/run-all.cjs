#!/usr/bin/env node
/**
 * Runs every offline test in one go and prints a single pass/fail table.
 *
 * Deliberately serial: several of these spawn real agent processes (the ACP
 * fixture) and assert on timing, so running them in parallel would make
 * failures ambiguous.
 *
 * NOTHING here may touch codex. Every test that spawns codex spends the
 * owner's real ChatGPT quota, so those are opt-in via `--online` and are
 * never part of a default run. The offline half must stay codex-free: the
 * ACP fixture is a local script, so `acp-*` tests are free to run always.
 *
 * Run:  node test/run-all.cjs [--online]
 */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// Codex-free. Safe to run any number of times.
const OFFLINE = [
  'encoding.cjs',
  'no-addendum.cjs',
  'silent-turn.cjs',
  'client-bundle-smoke.cjs',
  'realtime-overhear.cjs',
  'prewarm.cjs',
  'thread-reuse.cjs',
  'backend-death.cjs',
  'member-management.cjs',
  'member-api.cjs',
  'room-lifecycle.cjs',
  'room-registry.cjs',
  'session-filing.cjs',
  'segments.cjs',
  'steer.cjs',
  'host-entry.cjs',
  'ui-members.cjs',
  'ui-attachments.cjs',
  'theme-store.cjs',
  'theme-row.cjs',
  'attachments.cjs',
  'codex-input.cjs',
  'acp-backend-smoke.cjs',
  'acp-room.cjs',
];

// Spawns a real codex (or talks to the live DSH): every one of these spends
// quota. `engine-smoke.cjs` used to sit in OFFLINE and silently burned two
// codex threads on every default run — that was a mistake, it belongs here.
const ONLINE = [
  'engine-smoke.cjs',
  'http-smoke.cjs',
  'e2e-dsh.cjs',
  'e2e-prewarm.cjs',
  'probe-boot.cjs',
];

const online = process.argv.includes('--online');
const files = online ? OFFLINE.concat(ONLINE) : OFFLINE;

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => {
      resolve({ file, code, ms: Date.now() - started, out, err });
    });
  });
}

async function main() {
  const results = [];
  for (const file of files) {
    const result = await run(file);
    // Some tests print `problems: none`, some align it as `problems  : none`,
    // and the ACP smoke test counts assertions (`NN/NN checks passed`) instead.
    // The exit code is the authority; the summary line is only here to be readable.
    const problems = /^problems\s*:\s*(.*)$/m.exec(result.out);
    const passed = /^(\d+)\/(\d+) checks passed\s*$/m.exec(result.out);
    const summary = problems ? problems[1].trim() : passed ? `${passed[1]}/${passed[2]} checks` : 'ok (exit 0)';
    const ok = result.code === 0 && (!problems || summary === 'none');
    results.push({ ...result, ok, summary });
    process.stdout.write(
      `${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(26)} ${String(result.ms).padStart(6)}ms  ${summary}\n`,
    );
    if (!ok) {
      if (result.err.trim()) process.stdout.write('      stderr: ' + result.err.trim().split('\n').slice(0, 6).join('\n      ') + '\n');
      if (result.out.trim()) {
        const tail = result.out.trim().split('\n').slice(-8);
        process.stdout.write('      stdout: ' + tail.join('\n      ') + '\n');
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed in ${(total / 1000).toFixed(1)}s`);
  process.stdout.write(online ? ' (including online tests)\n' : ' (offline; add --online for codex/DSH tests)\n');
  if (failed.length) process.stdout.write('failed: ' + failed.map((r) => r.file).join(', ') + '\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
