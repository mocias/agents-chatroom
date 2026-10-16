'use strict';
const fs = require('node:fs');
const path = require('node:path');
function folderName(label) {
  let name = label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80).replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = 'Agent';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function chooseWorkspace(workspaceRoot, backend, label, input) {
  if (typeof input === 'string' && input.trim()) {
    const value = input.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(value)) throw new Error('工作区必须是完整绝对路径');
    let actual;
    try { actual = fs.realpathSync(value); if (!fs.statSync(actual).isDirectory()) throw new Error(); }
    catch { throw new Error('工作区文件夹不存在，请选择已有文件夹'); }
    return actual;
  }
  const root = path.join(workspaceRoot, backend);
  try { fs.mkdirSync(root, { recursive: true }); }
  catch (error) { throw new Error('默认工作区无法创建，请选择可写文件夹：' + root + '（' + error.code + '）'); }
  const base = folderName(label);
  for (let i = 1; i < 10000; i++) {
    const target = path.join(root, base + (i === 1 ? '' : '-' + i));
    try { fs.mkdirSync(target); return target; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名工作区过多，请手动选择文件夹');
}
function assertDeletable(target, { protectedPaths = [], otherWorkspaces = [] } = {}) {
  const resolved = path.resolve(target);
  const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
  const canonical = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (resolved === path.parse(resolved).root) throw new Error('不能删除磁盘根目录');
  const real = canonical(resolved);
  if ([...protectedPaths, ...otherWorkspaces].some(p => inside(real, canonical(p)) || otherWorkspaces.includes(p) && inside(canonical(p), real))) throw new Error('该目录包含应用数据、系统目录或与其他 Agent 共用，不能删除');
  function check(dir) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error('目录包含符号链接或目录联接，请保留工作区并手动处理');
    if (stat.isDirectory()) for (const name of fs.readdirSync(dir)) check(path.join(dir, name));
  }
  if (fs.existsSync(resolved)) check(resolved);
  return resolved;
}
module.exports = { folderName, chooseWorkspace, assertDeletable };
