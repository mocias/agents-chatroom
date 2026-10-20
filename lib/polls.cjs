'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const idSchema = { type: 'string', minLength: 1, maxLength: 100 };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  { name: 'poll_create', description: '在当前群创建投票。visibility 必须明确选择 public（记名）或 anonymous（匿名）。request_id 为本次创建的唯一标识，重试使用同一标识。发起者也需要投票。', inputSchema: schema({
    question: { type: 'string', minLength: 1, maxLength: 500 },
    options: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 200 } },
    visibility: { type: 'string', enum: ['public', 'anonymous'] },
    duration_seconds: { type: 'integer', minimum: 30, maximum: 604800 },
    request_id: idSchema,
  }) },
  { name: 'poll_list', description: '查询当前群的投票。匿名投票不返回其他成员的选票；自己的选择仅供自己使用。', inputSchema: schema({}) },
  { name: 'poll_get', description: '查询投票及自己的选择。匿名投票截止前隐藏票数，禁止在聊天中披露自己的匿名选择。', inputSchema: schema({ poll_id: idSchema }) },
  { name: 'poll_vote', description: '为自己投一票；截止前再次调用可改票。保存成功即生效，即使后续回复被中断。匿名选择不要写入聊天。', inputSchema: schema({ poll_id: idSchema, option_id: idSchema }) },
  { name: 'poll_abstain', description: '明确弃权，计为完成参与。截止前可再投票。', inputSchema: schema({ poll_id: idSchema }) },
  { name: 'poll_close', description: '发起者提前结束投票并公布结果。结果不授权执行方案。', inputSchema: schema({ poll_id: idSchema }) },
  { name: 'poll_cancel', description: '发起者取消投票，不宣布获胜结果。', inputSchema: schema({ poll_id: idSchema }) },
];
const toolNames = tools.map(t => t.name);
for (const tool of tools) tool.annotations = {
  readOnlyHint: ['poll_list', 'poll_get'].includes(tool.name),
  destructiveHint: false, idempotentHint: true, openWorldHint: false,
};
function checkArgs(name, args) {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error('未知投票工具');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  const s = tool.inputSchema;
  if (Object.keys(args).some(k => !Object.hasOwn(s.properties, k)) || s.required.some(k => !Object.hasOwn(args, k))) throw new Error('投票参数缺失或包含不允许的字段');
  for (const [k, v] of Object.entries(args)) {
    const rule = s.properties[k];
    if (rule.type === 'string' && (typeof v !== 'string' || !v.trim() || v.length > rule.maxLength)) throw new Error('投票文本无效或过长');
    if (rule.enum && !rule.enum.includes(v)) throw new Error('请选择公开或匿名投票');
    if (rule.type === 'integer' && (!Number.isSafeInteger(v) || v < rule.minimum || v > rule.maximum)) throw new Error('截止时间应为 30 秒至 7 天');
    if (rule.type === 'array' && (!Array.isArray(v) || v.length < 2 || v.length > 10 || v.some(x => typeof x !== 'string' || !x.trim() || x.length > 200))) throw new Error('请填写 2–10 个有效选项');
  }
}

class PollStore extends EventEmitter {
  constructor(file, options = {}) {
    super(); this.file = file; this.now = options.now || Date.now;
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, polls: [] };
    if (data.version !== 1 || !Array.isArray(data.polls)) throw new Error('投票数据版本无效');
    this.items = data.polls;
  }
  save(items) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, polls: items })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file);
    } catch {
      try { fs.unlinkSync(temp); } catch {}
      throw new Error('投票保存失败，操作未确认，请重试查询');
    }
    this.items = items;
  }
  change(id, fn) {
    const next = structuredClone(this.items), p = next.find(p => p.id === id);
    fn(p); p.revision++;
    this.save(next);
    this.emit('change', { roomId: p.roomId, id: p.id });
    return p;
  }
  find(roomId, id) {
    const p = this.items.find(p => p.id === id && p.roomId === roomId);
    if (!p) throw new Error('当前群中不存在此投票');
    return p;
  }
  expire() {
    for (const p of this.items.slice()) if (p.status === 'open' && p.closesAt <= this.now()) this.change(p.id, p => {
      p.status = 'closed'; p.closedAt = this.now(); p.closeReason = 'deadline';
    });
  }
  view(p, actor = null) {
    const showResults = p.visibility === 'public' || p.status === 'closed';
    const ballots = Object.values(p.ballots);
    const counts = Object.fromEntries(p.options.map(o => [o.id, ballots.filter(b => b.optionId === o.id).length]));
    const max = Math.max(0, ...Object.values(counts));
    const result = {
      id: p.id, roomId: p.roomId, question: p.question, options: p.options.map(o => ({ ...o, ...(showResults ? { count: counts[o.id] } : {}) })),
      visibility: p.visibility, creatorLabel: p.creatorLabel, createdAt: p.createdAt, closesAt: p.closesAt,
      status: p.status, closeReason: p.closeReason || null, closedAt: p.closedAt || null, revision: p.revision,
      invitationsPaused: Boolean(p.invitationsPaused),
      total: p.participants.length, completed: ballots.length,
      needsRetry: p.participants.filter(m => !p.ballots[m.id] && !p.unavailable.includes(m.id) && (p.attempts[m.id]?.count || 0) >= 2).length,
      unavailableCount: p.unavailable.filter(id => !p.ballots[id]).length,
      ...(showResults ? { abstained: ballots.filter(b => b.optionId === null).length } : {}),
      winners: p.status === 'closed' && max > 0 ? p.options.filter(o => counts[o.id] === max).map(o => o.id) : [],
      canManage: actor === 'user' || actor === p.creatorId,
    };
    if (p.visibility === 'public') result.participants = p.participants.map(m => ({
      ...m, optionId: p.ballots[m.id]?.optionId, status: p.ballots[m.id] ? (p.ballots[m.id].optionId === null ? 'abstained' : 'voted') : p.unavailable.includes(m.id) ? 'unavailable' : 'pending',
      attempts: p.attempts[m.id]?.count || 0,
    }));
    if (actor && actor !== 'user') result.myVote = p.ballots[actor] ? { optionId: p.ballots[actor].optionId } : null;
    return result;
  }
  list(roomId, actor = null) { this.expire(); return this.items.filter(p => p.roomId === roomId).map(p => this.view(p, actor)); }
  call(roomId, actor, name, args, members) {
    checkArgs(name, args);
    if (actor !== 'user' && !members.some(m => m.id === actor)) throw new Error('当前身份不是群成员');
    this.expire();
    if (name === 'poll_list') return { polls: this.list(roomId, actor) };
    if (name === 'poll_create') {
      const previous = this.items.find(p => p.roomId === roomId && p.creatorId === actor && p.requestId === args.request_id);
      const definition = JSON.stringify([args.question.trim(), args.options.map(s => s.trim()), args.visibility, args.duration_seconds]);
      if (previous) {
        if (previous.definition !== definition) throw new Error('同一创建标识不能用于不同命题');
        return this.view(previous, actor);
      }
      if (members.length < 2) throw new Error('投票至少需要两位 Agent');
      if (new Set(args.options.map(s => s.trim())).size !== args.options.length) throw new Error('投票选项不能重复');
      if (this.items.filter(p => p.roomId === roomId && p.status === 'open').length >= 10) throw new Error('当前群最多同时进行 10 个投票');
      const p = { id: 'p_' + crypto.randomUUID(), roomId, creatorId: actor,
        creatorLabel: actor === 'user' ? '用户' : members.find(m => m.id === actor).label,
        question: args.question.trim(), options: args.options.map((text, i) => ({ id: 'o' + (i + 1), text: text.trim() })),
        visibility: args.visibility, participants: members.map(m => ({ id: m.id, label: m.label })),
        createdAt: this.now(), closesAt: this.now() + args.duration_seconds * 1000,
        requestId: args.request_id, definition, status: 'open', revision: 1, ballots: {}, history: [], attempts: {}, unavailable: [] };
      this.save([...this.items, p]); this.emit('change', { roomId, id: p.id });
      return this.view(p, actor);
    }
    let p = this.find(roomId, args.poll_id);
    if (name === 'poll_get') return this.view(p, actor);
    if (name === 'poll_close' || name === 'poll_cancel') {
      if (actor !== 'user' && actor !== p.creatorId) throw new Error('仅发起者或用户可以结束或取消投票');
      const status = name === 'poll_close' ? 'closed' : 'cancelled';
      if (p.status === status) return this.view(p, actor);
      if (p.status !== 'open') throw new Error('投票已经结束');
      p = this.change(p.id, p => { p.status = status; p.closedAt = this.now(); p.closeReason = 'manual'; });
    } else {
      if (actor === 'user' || !p.participants.some(m => m.id === actor)) throw new Error('只有创建时的 Agent 参与者可以投票');
      const optionId = name === 'poll_abstain' ? null : args.option_id;
      if (optionId !== null && !p.options.some(o => o.id === optionId)) throw new Error('投票选项不存在');
      if (p.ballots[actor]?.optionId === optionId) return this.view(p, actor);
      if (p.status !== 'open') throw new Error('投票已经结束');
      p = this.change(p.id, p => {
        p.ballots[actor] = { optionId, at: this.now() };
        p.history.push({ actor, optionId, at: this.now() });
        if (Object.keys(p.ballots).length === p.participants.length) {
          p.status = 'closed'; p.closedAt = this.now(); p.closeReason = 'all-voted';
        }
      });
    }
    return this.view(p, actor);
  }
  syncMembers(roomId, memberIds) {
    for (const p of this.items.filter(p => p.roomId === roomId && p.status === 'open')) {
      const absent = p.participants.filter(m => !memberIds.includes(m.id)).map(m => m.id);
      if (JSON.stringify(absent) !== JSON.stringify(p.unavailable)) this.change(p.id, p => { p.unavailable = absent; });
    }
  }
  claim(id, actor) {
    const p = this.items.find(p => p.id === id), a = p?.attempts[actor];
    if (!p || p.status !== 'open' || p.invitationsPaused || p.closesAt <= this.now() || p.ballots[actor] || p.unavailable.includes(actor) || (a?.count || 0) >= 2 || (a && this.now() - a.at < 30000)) return false;
    this.change(id, p => { p.attempts[actor] = { count: (a?.count || 0) + 1, at: this.now() }; });
    return true;
  }
  retry(roomId, id) {
    this.expire();
    const p = this.find(roomId, id);
    if (p.status !== 'open') throw new Error('投票已经结束');
    this.change(id, p => { p.attempts = {}; p.invitationsPaused = false; });
  }
  pauseRoom(roomId) {
    for (const p of this.items.filter(p => p.roomId === roomId && p.status === 'open' && !p.invitationsPaused))
      this.change(p.id, p => { p.invitationsPaused = true; });
  }
}
function pollText(p) {
  const status = { open: '进行中', closed: '已结束', cancelled: '已取消' }[p.status];
  const options = p.options.map(o => `${o.id}. ${o.text}${o.count === undefined ? '' : `：${o.count} 票`}`).join('\n');
  const votes = p.participants ? '\n' + p.participants.map(m => `${m.label}：${m.status === 'voted' ? m.optionId : { pending: '未投票', abstained: '弃权', unavailable: '已离开' }[m.status]}`).join('；') : '';
  return `投票 ${p.id} · ${p.visibility === 'anonymous' ? '匿名' : '公开'} · ${status}\n${p.question}\n${options}\n参与 ${p.completed}/${p.total}${votes}${p.status === 'closed' ? '\n结果：' + (p.winners.length ? p.winners.join('、') + (p.winners.length > 1 ? '（并列）' : '') : '无有效选票') + '。投票结果不自动执行方案。' : ''}`;
}
module.exports = { PollStore, tools, toolNames, checkArgs, pollText };
