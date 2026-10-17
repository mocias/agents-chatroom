'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const editions = {
  workbuddy: { label: 'WorkBuddy（国内版）', exe: 'WorkBuddy.exe', authId: 'workbuddy-desktop', configName: '.workbuddy' },
  'workbuddy-ai': { label: 'WorkBuddy AI（国际版）', exe: 'WorkBuddyAI.exe', authId: 'workbuddy-desktop-ai', configName: '.workbuddy-ai' },
};
const isWorkbuddy = id => Object.hasOwn(editions, id);
function desktopLaunch(id, exe) {
  const edition = editions[id];
  if (!edition || path.basename(exe).toLowerCase() !== edition.exe.toLowerCase()) throw new Error('请选择对应版本的 WorkBuddy 桌面程序');
  const cli = path.join(path.dirname(exe), 'resources/app.asar.unpacked/cli');
  const entry = path.join(cli, 'bin/codebuddy'), productPath = path.join(cli, 'product.json');
  let product;
  try { product = JSON.parse(fs.readFileSync(productPath, 'utf8')); if (!fs.statSync(entry).isFile()) throw new Error(); }
  catch { throw new Error('此 WorkBuddy 版本未找到可识别的本机后端，请升级或选择完整安装目录'); }
  if (product.authentication?.id !== edition.authId) throw new Error('WorkBuddy 国内版与国际版不匹配，请选择对应版本');
  return { agentCommand: exe, agentArgs: [entry, '--serve', '--acp'], proxy: false,
    workbuddySupervisor: true,
    workbuddyProductPath: productPath,
    workbuddyConfigCandidates: [...new Set([edition.configName, '.workbuddy-ai', '.workbuddy'])].map(name => path.join(os.homedir(), name)),
    env: { ELECTRON_RUN_AS_NODE: '1', DISABLE_AUTOUPDATER: '1', CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
      CODEBUDDY_DISABLE_PRODUCT_CACHE: '1',
      ACC_PRODUCT_CONFIG_PATH: productPath, CODEBUDDY_HOST: 'workbuddy-desktop' } };
}
module.exports = { editions, isWorkbuddy, desktopLaunch };
