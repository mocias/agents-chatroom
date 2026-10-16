'use strict';
const { spawn } = require('node:child_process');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const path = require('node:path');
(async () => {
  const row = (await new BackendDiscovery({ dir: path.resolve('.agent-room-data') }).scan()).find(r => r.id === 'qoder');
  if (!row?.selected || row.selected.kind !== '桌面后端') throw new Error('未找到可用 Qoder 桌面 Worker');
  const launch = row.selected.launch;
  const child = spawn(launch.agentCommand, [...launch.agentArgs, 'login'], { env: { ...process.env, ...launch.env }, stdio: 'inherit', windowsHide: true });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
})().catch(e => { console.error(e.message); process.exitCode = 1; });
