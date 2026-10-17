'use strict';

// Parse the complete output before publishing anything. Unknown # recipients
// fail the batch closed; they must never become public text by accident.
function splitMessages(text) {
  const blocks = [];
  let lines = [], fence = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const mark = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (mark) {
      if (!fence) fence = { char: mark[1][0], length: mark[1].length };
      else if (mark[1][0] === fence.char && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
      lines.push(line);
    } else if (!fence && line.trim() === '---') {
      if (lines.join('\n').trim()) blocks.push(lines.join('\n').trim());
      lines = [];
    } else lines.push(line);
  }
  if (lines.join('\n').trim()) blocks.push(lines.join('\n').trim());
  return blocks;
}

function parseMessages(text, members, authorId = 'user') {
  return splitMessages(text).map(body => {
    const envelope = body.match(/^([@#])([^：:\n]+)[：:]\s*/);
    // A colon later in a mention's prose is not a sender delimiter.
    // Keep exact known names (including names with spaces) compatible with
    // full envelopes; reject unknown compact sender labels as before.
    const senderNames = ['用户', '系统', ...members.map(m => m.label)];
    if (envelope && (senderNames.includes(envelope[2]) || !/\s/.test(envelope[2]))) {
      const author = authorId === 'user' ? '用户' : members.find(m => m.id === authorId)?.label;
      if (envelope[2] !== author) throw new Error('消息发送者必须是自己的完整名称，不能冒充系统或其他成员');
      body = body.slice(envelope[0].length).trim();
      if (!body || (envelope[1] === '#' && !body.startsWith('#')) || (envelope[1] === '@' && body.startsWith('#'))) throw new Error('消息前缀与收件人范围不一致');
    }
    if (!body.startsWith('#') || /^#\s/.test(body)) return { text: body, visibility: 'public', recipientIds: [] };
    const targets = [...members, { id: 'user', label: '用户' }];
    const tail = body.slice(1);
    const matches = targets.filter(m => tail.startsWith(m.label) && (!tail.slice(m.label.length) || /^\s/.test(tail.slice(m.label.length))));
    const longest = Math.max(0, ...matches.map(m => m.label.length));
    const exact = matches.filter(m => m.label.length === longest);
    if (exact.length !== 1) throw new Error('私聊接收者不存在或不明确，请使用 #完整成员名 后加空格或换行');
    const target = exact[0];
    if (target.id === authorId) throw new Error('不能向自己发送私聊');
    if (!tail.slice(target.label.length).trim()) throw new Error('私聊内容不能为空');
    return { text: body, visibility: 'private', recipientIds: [target.id], recipientLabels: [target.label] };
  });
}

function displayMessage(record) {
  const marker = record.visibility === 'private' ? '#' : '@';
  const sender = record.authorId === 'user' ? '用户' : (record.authorLabel || record.authorId);
  return `${marker}${sender}：${record.text}`;
}

function canRead(record, memberId) {
  if (!record.visibility || record.visibility === 'public') return true;
  return record.visibility === 'private' && (record.authorId === memberId || (Array.isArray(record.recipientIds) && record.recipientIds.includes(memberId)));
}

module.exports = { splitMessages, parseMessages, canRead, displayMessage };
