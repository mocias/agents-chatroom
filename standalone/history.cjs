'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function publicMessage(r) {
  return { id: String(r.id || ''), seq: r.seq, ts: String(r.ts || ''), kind: String(r.kind || 'agent'),
    authorLabel: String(r.authorLabel || r.authorId || '未知'), text: String(r.text || ''),
    visibility: r.visibility === 'private' ? 'private' : 'public',
    recipients: Array.isArray(r.recipientLabels) ? r.recipientLabels.map(String) : [],
    attachments: (Array.isArray(r.attachments) ? r.attachments : []).filter(Boolean).map(f => ({ name: String(f.name || '附件'), mediaType: f.mediaType, bytes: f.bytes })) };
}
async function* messages(dir, id, stats = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('无效的会话标识');
  const file = path.join(dir, id + '.log.jsonl');
  let handle;
  try { handle = await fs.promises.open(file, 'r'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try {
    const size = (await handle.stat()).size;
    if (!size) return;
    // Fix the byte boundary so a concurrent reply cannot extend this export.
    const stream = handle.createReadStream({ encoding: 'utf8', end: size - 1, autoClose: false });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(); }
        catch { stats.skipped = (stats.skipped || 0) + 1; continue; }
        if (!record.streaming) yield publicMessage(record);
      }
    } finally { lines.close(); stream.destroy(); }
  } finally { await handle.close(); }
}
async function searchHistory(dir, conversations, query, offset = 0, limit = 40) {
  const q = query.toLocaleLowerCase(); const results = []; let total = 0; const stats = {};
  for (const room of conversations) {
    for await (const message of messages(dir, room.id, stats)) {
      const haystack = [message.text, message.authorLabel, ...message.attachments.map(f => f.name)].join('\n').toLocaleLowerCase();
      if (q && !haystack.includes(q)) continue;
      if (total >= offset && results.length < limit) results.push({ roomId: room.id, title: room.title, ...message });
      total++;
    }
  }
  return { results, total, offset, limit, skipped: stats.skipped || 0 };
}
async function* exportHistory(dir, room, format) {
  const stats = {}; let first = true;
  if (format === 'json') yield '{"conversation":' + JSON.stringify({ id: room.id, title: room.title, kind: room.kind }) + ',"messages":[\n';
  else yield '# ' + String(room.title).replace(/[\r\n]/g, ' ') + '\n\n聊天记录包含用户可见的公开及私聊消息。附件仅包含名称，不包含原文件。\n\n';
  for await (const m of messages(dir, room.id, stats)) {
    if (format === 'json') { yield (first ? '' : ',\n') + JSON.stringify(m); first = false; }
    else {
      const scope = m.visibility === 'private' ? '私聊 → ' + (m.recipients.join('、') || '指定接收者') : '公开';
      yield `## ${m.authorLabel.replace(/[\r\n]/g, ' ')} · ${m.ts} · ${scope}\n\n${m.text}\n\n`;
      if (m.attachments.length) yield m.attachments.map(f => '- 附件：' + f.name.replace(/[\r\n]/g, ' ')).join('\n') + '\n\n';
    }
  }
  if (format === 'json') yield '\n],"skippedRecords":' + (stats.skipped || 0) + '}\n';
  else if (stats.skipped) yield `> 有 ${stats.skipped} 条损坏记录无法读取，已跳过。\n`;
}
module.exports = { messages, searchHistory, exportHistory };
