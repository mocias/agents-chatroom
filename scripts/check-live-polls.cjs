'use strict';
// Explicit live acceptance probe. Uses new workspaces and sessions only.
const fs = require('node:fs');
const path = require('node:path');
const { AgentRoom } = require('../lib/room.cjs');
const { PollStore } = require('../lib/polls.cjs');
const { PollBroker } = require('../lib/poll-mcp.cjs');
const { BackendDiscovery } = require('../standalone/discovery.cjs');
const { publicError } = require('../standalone/claude-acp.cjs');
(async () => {
  const output = fs.mkdtempSync(path.resolve('output/polls-live-'));
  const ids = (process.argv[2] || 'codex,dsh').split(',');
  const rows = await new BackendDiscovery({ dir: output, allowAuto: true }).scan();
  const members = ids.map((backend, i) => {
    if (!rows.find(r => r.id === backend)?.selected?.launch) throw new Error('后端未配置：' + backend);
    const workspace = path.join(output, 'agent-' + i); fs.mkdirSync(workspace);
    return { id: 'agent' + i, label: '投票验证' + (i + 1), backend, workspace };
  });
  const polls = new PollStore(path.join(output, 'polls.json'));
  const broker = new PollBroker(({ roomId, memberId }, name, args) => polls.call(roomId, memberId, name, args, members));
  const room = new AgentRoom({ id: 'live-polls', members, cwd: output, projectName: null, segmentMs: 0, queueStallMs: 0, prewarm: false,
    backends: Object.fromEntries(ids.map(id => [id, rows.find(r => r.id === id).selected.launch])),
    pollTools: m => broker.bind('live-polls', m.id), pollView: (id, actor) => polls.view(polls.find('live-polls', id), actor),
    pollList: () => polls.list('live-polls', 'user') });
  const report = { output, backends: ids, transport: 'MCP stdio', startedAt: new Date().toISOString(), calls: [], results: [] };
  report.replies = [];
  const progress = step => { report.step = step; fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(report, null, 2)); console.log(step); };
  const original = broker.invoke;
  broker.invoke = async (binding, name, args) => {
    report.calls.push({ backend: members.find(m => m.id === binding.memberId).backend, name });
    return original(binding, name, args);
  };
  const timeout = setTimeout(() => {
    report.error = 'Live check timed out'; report.passed = false;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    void room.dispose().then(() => broker.close()).finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 10000).unref();
  }, 300000);
  try {
    progress('connecting');
    await room.connect({ tolerateFailures: true });
    // Preserve concrete model choices from each backend's advertised catalogue.
    for (const m of room.members) {
      const caps = await room._poolFor(m).modelCapabilities();
      if (!caps.has(m.model)) m.model = [...caps.keys()][0] || m.model;
    }
    for (const m of room.members) {
      try {
        progress('opening ' + m.backend);
        await room.ensureThread(m);
        const memberPool = room._poolFor(m);
        if (!memberPool.pollProbeWrapped) {
          memberPool.pollProbeWrapped = true;
          const run = memberPool.runTurn.bind(memberPool);
          memberPool.runTurn = async (id, input) => {
            const result = await run(id, input);
            report.replies.push({ backend: m.backend, text: publicError(result.text || '(empty)') });
            return result;
          };
        }
        const connection = memberPool.connections?.get(m.id);
        if (connection) {
          report.permissions = [];
          const answer = connection._answerServerRequest.bind(connection);
          connection._answerServerRequest = frame => {
            if (frame.method === 'session/request_permission') report.permissions.push({ toolName: frame.params?.toolCall?._meta?.['codebuddy.ai/toolName'], keys: Object.keys(frame.params?.toolCall || {}), rawKeys: Object.keys(frame.params?.toolCall?.rawInput || {}) });
            return answer(frame);
          };
        }
        if (m.backend === 'codex') {
          report.toolEvents = [];
          room._poolFor(m).onNotification((method, p) => {
            if (method === 'item/completed' && /mcpToolCall|dynamicToolCall/i.test(p.item?.type || '')) {
              report.toolEvents.push({ type: p.item.type, server: p.item.server, tool: p.item.tool, status: p.item.status,
                error: p.item.error, result: p.item.result });
              progress('tool completed');
            }
          });
          const status = await room._poolFor(m).request('mcpServerStatus/list', { threadId: room._poolFor(m).getThread(m.id).id }, { timeoutMs: 30000 });
          report.mcp = (status.data || []).filter(s => s.name === 'agent_room').map(s => ({ name: s.name, tools: Object.keys(s.tools || {}) }));
          try {
            report.preflight = await room._poolFor(m).request('mcpServer/tool/call', {
              threadId: room._poolFor(m).getThread(m.id).id, server: 'agent_room', tool: 'poll_list', arguments: {},
            }, { timeoutMs: 15000 });
          } catch (error) { report.preflight = { error: publicError(error) }; }
        }
      } catch (error) { report.results.push({ backend: m.backend, setupError: publicError(error) }); }
    }
    const first = room.members[0];
    progress('asking creator');
    const sent = await room.say(`@${first.label} 这是隔离投票验收。请立即使用 agent_room 的 poll_create 工具创建匿名投票，question 为“隔离投票验证”，options 为 ["方案一","方案二"]，visibility 为 anonymous，duration_seconds 为 300，request_id 为 live-one。只调用一次创建工具，不投票，不使用文件或其他工具；成功后仅回复“已创建”。`, { waitForReply: true });
    report.delivery = sent.delivered;
    report.models = room.members.map(m => ({ backend: m.backend, model: m.model, error: m.error }));
    progress('creator returned');
    const p = polls.items[0];
    if (!p) throw new Error('真实 Agent 未创建投票');
    for (const m of room.members) {
      // Production waits for ordinary queued chat before scheduling a ballot.
      while (room._hasPending(m)) await room._deliver(m);
      const result = await room.inviteToPoll(m, p.id);
      report.results.push({ backend: m.backend, finished: Boolean(polls.find('live-polls', p.id).ballots[m.id]), error: result?.error || null });
    }
    report.final = polls.view(polls.items[0], 'user');
    report.passed = report.final.status === 'closed' && report.final.completed === members.length && report.calls.some(c => c.name === 'poll_create');
  } catch (error) { report.error = publicError(error); report.passed = false; }
  finally {
    clearTimeout(timeout); await room.dispose(); await broker.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); process.exit(report.passed ? 0 : 1);
  }
})().catch(error => { console.error(publicError(error)); process.exitCode = 1; });
