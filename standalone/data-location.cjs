'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MARKER = '.agent-room-migration.json';
function ensureDirectory(dir) {
  // mkdirSync('D:\\', { recursive: true }) can return EPERM on Windows even
  // when the drive exists and its child directories are writable.
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.statSync(dir).isDirectory()) throw new Error('父路径不是文件夹：' + dir);
}
const hash = file => {
  const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count)); return digest.digest('hex'); }
  finally { fs.closeSync(fd); }
};
const inside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
function canonical(value) {
  if (fs.existsSync(value)) return fs.realpathSync(value);
  const parent = path.dirname(value);
  return parent === value ? value : path.join(canonical(parent), path.basename(value));
}
function validatePath(value, current, options = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value.trim())) throw new Error('请填写文件夹的完整绝对路径');
  const target = path.resolve(value.trim());
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())) throw new Error('请选择普通文件夹');
  const a = canonical(current), b = canonical(target);
  if (a !== b && (inside(a, b) || inside(b, a))) throw new Error('新旧数据目录不能相互包含');
  if (options.installDir) {
    const root = canonical(options.installDir);
    if (b === root || inside(path.join(root, 'resources'), b) || inside(path.join(root, 'locales'), b)) throw new Error('请选择独立数据文件夹，不能使用程序根目录、resources 或 locales');
  }
  return target;
}
function tree(dir) {
  const entries = [];
  const walk = (root, relative = '') => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!relative && entry.name === MARKER) continue;
      const rel = path.join(relative, entry.name), full = path.join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error('数据目录包含链接，无法自动迁移：' + rel);
      if (entry.isDirectory()) { entries.push([rel, 'directory']); walk(full, rel); }
      else if (entry.isFile()) entries.push([rel, hash(full)]);
      else throw new Error('不支持的数据文件类型：' + rel);
    }
  };
  walk(dir);
  return JSON.stringify(entries.sort((a,b) => a[0].localeCompare(b[0])));
}
function validateCopy(source, target) {
  const catalog = JSON.parse(fs.readFileSync(path.join(target, 'catalog.json'), 'utf8'));
  if (!Array.isArray(catalog.agents) || !Array.isArray(catalog.conversations)) throw new Error('新目录的 catalog.json 无效');
  if (!fs.statSync(path.join(target, 'rooms')).isDirectory()) throw new Error('新目录缺少 rooms 文件夹');
  if (fs.existsSync(source) && tree(source) !== tree(target)) throw new Error('目标已有不同内容，请选择空文件夹；不会覆盖已有数据');
}
function copyTree(source, target, root = true) {
  ensureDirectory(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (root && entry.name === MARKER) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to, false);
    else if (entry.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else throw new Error('不支持的数据文件类型：' + from);
  }
}
function migrate(source, target) {
  if (canonical(source) === canonical(target)) return;
  const sourceTree = tree(source);
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    const markerFile = path.join(target, MARKER);
    if (fs.existsSync(markerFile)) {
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (marker.source === source && marker.sourceTree === sourceTree && marker.targetTree === tree(target)) return;
    }
    validateCopy(source, target); // Compatible with an already completed manual copy.
    remapCatalog(source, target, target);
    fs.writeFileSync(path.join(target, MARKER), JSON.stringify({ source, sourceTree, targetTree: tree(target) }));
    return;
  }
  ensureDirectory(path.dirname(target));
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.agent-room-migration-'));
  // The source is never moved/deleted. Failed staging copies are retained for inspection.
  copyTree(source, stage);
  validateCopy(source, stage);
  remapCatalog(source, target, stage);
  if (tree(source) !== sourceTree) throw new Error('迁移期间源数据发生变化，已保留原目录，请重试');
  fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ source, sourceTree, targetTree: tree(stage) }));
  if (fs.existsSync(target)) fs.rmdirSync(target); // Empty only; never recursive.
  fs.renameSync(stage, target);
}
function remapCatalog(source, target, stage) {
  const file = path.join(stage, 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const agent of catalog.agents) if (agent.workspace && inside(source, path.resolve(agent.workspace))) agent.workspace = path.join(target, path.relative(source, agent.workspace));
  for (const conversation of catalog.conversations) delete conversation.nativeSessions;
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2));
}
function createDataLocation(defaultDir, configFile, options = {}) {
  let config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  let current = path.resolve(config.current || defaultDir), warning = null;
  const persist = next => { ensureDirectory(path.dirname(configFile)); const tmp = configFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, configFile); config = next; };
  if (config.pending) {
    try { const target = validatePath(config.pending, current, options); migrate(current, target); persist({ current: target }); current = target; }
    catch (error) { warning = '自动迁移未完成，仍使用原目录：' + error.message; }
  }
  return { current, status: () => ({ current, pending: config.pending || null, warning, automatic: true }),
    schedule(value) {
      const target = validatePath(value, current, options);
      if (target !== current && fs.existsSync(target) && fs.readdirSync(target).length) validateCopy(current, target);
      persist({ current, ...(target !== current ? { pending: target } : {}) }); warning = null; return this.status();
    },
    cancel() { persist({ current }); warning = null; return this.status(); }
  };
}
module.exports = { createDataLocation, validateCopy, migrate, validatePath };
