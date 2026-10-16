'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.resolve('output/installer-preserve-'));
const install = path.join(root, 'test-install');
fs.mkdirSync(path.join(install, 'agents', 'codex', 'test'), { recursive: true });
fs.mkdirSync(path.join(install, 'resources'));
fs.writeFileSync(path.join(install, 'agents', 'codex', 'test', 'keep.txt'), 'workspace');
fs.writeFileSync(path.join(install, 'resources', 'app.asar'), 'fixture');
fs.writeFileSync(path.join(install, 'app.exe'), 'fixture');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
const candidates = fs.readdirSync(cache).filter(name => name.startsWith('nsis')).flatMap(name => {
  const dir = path.join(cache, name);
  if (!fs.statSync(dir).isDirectory()) return [];
  return [path.join(dir, 'Bin', 'makensis.exe'), ...fs.readdirSync(dir).map(child => path.join(dir, child, 'Bin', 'makensis.exe'))];
});
const compiler = candidates.find(p => fs.existsSync(p));
if (!compiler) throw new Error('Build the desktop installer first to populate the NSIS compiler cache');
const exe = path.join(root, 'preserve-test.exe');
const source = path.join(root, 'test.nsi');
fs.writeFileSync(source, `Unicode true
Name "Agent Room isolated preservation test"
SilentInstall silent
RequestExecutionLevel user
OutFile "${exe}"
InstallDir "${install}"
!include "${path.resolve('desktop/preserve-agents.nsh')}"
Section
!insertmacro customRemoveFiles
SectionEnd
`);
execFileSync(compiler, ['/V2', source], { windowsHide: true });
// The generated test removes files only beneath the explicit isolated fixture.
assert.ok(install.startsWith(path.resolve('output') + path.sep));
execFileSync(exe, ['/S'], { windowsHide: true, timeout: 30000 });
assert.equal(fs.readFileSync(path.join(install, 'agents', 'codex', 'test', 'keep.txt'), 'utf8'), 'workspace');
assert.equal(fs.existsSync(path.join(install, 'app.exe')), false);
assert.equal(fs.existsSync(path.join(install, 'resources')), false);
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ ok: true, install, agentsPreserved: true, appFilesRemoved: true }, null, 2));
console.log(root + ': installer removal macro preserved agents and removed only application fixtures');
