'use strict';
// Install the narrow native-registry bridge into an existing DSH Room plugin.
// No DSH storage rows or session transcripts are edited.
const fs = require('node:fs');
const path = require('node:path');
const [profile, dataDir] = process.argv.slice(2);
if (!profile || !dataDir) throw Error('Usage: node install-dsh-catalog-sync.cjs <DSH profile> <Room data>');
const catalog = path.resolve(dataDir, 'catalog.json');
JSON.parse(fs.readFileSync(catalog, 'utf8'));
const plugin = fs.realpathSync(path.join(profile, 'node_modules', 'dsh-agent-room'));
const entry = path.join(plugin, 'lib', 'index.js');
const patch = path.join(profile, 'cordis.patch.yml');
let source = fs.readFileSync(entry, 'utf8');
let yaml = fs.readFileSync(patch, 'utf8');
const anchor = 'export function apply(ctx, config = {}) {';
const marker = '// Agent Room native catalog bridge';
if (!source.includes(anchor)) throw Error('Unsupported installed DSH Room entry');
if (!source.includes(marker) && !source.includes('startDshCatalogSync(ctx,')) {
  source = source.replace(anchor, anchor + '\n  ' + marker + '\n  const { startDshCatalogSync } = require(join(here, "dsh-catalog-sync.cjs"));\n  ctx.effect(() => startDshCatalogSync(ctx, config.nativeCatalogFile));');
}
const section = /(^- id: agent-room\r?\n[\s\S]*?)(?=^- id:|^- insert:|$(?![\s\S]))/m;
if (!section.test(yaml)) throw Error('Existing agent-room profile configuration not found');
yaml = yaml.replace(section, block => {
  const line = "    nativeCatalogFile: '" + catalog.replace(/'/g, "''") + "'";
  return /^    nativeCatalogFile:/m.test(block) ? block.replace(/^    nativeCatalogFile:.*$/m, line)
    : block.replace(/  config:\r?\n/, '  config:\n' + line + '\n');
});
const stamp = Date.now();
for (const [file, content] of [[entry, source], [patch, yaml]]) {
  const original = fs.readFileSync(file, 'utf8');
  if (original === content) continue;
  fs.copyFileSync(file, file + '.before-native-sync-' + stamp);
  fs.writeFileSync(file + '.tmp-native-sync', content);
  fs.renameSync(file + '.tmp-native-sync', file);
}
fs.copyFileSync(path.join(__dirname, '..', 'lib', 'dsh-catalog-sync.cjs'), path.join(plugin, 'lib', 'dsh-catalog-sync.cjs'));
console.log(JSON.stringify({ plugin, catalog, restart: 'DSH', installed: true }));
