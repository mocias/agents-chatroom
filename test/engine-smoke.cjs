'use strict';
/**
 * Engine smoke test: no DSH, no UI — just the room engine against the real
 * local codex app-server.
 *
 * Run:  node agent-room/test/engine-smoke.cjs
 */
const path = require('node:path');
const { AgentRoom } = require('../lib/room.cjs');

const members = [
  { id: 'codex', label: 'Codex', model: 'gpt-5.6-sol', persona: 'You are terse. One short sentence.' },
  { id: 'astra', label: 'Astra', model: 'gpt-6-astra', persona: 'You are terse. One short sentence.' },
];

async function main() {
  const room = new AgentRoom({
    cwd: process.cwd(),
    members,
    replyPolicy: 'addressed',
    maxRelayHops: 1,
  });

  room.on('log', (line) => process.stdout.write('[log] ' + line + '\n'));
  room.on('stream', (event) => {
    if (event.type === 'agent-start') process.stdout.write(`\n… @${event.memberId} is thinking\n`);
    if (event.type === 'item' && event.item.type !== 'agentMessage') {
      process.stdout.write(`   · ${event.item.type}${event.item.command ? ' ' + event.item.command : ''}\n`);
    }
    if (event.type === 'agent-end' && event.error) process.stdout.write(`   ! @${event.memberId} error: ${event.error}\n`);
  });

  const t0 = Date.now();
  process.stdout.write('connecting…\n');
  await room.connect();
  process.stdout.write(`connected in ${((Date.now() - t0) / 1000).toFixed(1)}s, pid=${room.pool.pid}\n`);
  process.stdout.write('models: ' + room.availableModels.join(', ') + '\n');
  process.stdout.write('member errors: ' + JSON.stringify(room.members.map((m) => [m.id, m.error])) + '\n\n');

  const steps = [
    '大家好，报一下自己的名字，一句话。',
    '@codex 记住一个密语：紫罗兰。只回复 OK。',
    '刚才的密语是什么？@astra 你来回答。',
    '@astra 请 @codex 说出密语。',
  ];

  for (const text of steps) {
    const t = Date.now();
    process.stdout.write('\nUSER> ' + text + '\n');
    const result = await room.say(text);
    process.stdout.write(`--- dispatched ${result.delivered.length} in ${((Date.now() - t) / 1000).toFixed(1)}s\n`);
  }

  process.stdout.write('\n================ FINAL LOG ================\n');
  for (const record of room.log) {
    process.stdout.write(`[${record.seq}] ${record.authorId}: ${record.text}\n`);
  }
  process.stdout.write('\n================ MEMBERS ================\n');
  for (const member of room.snapshot().members) {
    process.stdout.write(`${member.id} status=${member.status} turns=${member.turns} tokens=${member.tokens} err=${member.error || '-'}\n`);
  }

  // Verify: no agent impersonated another.
  const impersonation = room.log.filter(
    (r) => r.kind === 'agent' && (r.text.includes(`@${r.authorId}:`) || r.text.startsWith(`${r.authorId}:`)),
  );
  process.stdout.write('\nIMPERSONATION? ' + (impersonation.length > 0) + '\n');

  await room.dispose();
  process.exit(0);
}

main().catch((error) => {
  console.error('FATAL ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
