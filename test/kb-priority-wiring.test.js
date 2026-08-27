/*-------------------------------------------------------------------------
 *
 * Regression tests for the Holy-over-Eden KB priority — wiring level.
 *
 * These pin the three fixes found by the regression audit:
 *
 *   P0. runAgentTurn used to reset session.kbConflicts = [] AFTER pass-1 /
 *       pass-2 graph retrieval populated it and BEFORE syncConflictingEden
 *       consumed it at end of turn — the end-of-turn Eden sync was a silent
 *       no-op in production. Unit tests couldn't catch it (they hand-fill
 *       session.kbConflicts). Fix: the reset moved to the TOP of the turn.
 *       Pinned here by (a) a source-order assertion on runAgentTurn's body,
 *       and (b) a behavioral test that mimics the reset ordering.
 *
 *   P1. An Eden entry already stamped supersededBy (by a previous turn's
 *       sync) re-entered retrieval every turn, re-triggering the conflict
 *       warning and the end-of-turn "synced" reminder forever. Fix:
 *       buildRequestGraph filters superseded Eden entries before matching.
 *
 *   P2. The end-of-turn [kb learn] fallback proposed NEW Holy entries with
 *       only (y/N) — no E option. Fix: y/N/E tri-state with Eden redirect.
 *
 * Run:  node --test test/kb-priority-wiring.test.js
 *----------------------------------------------------------------------*/
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequestGraph } from '../lib/agent/graph.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The turn pipeline moved out of interactive.js (M2 extraction): runTurn
// lives in turn.js, learnNewKnowledge in turn_support.js. The assertions
// themselves are unchanged — the bodies were moved verbatim.
const TURN = path.join(here, '..', 'src', 'commands', 'turn.js');
const TURN_SUPPORT = path.join(here, '..', 'src', 'commands', 'turn_support.js');

/* ── P0: source-order contract inside runTurn ─────────────────────
 *
 * The reset of session.kbConflicts must come BEFORE both assignments that
 * populate it from graph.conflicts (pass-1 and pass-2), and the end-of-turn
 * consumer (syncConflictingEden) must come after both. If anyone reintroduces
 * a reset between assignment and consumption, this test fails immediately.
 */
function runAgentTurnBody() {
  const src = fs.readFileSync(TURN, 'utf8');
  const start = src.indexOf('async function runTurn(');
  assert.ok(start >= 0, 'runAgentTurn found');
  // End at the next top-level function after runAgentTurn.
  const rest = src.slice(start + 10);
  const m = rest.match(/\n(?:export )?(?:async )?function /);
  const end = start + 10 + (m ? m.index : rest.length);
  return src.slice(start, end);
}

test('P0: kbConflicts reset happens at turn TOP, before graph retrieval populates it', () => {
  const body = runAgentTurnBody();
  const resetIdx = body.indexOf('session.kbConflicts = [];');
  assert.ok(resetIdx >= 0, 'reset statement present');
  // Pass-1 assigns directly from graph.conflicts; pass-2 merges into the
  // list (union by eden id) via pass2Conflicts — both must come AFTER the
  // turn-top reset, otherwise the detected conflicts would be wiped.
  const pass1Assign = body.indexOf('session.kbConflicts = graph.conflicts || [];');
  const pass2Merge = body.indexOf('const pass2Conflicts = graph.conflicts || [];');
  assert.ok(pass1Assign >= 0, 'pass-1 assignment present');
  assert.ok(pass2Merge >= 0, 'pass-2 merge present');
  assert.ok(pass1Assign > resetIdx, 'pass-1 assignment is after the turn-top reset');
  assert.ok(pass2Merge > resetIdx, 'pass-2 merge is after the turn-top reset');
  // The end-of-turn consumer must come after the reset too.
  const syncIdx = body.indexOf('await syncConflictingEden(session, ctx);');
  assert.ok(syncIdx > resetIdx, 'syncConflictingEden is after the reset');
});

test('P0: no second reset between graph assignment and end-of-turn sync', () => {
  const body = runAgentTurnBody();
  const assigns = [...body.matchAll(/session\.kbConflicts = graph\.conflicts \|\| \[\];/g)].map(m => m.index);
  const merges = [...body.matchAll(/const pass2Conflicts = graph\.conflicts \|\| \[\];/g)].map(m => m.index);
  const syncIdx = body.indexOf('await syncConflictingEden(session, ctx);');
  assert.ok(assigns.length >= 1 && merges.length === 1 && syncIdx > 0, 'assignment + merge + consumer located');
  const lastPopulate = Math.max(...assigns, ...merges);
  // Any 'session.kbConflicts = []' AFTER the last populate would wipe the
  // list before sync consumes it (the original P0 bug).
  const resets = [...body.matchAll(/session\.kbConflicts = \[\];/g)].map(m => m.index);
  for (const r of resets) {
    assert.ok(!(r > lastPopulate && r < syncIdx), 'no reset wipes conflicts between assignment and sync');
  }
});

test('P0: pass-2 MERGES conflicts instead of replacing (pass-1 promise preserved)', () => {
  const body = runAgentTurnBody();
  // The pass-2 block must union with the existing list, not overwrite it:
  // pass-1 already printed "will be marked superseded at the end of this task".
  assert.ok(body.includes('session.kbConflicts = [...prevConflicts];'),
    'pass-2 starts from the previous conflicts (union)');
  assert.ok(!/session\.kbConflicts = graph\.conflicts \|\| \[\];\s*\n\s*const newConflicts/.test(body),
    'pass-2 no longer overwrites the conflict list');
});

/* ── P1: superseded Eden entries retire from retrieval ───────────────── */
function mockRt({ holy = [], eden = [] } = {}) {
  return {
    name: 'priority-wiring-test',
    knowledgeBySpace: { holy, eden },
    allKnowledge: () => [...holy, ...eden],
    bm: { query: () => [] },
    callgraph: { byId: {} },
    graph: null,
    getSymbolById: () => null,
    getFilePath: () => null,
    reloadKnowledge: () => {},
  };
}

const HOLY = {
  id: 'wal-replay-loop',
  title: 'WAL replay loop',
  intro: 'Holy truth.',
  keywords: ['wal', 'replay', 'loop'],
};

test('P1: superseded Eden entry is excluded from retrieval AND from conflicts', async () => {
  const edenSuperseded = {
    id: 'wal-replay-notes',
    title: 'WAL replay loop notes',
    intro: 'Stale notes (already stamped).',
    keywords: ['wal', 'replay', 'loop'],
    supersededBy: 'holy:wal-replay-loop',   // stamped by a previous sync
  };
  const graph = await buildRequestGraph(mockRt({ holy: [HOLY], eden: [edenSuperseded] }),
    'how does the wal replay loop work');
  assert.equal(graph.conflicts.length, 0, 'stamped entry does not re-trigger a conflict');
  assert.ok(!graph.knowledge.some(k => k.id === 'wal-replay-notes'), 'stamped entry not injected');
  assert.ok(graph.knowledge.some(k => k.id === 'wal-replay-loop'), 'Holy entry still injected');
});

test('P1: un-stamped conflicting Eden entry still suppressed normally (no behavior change)', async () => {
  const edenDup = {
    id: 'wal-replay-notes',
    title: 'WAL replay loop notes',
    intro: 'Stale notes (not yet stamped).',
    keywords: ['wal', 'replay', 'loop'],
  };
  const graph = await buildRequestGraph(mockRt({ holy: [HOLY], eden: [edenDup] }),
    'how does the wal replay loop work');
  assert.equal(graph.conflicts.length, 1, 'fresh conflict still detected');
  assert.equal(graph.conflicts[0].eden.id, 'wal-replay-notes');
});

/* ── P2: [kb learn] NEW Holy proposal offers y/N/E ───────────────────── */
function learnSource() {
  return fs.readFileSync(TURN_SUPPORT, 'utf8');
}

test('P2: learnNewKnowledge offers the E option for NEW Holy proposals', () => {
  const src = learnSource();
  const start = src.indexOf('async function learnNewKnowledge(');
  assert.ok(start >= 0, 'learnNewKnowledge located');
  const rest = src.slice(start + 10);
  const m = rest.match(/\n(?:export )?(?:async )?function /);
  const body = src.slice(start, start + 10 + (m ? m.index : rest.length));
  assert.ok(body.includes('confirmThreeWay'), 'tri-state prompt wired');
  assert.ok(/\(y\/N\/E\)/.test(body), 'prompt shows (y/N/E)');
  assert.ok(body.includes("answer === 'eden'"), 'eden redirect branch present');
  assert.ok(body.includes("record.space = 'eden'"), 'record space stays consistent after redirect');
  assert.ok(/\(y\/N\)/.test(body), 'update path keeps (y/N)');
});
