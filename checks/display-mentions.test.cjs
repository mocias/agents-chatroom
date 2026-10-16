const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMentions, AgentRoom } = require('../lib/room.cjs');
test('mentions resolve full display names with dots, spaces and Chinese without prefix collisions', () => {
 const members=[{id:'agent-a',label:'codex-gpt5.6-sol'},{id:'agent-b',label:'设计 师'},{id:'agent-c',label:'ds'},{id:'agent-d',label:'ds-q'}];
 assert.deepEqual(parseMentions('@codex-gpt5.6-sol 请看看，@设计 师 帮忙 @ds-q 好',members),['agent-a','agent-b','agent-d']);
 assert.deepEqual(parseMentions('@ds-unknown @codex-gpt5.6-sol-extra',members),[]);
 assert.deepEqual(parseMentions('@agent-b 旧格式 @ds 好 @ds 好',members),['agent-b','agent-c']);
 const room=new AgentRoom({id:'name-test',members,prewarm:false});
 assert.match(room._formatRecord(room.members[0],{kind:'agent',authorId:'agent-b',text:'你好'}), /@设计 师/);
});

test('all-members mentions resolve each current member once and retain aliases', () => {
 const members = [{id:'a',label:'设计师'},{id:'b',label:'codex-gpt5.6-sol'}];
 for (const text of ['@所有人 请讨论', '@all hi', '@全体 好', '@所有人 @设计师 @所有人']) assert.deepEqual(parseMentions(text,members),['a','b']);
 assert.deepEqual(parseMentions('@所有人以外',members),[]);
});
