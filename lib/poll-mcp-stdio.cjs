'use strict';
const readline = require('node:readline');
const { tools } = require('./polls.cjs');
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const lines = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
lines.on('line', async line => {
  let frame;
  try { if (line.length > 32768) throw new Error(); frame = JSON.parse(line); } catch { return; }
  if (frame.id === undefined) return;
  try {
    let result;
    if (frame.method === 'initialize') result = { protocolVersion: versions.includes(frame.params?.protocolVersion) ? frame.params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'agent-room-polls', version: '1.0.0' } };
    else if (frame.method === 'ping') result = {};
    else if (frame.method === 'tools/list') result = { tools };
    else if (frame.method === 'tools/call') {
      const url = new URL(process.env.AGENT_ROOM_POLL_URL);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/tool') throw new Error('投票服务配置无效');
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.AGENT_ROOM_POLL_TOKEN },
        body: JSON.stringify(frame.params), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('投票工具身份已失效，请重建会话');
      result = await response.json();
    } else return send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unknown method' } });
    send({ jsonrpc: '2.0', id: frame.id, result });
  } catch { send({ jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: '投票服务不可用，请稍后查询确认，勿假定投票成功。' }], isError: true } }); }
});
