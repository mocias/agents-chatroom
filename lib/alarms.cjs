'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function localTime(value = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) + ' (Asia/Shanghai)';
}

function parseAlarm(text, members, now = Date.now()) {
  const head = text.match(/^\/alarm\s+(\S+)\s+([@#])([\s\S]+)$/);
  if (!head) throw new Error('闹钟格式：/alarm 10m #成员 备注，或 /alarm 2026-10-17T18:00:00+08:00 @成员 备注');
  const [, when, marker, tail] = head;
  let due;
  const relative = when.match(/^(\d+)(s|m|h|d)$/);
  if (relative) due = now + Number(relative[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[relative[2]];
  else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(when)) throw new Error('绝对时间必须包含日期、秒和时区，例如 2026-10-17T18:00:00+08:00');
    due = Date.parse(when);
  }
  if (!Number.isFinite(due) || due <= now || due - now > 366 * 86400000) throw new Error('闹钟时间必须在未来且不超过 366 天');
  const targets = [...members, { id: 'user', label: '用户' }, ...(marker === '@' ? [{ id: 'all', label: '所有人' }] : [])];
  const matches = targets.filter(m => tail.startsWith(m.label) && /^\s/.test(tail.slice(m.label.length)));
  const length = Math.max(0, ...matches.map(m => m.label.length));
  const exact = matches.filter(m => m.label.length === length);
  if (exact.length !== 1) throw new Error('闹钟接收者不存在或不明确');
  const target = exact[0], note = tail.slice(target.label.length).trim();
  if (!note || note.length > 2000) throw new Error('闹钟备注须为 1–2000 字符');
  return { dueAt: new Date(due).toISOString(), visibility: marker === '#' ? 'private' : 'public', targetId: target.id, targetLabel: target.label, note };
}

class AlarmStore {
  constructor(file, deliver, options = {}) {
    this.file = file; this.deliver = deliver; this.now = options.now || Date.now;
    this.items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    if (!Array.isArray(this.items)) throw new Error('闹钟存储损坏');
    this.running = false; this.closed = false;
    this.timer = options.manual ? null : setInterval(() => { void this.tick(); }, 1000);
    this.timer?.unref();
  }
  save(next) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(this.file + '.tmp', this.file);
    this.items = next;
  }
  createBatch(roomId, creatorId, commands) {
    if (this.items.filter(a => a.status === 'pending' && a.roomId === roomId).length + commands.length > 100) throw new Error('每个群聊最多保留 100 个待触发闹钟');
    const created = commands.map(command => ({ ...command, id: randomUUID(), roomId, creatorId, createdAt: new Date(this.now()).toISOString(), status: 'pending' }));
    this.save([...this.items, ...created]); return created;
  }
  cancel(id, roomId) {
    const item = this.items.find(a => a.id === id && a.roomId === roomId);
    if (!item || item.status !== 'pending') throw new Error('闹钟不存在或已结束');
    if (this.activeId === id) throw new Error('闹钟正在投递，请稍后刷新');
    this.save(this.items.map(a => a.id === id ? { ...a, status: 'cancelled' } : a));
  }
  async tick() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      for (const item of this.items.filter(a => a.status === 'pending' && Date.parse(a.dueAt) <= this.now())) {
        if (this.closed) break;
        if (this.items.find(a => a.id === item.id)?.status !== 'pending') continue;
        this.activeId = item.id;
        try {
          const result = await this.deliver(item);
          this.save(this.items.map(a => a.id === item.id ? { ...a, status: result === false ? 'cancelled' : 'fired', firedAt: new Date(this.now()).toISOString(), error: undefined } : a));
        } catch (error) {
          // Keep pending on failure. Delivery uses alarm IDs to deduplicate after a crash.
          try { this.save(this.items.map(a => a.id === item.id ? { ...a, error: error.message } : a)); } catch {}
        } finally { this.activeId = null; }
      }
    } finally { this.running = false; }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }
}

module.exports = { AlarmStore, parseAlarm, localTime };
