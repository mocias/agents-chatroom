'use strict';
const fs = require('node:fs');
const path = require('node:path');
function folderName(label) {
  let name = label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80).replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = 'Agent';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
function chooseWorkspace(dataDir, backend, label, input) {
  if (typeof input === 'string' && input.trim()) {
    const value = input.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(value)) throw new Error('工作区必须是完整绝对路径');
    let actual;
    try { actual = fs.realpathSync(value); if (!fs.statSync(actual).isDirectory()) throw new Error(); }
    catch { throw new Error('工作区文件夹不存在，请选择已有文件夹'); }
    return actual;
  }
  const root = path.join(dataDir, 'workspaces', backend);
  fs.mkdirSync(root, { recursive: true });
  const base = folderName(label);
  for (let i = 1; i < 10000; i++) {
    const target = path.join(root, base + (i === 1 ? '' : '-' + i));
    try { fs.mkdirSync(target); return target; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名工作区过多，请手动选择文件夹');
}
module.exports = { folderName, chooseWorkspace };
