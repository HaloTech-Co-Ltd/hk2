/*-------------------------------------------------------------------------
 *
 * Unit tests for the end-of-task Eden sync (Holy-over-Eden priority):
 *
 *   syncConflictingEden stamps every conflicting Eden entry with
 *   supersededBy=holy:<id> + a supersession notice in its intro, reloads
 *   it into the runtime, prints a reminder, and clears the conflict list.
 *   It must be idempotent and must not touch Holy entries.
 *
 * Run:  node --test test/kb-priority-sync.test.js
 *----------------------------------------------------------------------*/
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createSession, syncConflictingEden } from '../src/commands/interactive.js';
import { writeKnowledge, readKnowledge } from '../lib/store/kb_store.js';

const PROJECT_ID = 'kb-priority-sync-test';

function mockCtx() {
  const lines = [];
  return { lines, print: (s) => lines.push(s), confirm: async () => false };
}

function mockSession(conflicts) {
  const s = createSession();
  s.project = { id: PROJECT_ID, name: PROJECT_ID, sourcePath: '/tmp/x' };
  s.kbConflicts = conflicts;
  const reloaded = [];
  s.rt = { reloadKnowledge: (entry, space) => reloaded.push({ entry, space }) };
  s._reloaded = reloaded;
  return s;
}

test.before(async () => {
  // Seed one Holy entry and one conflicting Eden entry on disk.
  await writeKnowledge(PROJECT_ID, 'holy', {
    id: 'wal-replay-loop',
    title: 'WAL replay loop',
    intro: 'The canonical description.',
    keywords: ['wal', 'replay', 'loop'],
  });
  await writeKnowledge(PROJECT_ID, 'eden', {
    id: 'wal-replay-notes',
    title: 'WAL replay loop notes',
    intro: 'Stale Eden notes.',
    keywords: ['wal', 'replay', 'loop'],
  });
});

test('sync stamps supersededBy, prepends notice, reloads, prints reminder', async () => {
  const session = mockSession([{
    eden: { id: 'wal-replay-notes', title: 'WAL replay loop notes' },
    holy: { id: 'wal-replay-loop', title: 'WAL replay loop' },
  }]);
  const ctx = mockCtx();
  await syncConflictingEden(session, ctx);

  const onDisk = await readKnowledge(PROJECT_ID, 'eden', 'wal-replay-notes');
  assert.ok(onDisk, 'eden entry still on disk (marked, not deleted)');
  assert.equal(onDisk.supersededBy, 'holy:wal-replay-loop');
  assert.ok(onDisk.supersededAt, 'supersededAt timestamp set');
  assert.match(onDisk.intro, /^\[Superseded by holy:wal-replay-loop/);
  assert.match(onDisk.intro, /Stale Eden notes\./);

  // Holy untouched
  const holy = await readKnowledge(PROJECT_ID, 'holy', 'wal-replay-loop');
  assert.ok(!holy.supersededBy, 'holy entry must not be stamped');

  // Runtime reloaded + reminder printed + conflicts cleared
  assert.equal(session._reloaded.length, 1);
  assert.equal(session._reloaded[0].space, 'eden');
  assert.ok(ctx.lines.some(l => l.includes('synced 1 Eden entry superseded by Holy')), `expected reminder, got: ${ctx.lines.join('|')}`);
  assert.deepEqual(session.kbConflicts, []);
});

test('sync is idempotent (re-running does not stack notices)', async () => {
  const session = mockSession([{
    eden: { id: 'wal-replay-notes', title: 'WAL replay loop notes' },
    holy: { id: 'wal-replay-loop', title: 'WAL replay loop' },
  }]);
  await syncConflictingEden(session, mockCtx());
  // Simulate the same conflict being detected again next turn.
  session.kbConflicts = [{
    eden: { id: 'wal-replay-notes', title: 'WAL replay loop notes' },
    holy: { id: 'wal-replay-loop', title: 'WAL replay loop' },
  }];
  await syncConflictingEden(session, mockCtx());
  const onDisk = await readKnowledge(PROJECT_ID, 'eden', 'wal-replay-notes');
  const notices = (onDisk.intro.match(/\[Superseded by holy:/g) || []).length;
  assert.equal(notices, 1, 'only one supersession notice, no stacking');
});

test('no conflicts -> no-op, nothing printed', async () => {
  const session = mockSession([]);
  const ctx = mockCtx();
  await syncConflictingEden(session, ctx);
  assert.equal(ctx.lines.length, 0);
});

test('missing eden entry on disk (deleted/moved) is skipped silently', async () => {
  const session = mockSession([{
    eden: { id: 'gone-entry', title: 'Gone' },
    holy: { id: 'wal-replay-loop', title: 'WAL replay loop' },
  }]);
  const ctx = mockCtx();
  await syncConflictingEden(session, ctx);
  assert.ok(!ctx.lines.some(l => l.includes('synced')), 'nothing synced for a vanished entry');
});
