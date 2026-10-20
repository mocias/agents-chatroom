'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { samePath, nativeIds } = require('./desktop-state.cjs');
const { replaceFile } = require('./native-files.cjs');
const run = promisify(execFile);
const codexHome = launch => path.resolve(launch?.env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
function mergeRegistration(state, jobs, home) {
  const next = structuredClone(state);
  for (const key of ['local-projects', 'thread-project-assignments', 'app-server-project-id-by-legacy-project-id-by-host']) {
    if (next[key] !== undefined && (!next[key] || Array.isArray(next[key]) || typeof next[key] !== 'object')) throw Error('不兼容的 Codex 桌面登记格式');
    next[key] ||= {};
  }
  if (next['project-order'] !== undefined && !Array.isArray(next['project-order'])) throw Error('不兼容的 Codex 项目顺序格式');
  next['project-order'] ||= [];
  const hosts = next['app-server-project-id-by-legacy-project-id-by-host'];
  const host = Object.keys(hosts).find(k => k.startsWith('local:') && samePath(k.slice(6), home)) || 'local:' + home;
  const mapping = hosts[host] ||= {};
  for (const job of jobs) {
    const projects = next['local-projects'];
    const match = Object.entries(projects).find(([, p]) => p.rootPaths?.some(r => samePath(r, job.workspace)));
    const id = match?.[0] || job.projectId;
    if (mapping[id] && mapping[id] !== job.projectId) throw Error('Codex 项目映射已变化，需要重新核对后端项目');
    if (!match && projects[id]) throw Error('Codex 项目 ID 已被其他目录使用');
    projects[id] ||= { id, name: job.label, rootPaths: [job.workspace], createdAt: job.createdAt, updatedAt: job.createdAt };
    if (!next['project-order'].includes(id)) next['project-order'].push(id);
    mapping[id] = job.projectId;
    for (const threadId of job.threadIds) {
      const old = next['thread-project-assignments'][threadId];
      // An explicit user move made after enqueue wins over stale pending work.
      if (old && (old.projectKind !== 'local' || ![id, job.projectId, ...job.previousProjectIds].includes(old.projectId))) continue;
      next['thread-project-assignments'][threadId] = { projectKind: 'local', projectId: id };
    }
  }
  return next;
}
async function desktopRunning() {
  // Conservative: either ChatGPT or Codex desktop blocks writes. A failed
  // process query is an error, never evidence that the application is closed.
  if (process.platform !== 'win32') throw Error('退出后自动登记目前只支持 Windows');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'ChatGPT' -or $_.Path -match 'WindowsApps|resources|OpenAI' }).Count"],
  { windowsHide: true, timeout: 10000 });
  if (!/^\d+$/.test(stdout.trim())) throw Error('无法确认 Codex 桌面是否已退出');
  return Number(stdout.trim()) > 0;
}
function queueFile(dataDir) { return path.join(dataDir, 'desktop-sync', 'codex-pending.json'); }
function enqueue(dataDir, agent, projectId, launch, conversations = [], unmatched = []) {
  const file = queueFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const queue = original ? JSON.parse(original) : { version: 1, jobs: [] };
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的 Codex 登记队列');
  const prior = queue.jobs.find(j => j.agentId === agent.id);
  const job = { agentId: agent.id, label: agent.label, workspace: agent.workspace, projectId, home: codexHome(launch),
    createdAt: prior?.createdAt || Date.now(), previousProjectIds: [agent.desktopSync?.projectId, agent.desktopSync?.desktopProjectId].filter(Boolean),
    threadIds: nativeIds(agent, conversations).filter(id => !unmatched.includes(id)) };
  queue.jobs = [...queue.jobs.filter(j => j.agentId !== agent.id), job];
  replaceFile(file, original, JSON.stringify(queue, null, 2) + '\n');
}
async function flush(dataDir, options = {}) {
  const file = queueFile(dataDir);
  if (!fs.existsSync(file)) return { status: 'idle' };
  const original = fs.readFileSync(file, 'utf8'), queue = JSON.parse(original);
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw Error('不兼容的 Codex 登记队列');
  if (!queue.jobs.length) return { status: 'idle' };
  const running = options.running || desktopRunning;
  if (await running()) return { status: 'waiting-for-exit' };
  // Re-read the catalog so deleted agents or changed directories never get
  // resurrected by a persisted job from a previous application run.
  const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8'));
  const jobs = queue.jobs.filter(j => catalog.agents.some(a => a.id === j.agentId && a.backend === 'codex' && samePath(a.workspace, j.workspace)));
  for (const home of new Set(jobs.map(j => j.home))) {
    const target = path.join(home, '.codex-global-state.json');
    // Do not initialize an unused profile or replace a corrupt state file.
    const raw = fs.readFileSync(target, 'utf8');
    const next = mergeRegistration(JSON.parse(raw), jobs.filter(j => j.home === home), home);
    if (await running()) return { status: 'waiting-for-exit' };
    if (fs.readFileSync(file, 'utf8') !== original) return { status: 'retry' };
    if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(next)) replaceFile(target, raw, JSON.stringify(next) + '\n');
  }
  replaceFile(file, original, JSON.stringify({ version: 1, jobs: [] }, null, 2) + '\n');
  return { status: 'registered', count: jobs.length };
}
module.exports = { codexHome, mergeRegistration, desktopRunning, enqueue, flush };
