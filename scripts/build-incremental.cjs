'use strict';
// Fixed-size binary blocks keep Electron executable updates small, too.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const allowed = name => /^(Agent Room\.exe|Uninstall Agent Room\.exe|version|LICENSE[^/]*|[^/]+\.(dll|pak|bin|dat|json)|resources\/(app\.asar|default_app\.asar|elevate\.exe|app-update\.yml)|locales\/[^/]+\.pak)$/.test(name);
function build(base, next, out, fromVersion, toVersion) {
  if (!fromVersion || !toVersion || fromVersion === toVersion) throw new Error('Distinct base/target versions required');
  fs.mkdirSync(out, { recursive: true });
  const chunks = []; let offset = 0; const files = [];
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Links are not supported');
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), rel + '/'); continue; }
      if (!allowed(rel)) throw new Error('Unexpected packaged file: ' + rel);
      addFile(rel, path.join(next, rel));
    }
  }
  function addFile(rel, source) {
      const after = fs.readFileSync(source); const oldPath = path.join(base, rel);
      const before = fs.existsSync(oldPath) ? fs.readFileSync(oldPath) : null;
      const newHash = hash(after), oldHash = before ? hash(before) : null;
      if (newHash === oldHash) return;
      const blocks = [];
      for (let at = 0; at < after.length; at += 65536) {
        const block = after.subarray(at, at + 65536);
        if (before && block.equals(before.subarray(at, at + block.length))) continue;
        blocks.push({ offset: at, length: block.length, payloadOffset: offset });
        chunks.push(block); offset += block.length;
      }
      files.push({ path: rel, oldHash, newHash, length: after.length, blocks });
  }
  walk(next);
  const uninstaller = path.join(next, '..', `Agent-Room-Setup-${toVersion}-x64.__uninstaller.exe.incremental`);
  if (fs.existsSync(uninstaller)) addFile('Uninstall Agent Room.exe', uninstaller);
  const payload = Buffer.concat(chunks);
  fs.writeFileSync(path.join(out, 'payload.bin'), payload);
  const manifest = { format: 1, fromVersion, toVersion, payloadHash: hash(payload), files };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(__dirname, '../desktop/Apply-Update.ps1'), path.join(out, 'Apply-Update.ps1'));
  fs.writeFileSync(path.join(out, 'Update.cmd'), '@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Apply-Update.ps1" %*\r\npause\r\n');
  fs.writeFileSync(path.join(out, 'README.txt'), `Agent Room ${fromVersion} -> ${toVersion}\r\n解压到程序目录之外的文件夹，双击 Update.cmd，输入当前安装目录。\r\n程序关闭后替换差异文件；数据和工作区保留，不运行卸载程序。\r\n若旧版文件不匹配，将拒绝更新且不修改程序。请使用对应版本的增量包。\r\n`);
  return { manifest, payloadBytes: offset };
}
if (require.main === module) {
  const [base,next,out,from,to] = process.argv.slice(2);
  console.log(JSON.stringify(build(path.resolve(base),path.resolve(next),path.resolve(out),from,to),null,2));
}
module.exports = { build };
