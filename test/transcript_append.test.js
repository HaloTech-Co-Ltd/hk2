/*-------------------------------------------------------------------------
 * Regression test: Transcript.append must APPEND, never replace.
 *
 * History: Transcript._init/append used writeFileAtomic (write tmp → rename
 * over target), so every append clobbered the whole transcript down to its
 * last line. On disk this meant each session file held exactly ONE record —
 * which is why the v2 KB stats work (commit 212c256) found "0 kb-stats
 * records" in every audited transcript even after moving the logMeta call
 * out of the render try/catch: the persistence bug was one layer below, in
 * the writer itself.
 *
 * This suite pins three behaviors:
 *   1. append() accumulates lines (fresh session).
 *   2. Resuming with the same sessionId does NOT truncate prior history.
 *   3. Concurrent un-awaited appends all land (serialized via _tail).
 *
 * Run:  node --test test/transcript_append.test.js
 * ----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { Transcript } from '../lib/agent/transcript.js';

async function readLines(p) {
  const txt = await fs.readFile(p, 'utf8');
  return txt.split('\n').filter((l) => l.trim().length > 0);
}

test('append accumulates lines: a fresh session keeps every event', async () => {
  const t = new Transcript('test-transcript-regression', 'append-' + Date.now());
  await t.logUser('first user turn');
  await t.logToolCall({ id: 'c1', name: 'kb_search', arguments: '{}' }, { ok: true, result: { count: 1 } });
  await t.logMeta('kb-stats', { kbCalls: 1, fallbackCalls: 0, hitRate: 1 });
  await t.logTurn(1, 2);

  const lines = await readLines(t.path);
  assert.equal(lines.length, 5, `expected 5 records (session_start + 4 events), got ${lines.length}`);
  const types = lines.map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ['session_start', 'user', 'tool_call', 'meta', 'turn_end']);
  const meta = JSON.parse(lines[3]);
  assert.equal(meta.key, 'kb-stats');
  assert.equal(meta.value.kbCalls, 1);
});

test('resume with the same sessionId appends after prior history', async () => {
  const sid = 'resume-' + Date.now();
  const first = new Transcript('test-transcript-regression', sid);
  await first.logUser('turn from the original process');
  const linesBefore = (await readLines(first.path)).length;
  assert.ok(linesBefore >= 2, 'original process must have written history first');

  // Simulate /resume: a NEW Transcript instance reusing the same sessionId.
  // _init always emits a session_start marker (fresh ts = resume point), then
  // subsequent events append after the prior history.
  const resumed = new Transcript('test-transcript-regression', sid);
  await resumed.logUser('turn from the resumed process');

  const lines = await readLines(resumed.path);
  assert.equal(lines.length, linesBefore + 2, 'resume must append (session_start + user), not truncate');
  // Prior history survives.
  assert.equal(JSON.parse(lines[0]).type, 'session_start');
  assert.equal(JSON.parse(lines[1]).text, 'turn from the original process');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.type, 'user');
  assert.equal(last.text, 'turn from the resumed process');
});

test('concurrent un-awaited appends all land as whole lines', async () => {
  const t = new Transcript('test-transcript-regression', 'concurrent-' + Date.now());
  await t.logUser('seed'); // ensure _init finished before the burst

  // Fire 20 appends without awaiting, like onToolCallEnd does mid-loop.
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    jobs.push(t.logMeta('burst', { i }));
  }
  await Promise.all(jobs);

  const lines = await readLines(t.path);
  // session_start + seed user + 20 burst records
  assert.equal(lines.length, 22, `expected 22 records after burst, got ${lines.length}`);
  for (const l of lines) {
    // every line must be standalone-valid JSON (no interleaving corruption)
    const rec = JSON.parse(l);
    assert.ok(rec.ts && rec.type, 'record must carry ts and type');
  }
  const burstIdx = lines
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === 'meta' && r.key === 'burst')
    .map((r) => r.value.i);
  assert.deepEqual(burstIdx.sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
});
