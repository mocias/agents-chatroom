'use strict';
// End-to-end HTTP/SSE check with real UTF-8, including the live event stream.
const BASE = process.argv[2] || 'http://127.0.0.1:8791';

async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
  return payload;
}

async function main() {
  const events = [];
  const controller = new AbortController();
  const stream = fetch(`${BASE}/events?room=default`, { signal: controller.signal }).then(async (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {}
          }
        }
      }
    } catch {}
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = events.length;

  const result = await post('/say', { room: 'default', text: '@codex 用一句话说明你是谁。' });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  console.log('--- delivered ---');
  for (const item of result.delivered) {
    console.log(item.memberId + ': ' + (item.record ? item.record.text : JSON.stringify(item)));
  }
  console.log('\n--- SSE events since subscribe (before=' + before + ', total=' + events.length + ') ---');
  const kinds = {};
  for (const event of events) kinds[event.type] = (kinds[event.type] || 0) + 1;
  console.log(JSON.stringify(kinds));
  const snapshot = events.filter((e) => e.type === 'snapshot').length;
  const messages = events.filter((e) => e.type === 'message').length;
  const streams = events.filter((e) => e.type === 'stream').length;
  console.log(`snapshot=${snapshot} message=${messages} stream=${streams}`);
  const streamKinds = {};
  for (const event of events.filter((e) => e.type === 'stream')) {
    streamKinds[event.event.type] = (streamKinds[event.event.type] || 0) + 1;
  }
  console.log('stream kinds: ' + JSON.stringify(streamKinds));
  const deltaEvents = events.filter((e) => e.type === 'stream' && e.event.type === 'delta');
  console.log('delta events: ' + deltaEvents.length + (deltaEvents.length ? ' first="' + deltaEvents[0].event.delta.slice(0, 40) + '"' : ''));

  controller.abort();
  await stream.catch(() => {});
  process.exit(0);
}

main().catch((error) => {
  console.error('FATAL ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
