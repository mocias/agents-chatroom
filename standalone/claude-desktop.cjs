'use strict';
const fs = require('node:fs');
const path = require('node:path');
const archiveFs = process.versions.electron ? require('original-fs') : fs;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function profileRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return [...new Set([process.env.LOCALAPPDATA, process.env.APPDATA,
    path.join(home, 'AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming')]
    .filter(Boolean).map(root => path.join(root, 'Claude-3p')))];
}
function selectedProfile(dataDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'configLibrary/_meta.json'), 'utf8'));
    if (!UUID.test(meta.appliedId)) throw new Error();
    const file = path.join(dataDir, 'configLibrary', meta.appliedId + '.json');
    if (!isFile(file)) throw new Error();
    return file;
  } catch { throw new Error('Claude 桌面端尚未选择可用的第三方 API 配置'); }
}
function codeBinary(dataDir) {
  const root = path.join(dataDir, 'claude-code');
  try {
    const versions = fs.readdirSync(root).filter(v => /^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(v))
      .sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const dir = path.join(root, version);
      const candidates = [path.join(dir, 'claude.exe'), ...fs.readdirSync(dir)
        .filter(v => /^[a-f\d]{12}$/.test(v)).map(v => path.join(dir, v, 'claude.exe'))];
      for (const binary of candidates) if (isFile(binary)) return binary;
    }
  } catch {}
  throw new Error('Claude 桌面端尚未下载 Code 运行程序，请先打开 Code 页面完成准备');
}
function resolveDesktopCode(exe, roots = profileRoots()) {
  const archive = path.join(path.dirname(exe), 'resources/app.asar');
  let fd;
  try {
    fd = archiveFs.openSync(archive, 'r'); const prefix = Buffer.alloc(16);
    if (archiveFs.readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error();
    const size = prefix.readUInt32LE(12); if (size < 2 || size > 32 * 1024 * 1024) throw new Error();
    const header = Buffer.alloc(size); if (archiveFs.readSync(fd, header, 0, size, 16) !== size) throw new Error();
    if (!JSON.parse(header).files?.['.vite']?.files?.build?.files?.['index.pre.js']) throw new Error();
  } catch { throw new Error('这是未识别的 Claude 桌面应用，无法确认其 Code 运行入口'); }
  finally { if (fd !== undefined) archiveFs.closeSync(fd); }
  for (const dataDir of roots) {
    try { selectedProfile(dataDir); return { binary: codeBinary(dataDir), desktopDataDir: dataDir }; }
    catch { /* Another per-user profile location may be active. */ }
  }
  throw new Error('Claude 桌面应用没有可用的 API 配置或 Code 运行程序；请先在桌面端完成配置');
}
// Read only inside the bridge process. Never return this environment in a
// discovery response or persist it in Room's preferences or diagnostic reports.
function desktopModelAliases(dataDir, config) {
  let targets;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'model-catalog/published.json'), 'utf8'));
    if (typeof cache.documentBytes !== 'string' || cache.documentBytes.length > 4 * 1024 * 1024) throw new Error();
    const doc = JSON.parse(Buffer.from(cache.documentBytes, 'base64').toString('utf8'));
    targets = doc.surfaces?.ccd?.model_selector_config?.find(row => row.provider_alias_targets)?.provider_alias_targets;
  } catch {}
  const env = {};
  for (const family of ['haiku', 'sonnet', 'opus', 'fable']) {
    const overrides = Array.isArray(config.inferenceModels) ? config.inferenceModels.filter(m => m.anthropicFamilyTier === family) : [];
    const model = (overrides.find(m => m.isFamilyDefault) || overrides[0])?.name
      || targets?.[family]?.per_provider?.gateway || targets?.[family]?.default;
    if (typeof model === 'string' && /^[\w][\w.:/-]{0,199}$/.test(model)) env['ANTHROPIC_DEFAULT_' + family.toUpperCase() + '_MODEL'] = model;
  }
  if (!Object.keys(env).length) throw new Error('Claude 桌面模型映射尚未准备，请先在桌面打开 Code 页面');
  return env;
}
function desktopEnvironment(dataDir, inherited = process.env) {
  let config;
  try { config = JSON.parse(fs.readFileSync(selectedProfile(dataDir), 'utf8')); }
  catch { throw new Error('无法读取 Claude 桌面端当前 API 配置'); }
  if (config.inferenceProvider !== 'gateway') throw new Error('目前只支持 Claude 桌面端的 Gateway API 配置');
  const base = config.inferenceGatewayBaseUrl, key = config.inferenceGatewayApiKey;
  let url; try { url = new URL(base); } catch { throw new Error('Claude 桌面端 API 地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Claude 桌面端 API 地址格式不受支持');
  if (typeof key !== 'string' || !key || /^(encrypted:|dpapi:)/i.test(key)) throw new Error('Claude 桌面端 API 凭据不可用，请在桌面端检查配置');
  const scheme = config.inferenceGatewayAuthScheme;
  if (!['bearer', 'x-api-key'].includes(scheme)) throw new Error('Claude 桌面端 API 认证方式暂不支持');
  const aliases = desktopModelAliases(dataDir, config);
  const env = { ...inherited, ...aliases, ANTHROPIC_BASE_URL: base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[name];
  env[scheme === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key;
  if (aliases.ANTHROPIC_DEFAULT_SONNET_MODEL) env.ANTHROPIC_MODEL = aliases.ANTHROPIC_DEFAULT_SONNET_MODEL;
  return env;
}
function desktopModels(dataDir) {
  const config = JSON.parse(fs.readFileSync(selectedProfile(dataDir), 'utf8'));
  if (config.inferenceProvider !== 'gateway') return [];
  let models = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'model-catalog/published.json'), 'utf8'));
    if (typeof cache.documentBytes !== 'string' || cache.documentBytes.length > 4 * 1024 * 1024) throw new Error();
    const doc = JSON.parse(Buffer.from(cache.documentBytes, 'base64').toString('utf8'));
    models = (doc.surfaces?.ccd?.model_selector_config || []).flatMap(row => row.models || [])
      .filter(m => !m.hidden && !m.disabled && m.offered_on?.includes('gateway'))
      .map(m => ({ value: m.id, name: m.name || m.id }));
  } catch {}
  for (const m of config.inferenceModels || []) models.push({ value: m.name, name: m.displayName || m.name });
  return [...new Map(models.filter(m => typeof m.value === 'string' && /^[\w][\w.:/-]{0,199}$/.test(m.value)).map(m => [m.value, m])).values()];
}
module.exports = { resolveDesktopCode, selectedProfile, codeBinary, desktopEnvironment, desktopModelAliases, desktopModels, profileRoots };
