'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Runs inside the DSH host. Only the native registry owns its persistent rows.
async function syncDshCatalog(registry, catalog) {
  if (!registry || typeof registry.create !== 'function') throw new Error('DSH workspaceRegistry 尚未就绪');
  const results = [];
  for (const agent of catalog.agents || []) {
    if (agent.backend !== 'dsh') continue;
    const result = { agentId: agent.id, workspace: agent.workspace, sessions: [], errors: [] };
    try {
      if (!path.isAbsolute(agent.workspace) || !fs.statSync(agent.workspace).isDirectory()) throw new Error('工作区目录不存在');
      const workspace = await registry.create(agent.workspace, agent.label + ' (Agent Room)');
      result.workspaceId = workspace.id;
      const ids = new Set((catalog.conversations || []).map(c => c.nativeSessions?.[agent.id])
        .filter(s => s?.backend === 'dsh').map(s => s.id));
      for (const id of ids) {
        try { await workspace.attachSession(id); result.sessions.push(id); }
        catch (error) { result.errors.push({ sessionId: id, message: error.message }); }
      }
    } catch (error) { result.errors.push({ message: error.message }); }
    result.status = result.errors.length ? 'error' : 'registered';
    results.push(result);
  }
  return results;
}

function startDshCatalogSync(ctx, catalogFile, options = {}) {
  if (!catalogFile) return () => {};
  let disposed = false, pending = false, lastSuccess;
  const tick = async () => {
    if (disposed || pending) return;
    pending = true;
    try {
      const source = fs.readFileSync(catalogFile, 'utf8');
      if (source === lastSuccess) return;
      const agents = await syncDshCatalog(ctx.get('workspaceRegistry'), JSON.parse(source));
      const receipt = path.join(path.dirname(catalogFile), 'desktop-sync', 'dsh.json');
      fs.mkdirSync(path.dirname(receipt), { recursive: true });
      const tmp = receipt + '.' + require('node:crypto').randomUUID() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ checkedAt: new Date().toISOString(), ...(options.receiptSource ? { source: options.receiptSource } : {}), agents }, null, 2));
      fs.renameSync(tmp, receipt);
      if (agents.every(a => a.status === 'registered')) lastSuccess = source;
    } catch (error) { ctx.logger?.warn?.('Agent Room workspace sync: ' + error.message); }
    finally { pending = false; }
  };
  const timer = setInterval(() => void tick(), options.intervalMs || 15000);
  timer.unref?.();
  void tick();
  return () => { disposed = true; clearInterval(timer); };
}
module.exports = { syncDshCatalog, startDshCatalogSync };
