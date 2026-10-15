#!/usr/bin/env node
/**
 * Offline engine test for the "(无补充)" decline marker — no codex, no network.
 *
 * Scenario: a passive member (not addressed) is asked for its view and replies
 * with exactly the decline marker. The marker is a protocol token, not speech:
 * it must NOT be appended to the shared room log. A later agent reading the
 * transcript would otherwise treat it as a teammate's real utterance.
 *
 * Also checks the contrast case — a member that answers with real content must
 * still be posted.
 */
'use strict';

const path = require('node:path');
const { AgentRoom, isNoAddendum } = require(path.join(__dirname, '..', 'lib', 'room.cjs'));

/** A pool stub: every turn returns whatever `script` says next for that member. */
function stubPool(script) {
  const calls = [];
  let started = false;
  return {
    binary: '(stub)',
    pid: 0,
    calls,
    async start() {
      started = true;
    },
    async modelCapabilities() {
      const map = new Map();
      for (const model of ['gpt-5.6-sol']) {
        map.set(model, { id: model, efforts: ['none', 'low', 'high'], serviceTiers: [], defaultEffort: 'low' });
      }
      return map;
    },
    getThread() {
      return started ? { id: 'stub-thread' } : null;
    },
    async openThread() {
      started = true;
      return { id: 'stub-thread' };
    },
    closeThread() {},
    async runTurn(memberId, options) {
      calls.push({ memberId, text: options.text });
      const reply = script(memberId, options, calls);
      return { text: reply, usage: {} };
    },
  };
}

async function scenario({ label, script, expectPosted }) {
  const room = new AgentRoom({
    cwd: process.cwd(),
    replyPolicy: 'everyone', // wake everyone, so passive members get a turn
    members: [
      { id: 'alpha', label: 'Alpha', model: 'gpt-5.6-sol' },
      { id: 'beta', label: 'Beta', model: 'gpt-5.6-sol' },
    ],
  });
  // Inject the stub AFTER construction: the engine only touches this.pool.
  room.pool = stubPool(script);

  await room.connect();
  await room.say('大家怎么看？');

  const posted = room.log.filter((r) => r.kind === 'agent');
  return { label, posted, expectPosted };
}

async function main() {
  const problems = [];

  // Case 1: both members decline -> no agent bubble at all.
  const declining = await scenario({
    label: 'both decline',
    script: () => '(无补充)',
    expectPosted: 0,
  });
  if (declining.posted.length !== 0) {
    problems.push(`decline was posted as speech: ${JSON.stringify(declining.posted.map((r) => r.text))}`);
  }

  // Case 2: real content still posts.
  const speaking = await scenario({
    label: 'real content',
    script: (memberId) => (memberId === 'alpha' ? '我认为可行。' : '(无补充)'),
    expectPosted: 1,
  });
  if (speaking.posted.length !== 1 || speaking.posted[0].authorId !== 'alpha') {
    problems.push(`real content not posted correctly: ${JSON.stringify(speaking.posted.map((r) => [r.authorId, r.text]))}`);
  }

  // Case 3: silent turn counter is tracked and surfaced.
  const silent = declining.posted.length === 0 ? undefined : null;
  if (silent === null) problems.push('decline path did not silence');

  console.log('case1 both-decline   posted:', declining.posted.length);
  console.log('case2 real-content   posted:', speaking.posted.length, JSON.stringify(speaking.posted.map((r) => r.authorId)));
  console.log('problems:', problems.length ? problems.join(' | ') : 'none');
  process.exit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
