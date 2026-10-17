'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

// WorkBuddy 5.8.x LocalStorage: wb_entry_<md5(key)>.info. This is the
// desktop CloudProductManager's cloud_product_config_cache, not product.json.
// Read only the supervisor-verified profile. Never search other installations
// or pick the newest account in a multi-account cache.
function readDesktopCatalog(configDir) {
  const unavailable = reason => ({ source: 'native', warning: reason + '；暂时仅显示后端原生选项。请在 WorkBuddy 桌面刷新模型后重试。' });
  if (!configDir) return unavailable('尚未连接 WorkBuddy 桌面');
  try {
    const file = path.join(configDir, 'local_storage', 'wb_entry_d43e96994f944cfb77961c2ea7d04605.info');
    if (fs.statSync(file).size > 8 * 1024 * 1024) return unavailable('桌面模型目录过大');
    let entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof entries === 'string') entries = JSON.parse(gunzipSync(Buffer.from(entries, 'base64'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'));
    if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0]?.userId !== 'string') {
      return unavailable('桌面目录包含多个账号或无法识别，不能安全确定模型目录');
    }
    const { data, ts } = entries[0];
    const agent = data?.agents?.find(a => a?.name === 'cli');
    if (!Array.isArray(agent?.models) || !Array.isArray(data?.models)) return unavailable('桌面模型目录格式不兼容');
    const byId = new Map(data.models.filter(m => m && typeof m.id === 'string').map(m => [m.id, m]));
    const options = [...new Set(agent.models)].flatMap(id => {
      const model = byId.get(id);
      if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id) || model.disabled || model.hidden || model.supportsToolCall === false) return [];
      // Deliberate allowlist: URLs, credentials and account identifiers never
      // enter Room's model API, persisted agent records or diagnostic output.
      return [{ value: id, name: typeof model.name === 'string' ? model.name : id }];
    });
    if (!options.length) return unavailable('桌面未返回可用的聊天模型');
    return { source: 'desktop-cache', updatedAt: Number.isFinite(ts) ? ts : null, options };
  } catch { return unavailable('未能读取 WorkBuddy 桌面在线目录快照'); }
}
module.exports = { readDesktopCatalog };
