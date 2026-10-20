'use strict';
// A private loopback broker owns identities. Each stdio MCP process receives a
// different revocable token through its environment, never through model input.
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { tools } = require('./polls.cjs');

class PollBroker {
  constructor(invoke) {
    this.invoke = invoke; this.tokens = new Map();
    this.server = http.createServer(async (req, res) => {
      const end = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const binding = this.tokens.get(token);
      if (req.method !== 'POST' || req.url !== '/tool' || req.headers.origin || !binding) return end(403, { error: '投票工具身份无效' });
      let raw = '';
      try {
        for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('请求过长'); }
        if (this.tokens.get(token) !== binding) throw new Error('投票工具身份已失效');
        const { name, arguments: args } = JSON.parse(raw);
        const result = await this.invoke(binding, name, args);
        end(200, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (error) { end(200, { content: [{ type: 'text', text: error.message }], isError: true }); }
    });
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }
  async bind(roomId, memberId) {
    await this.ready;
    for (const [key, value] of this.tokens) if (value.roomId === roomId && value.memberId === memberId) this.tokens.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(token, { roomId, memberId });
    return { name: 'agent_room', command: process.execPath, args: [path.join(__dirname, 'poll-mcp-stdio.cjs')],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'AGENT_ROOM_POLL_URL', value: `http://127.0.0.1:${this.server.address().port}/tool` },
        { name: 'AGENT_ROOM_POLL_TOKEN', value: token },
      ] };
  }
  revokeRoom(roomId) { for (const [key, value] of this.tokens) if (value.roomId === roomId) this.tokens.delete(key); }
  async close() { this.tokens.clear(); await this.ready; this.server.closeAllConnections(); if (this.server.listening) await new Promise(resolve => this.server.close(resolve)); }
}
function mcpConfig(servers = []) {
  return Object.fromEntries(servers.map(s => [s.name, { command: s.command, args: s.args, env: Object.fromEntries(s.env.map(e => [e.name, e.value])) }]));
}
module.exports = { PollBroker, mcpConfig, tools };
