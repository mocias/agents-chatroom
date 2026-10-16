'use strict';
// Qoder desktop bundles an ACP-capable worker, not a standalone CLI executable.
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const entry = process.argv[2];
if (!entry || !path.isAbsolute(entry)) throw new Error('Missing Qoder worker runtime');
const worker = new Worker(entry, {
  argv: process.argv[3] === 'login' ? ['login'] : ['--acp'], stdin: true, stdout: true, stderr: true,
  env: { ...process.env, QODER_WORKER_CWD: process.cwd() },
  workerData: { qoderWorkerRuntime: { cwd: process.cwd(), runtimeRoot: path.dirname(entry), materialized: false } },
});
process.stdin.pipe(worker.stdin);
worker.stdout.pipe(process.stdout);
worker.stderr.pipe(process.stderr);
worker.on('error', error => { console.error(error.message); process.exitCode = 1; });
worker.on('exit', code => { process.exitCode = code; process.stdin.destroy(); });
let closing = false;
const close = () => { if (!closing) { closing = true; void worker.terminate(); } };
if (process.argv[3] !== 'login') process.stdin.on('end', close);
process.on('SIGINT', close);
process.on('SIGTERM', close);
