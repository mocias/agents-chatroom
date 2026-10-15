#!/usr/bin/env node
/**
 * Exercises the PLUGIN'S OWN grouping code against the real codex app-server.
 *
 * Every method this touches — `thread/list`, `project/list`, `project/import`,
 * `project/delete` — is local RPC against codex's own store. No turn runs, so
 * this spends no model quota. `--apply` writes; without it the probe is
 * read-only and only reports what the pool would do.
 *
 * Run:  node test/probe-group-live.cjs [--apply]
 */
'use strict';

const path = require('node:path');
const { CodexThreadPool } = require(path.join(__dirname, '..', 'lib', 'codex-pool.cjs'));

const APPLY = process.argv.includes('--apply');
const PROFILE = process.env.DSH_PROFILE_DIR || path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop');
const ROOT = path.join(PROFILE, 'agent-room-workspace', 'codex');
const NAME = 'agent-room';

async function main() {
  const pool = new CodexThreadPool({ cwd: ROOT, log: () => {}, projectName: NAME, projectRoot: ROOT });
  await pool.start();
  try {
    const listed = await pool.request('thread/list', { limit: 500 });
    const roomThreads = ((listed && listed.data) || []).filter((thread) => thread.originator === 'dsh-agent-room');
    console.log('ROOM THREADS', roomThreads.length);

    const before = await pool.request('project/list', { limit: 200 });
    const groups = ((before && before.data) || []).filter((project) => project.name === NAME);
    console.log('GROUPS named "' + NAME + '"', groups.map((project) => `${project.id}@${project.position} roots=${JSON.stringify(project.roots)}`).join(' ') || '(none)');
    const assigned = roomThreads.filter((thread) => thread.projectId).length;
    console.log('ASSIGNED', assigned, 'of', roomThreads.length);

    if (!APPLY) {
      console.log('DRY RUN — pass --apply to call pool.syncProject() for real');
      return;
    }
    const projectId = await pool.syncProject(roomThreads.map((thread) => thread.id));
    console.log('syncProject ->', projectId);

    const after = await pool.request('thread/list', { limit: 500 });
    const all = (after && after.data) || [];
    const inGroup = all.filter((thread) => thread.projectId === projectId);
    console.log('THREADS IN GROUP', inGroup.length, 'of', roomThreads.length);
    const groupsAfter = ((await pool.request('project/list', { limit: 200 })).data || []).filter((project) => project.name === NAME);
    console.log('GROUPS NOW', groupsAfter.map((project) => project.id).join(' ') || '(none)');
  } finally {
    await pool.stop();
  }
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exit(1);
});
