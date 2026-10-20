'use strict';
// Register configured agents: may install the bundled DSH bridge, reconcile
// Codex metadata, and enqueue offline desktop registration. --save additionally
// updates Room's status cache. This is NOT a read-only audit command.
const fs = require('node:fs');
const path = require('node:path');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const { registerAgent } = require('../standalone/desktop-sync.cjs');
(async () => {
  const dataDir = path.resolve(process.argv[2]);
  await require('../standalone/registration-dispatcher.cjs').stopLegacyWorker(dataDir);
  const file = path.join(dataDir, 'catalog.json');
  const original = fs.readFileSync(file, 'utf8');
  const catalog = JSON.parse(original);
  const discovery = new BackendDiscovery({ dir: dataDir, allowAuto: true });
  const backends = await discovery.scan();
  const report = [];
  for (const agent of catalog.agents) {
    if (!['dsh', 'codex', 'qoder', 'workbuddy-ai', 'workbuddy', 'claude'].includes(agent.backend)) continue;
    agent.desktopSync = await registerAgent(agent, backends.find(row => row.id === agent.backend)?.selected?.launch, { dataDir, conversations: catalog.conversations });
    report.push({ agent: agent.label, backend: agent.backend, workspace: agent.workspace, ...agent.desktopSync });
  }
  if (process.argv.includes('--save')) {
    if (fs.readFileSync(file, 'utf8') !== original) throw Error('Catalog changed during verification; retry after closing Agent Room');
    fs.copyFileSync(file, file + '.before-desktop-sync-' + Date.now());
    fs.writeFileSync(file + '.tmp', JSON.stringify(catalog, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
  }
  await require('../standalone/registration-worker.cjs').flushAll(dataDir);
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
