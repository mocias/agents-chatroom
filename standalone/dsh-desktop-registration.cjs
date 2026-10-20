'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { replaceFile } = require('./native-files.cjs');
function installBridge(dataDir, launch = {}, options = {}) {
  const home = launch.env?.DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = options.profile || launch.env?.DSH_PROFILE_DIR || process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop');
  const patch = path.join(profile, 'cordis.patch.yml');
  if (!fs.existsSync(profile)) throw Error('请先启动一次 DSH 桌面以生成配置');
  const original = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : null;
  const bridgeDir = path.join(profile, 'agent-room-desktop-bridge');
  fs.mkdirSync(bridgeDir, { recursive: true });
  const entry = path.join(bridgeDir, 'index.mjs');
  const catalog = path.resolve(dataDir, 'catalog.json');
  // Self-contained bundled bridge: no npm install and no old Room plugin.
  const helper = fs.readFileSync(path.join(__dirname, '../lib/dsh-catalog-sync.cjs'), 'utf8');
  const moduleSource = `import sync from './sync.cjs';\nexport const inject = ['workspaceRegistry'];\nexport function apply(ctx, config) { ctx.effect(() => sync.startDshCatalogSync(ctx, config.nativeCatalogFile, { receiptSource: 'agent-room-bundled-bridge-v1' })); }\n`;
  for (const [file, content] of [[path.join(bridgeDir, 'sync.cjs'), helper], [entry, moduleSource]]) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    replaceFile(file, before, content);
  }
  const begin = '# BEGIN Agent Room desktop bridge', end = '# END Agent Room desktop bridge';
  const block = `${begin}\n- insert:\n    - id: agent-room-desktop-bridge\n      name: ${JSON.stringify(pathToFileURL(entry).href)}\n      config:\n        nativeCatalogFile: ${JSON.stringify(catalog)}\n${end}`;
  let yaml = original || '';
  // Migrate only our old bridge setting; keep the user's legacy Room plugin
  // and all its other configuration intact, avoiding two receipt writers.
  yaml = yaml.replace(/(^- id: agent-room\r?\n[\s\S]*?)(?=^- |$(?![\s\S]))/m, section => section.replace(/^    nativeCatalogFile:.*\r?\n/gm, line => {
    const value = line.replace(/^    nativeCatalogFile:\s*/, '').trim();
    let decoded;
    try { decoded = value.startsWith('"') ? JSON.parse(value) : value.startsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value; } catch { return line; }
    return require('./desktop-state.cjs').samePath(decoded, catalog) ? '' : line;
  }));
  if (yaml.includes(begin) !== yaml.includes(end)) throw Error('DSH 桥接配置不完整，请检查 cordis.patch.yml');
  const existing = /# BEGIN Agent Room desktop bridge[\s\S]*?# END Agent Room desktop bridge/;
  if (existing.test(yaml)) yaml = yaml.replace(existing, () => block);
  else yaml = yaml.trimEnd() + '\n' + block + '\n';
  replaceFile(patch, original, yaml);
  return { status: 'bridge-installed', workspaceRegistered: false, profile,
    detail: '已自动配置内置 DSH 桥接，无需单独安装插件。DSH 加载配置或重启后会登记工作区和已有会话。' };
}
module.exports = { installBridge };
