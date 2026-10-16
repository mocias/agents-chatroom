'use strict';

// Keep the host's networking (including TUN/direct) unless the caller or the
// user explicitly configured an Agent Room proxy. Never assume a local port.
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('DSH_')) delete env[key];
  const asked = extra.proxy;
  const proxy = asked === false || asked === '' ? null : asked || process.env.AGENT_ROOM_PROXY;
  if (proxy) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = proxy;
  }
  const inheritedBypass = [env.NO_PROXY, env.no_proxy];
  Object.assign(env, extra.env || {});
  // Upper/lower case precedence varies between clients. Retain both custom
  // lists and always keep local bridges out of a configured HTTP/SOCKS proxy.
  const bypass = [...new Set([...inheritedBypass, env.NO_PROXY, env.no_proxy, 'localhost,127.0.0.1,::1']
    .filter(Boolean).flatMap(value => String(value).split(',').map(item => item.trim()).filter(Boolean)))].join(',');
  env.NO_PROXY = bypass; env.no_proxy = bypass;
  return env;
}
module.exports = { childEnv };
