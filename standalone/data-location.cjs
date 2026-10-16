'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function validatePath(value, current) {
  if (typeof value !== 'string' || !path.isAbsolute(value.trim())) throw new Error('请填写文件夹的完整绝对路径');
  const target = path.resolve(value.trim());
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())) throw new Error('请选择普通文件夹');
  const relative = path.relative(current, target);
  const reverse = path.relative(target, current);
  const nested = r => r && !r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r);
  if (nested(relative) || nested(reverse)) throw new Error('新旧数据目录不能相互包含');
  return target;
}
function validateCopy(source, target) {
  const catalog = JSON.parse(fs.readFileSync(path.join(target, 'catalog.json'), 'utf8'));
  if (!Array.isArray(catalog.agents) || !Array.isArray(catalog.conversations)) throw new Error('新目录的 catalog.json 无效');
  if (!fs.existsSync(path.join(target, 'rooms'))) throw new Error('新目录缺少 rooms 文件夹');
  if (!fs.existsSync(source)) return;
  const walk = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(relative, entry.name); const from = path.join(source, rel); const to = path.join(target, rel);
      if (entry.isSymbolicLink()) throw new Error('数据目录含链接，请先改为普通文件夹：' + rel);
      if (entry.isDirectory()) { if (!fs.existsSync(to) || !fs.statSync(to).isDirectory()) throw new Error('尚未复制文件夹：' + rel); walk(from, rel); }
      else if (entry.isFile()) {
        if (!fs.existsSync(to) || !fs.statSync(to).isFile()) throw new Error('尚未复制文件：' + rel);
        const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        if (hash(from) !== hash(to)) throw new Error('文件与旧目录不一致，请关闭应用后重新复制：' + rel);
      }
    }
  };
  walk(source);
}
function createDataLocation(defaultDir, configFile) {
  let config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  let current = path.resolve(config.current || defaultDir); let warning = null;
  const persist = () => { fs.mkdirSync(path.dirname(configFile), { recursive: true }); const tmp = configFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(config, null, 2)); fs.renameSync(tmp, configFile); };
  if (config.pending) {
    try { const target = validatePath(config.pending, current); validateCopy(current, target); config = { current: target }; persist(); current = target; }
    catch (e) { warning = '新数据目录尚未就绪，仍使用原目录：' + e.message; }
  }
  return {
    current,
    status: () => ({ current, pending: config.pending || null, warning }),
    schedule(value) { const target = validatePath(value, current); config = { current, ...(target !== current ? { pending: target } : {}) }; persist(); warning = null; return this.status(); },
    cancel() { config = { current }; persist(); warning = null; return this.status(); },
  };
}
module.exports = { createDataLocation, validateCopy };
