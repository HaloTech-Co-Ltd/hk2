/*-------------------------------------------------------------------------
 *
 * Unit tests for the LLM-driven complexity gate (lib/agent/plan.js).
 *
 * Covers the two-tier decision:
 *   1. isObviouslyTrivial() - cheap synchronous pre-filter (no LLM).
 *   2. assessComplexity()    - LLM call that classifies the task, with a
 *      regex fallback when the LLM errors / is unavailable.
 *
 * The headline requirement these guard: a routine chained workflow like
 * "git add -A then git commit then git push" must be classified SIMPLE by the
 * LLM gate, even though the legacy regex heuristic (which keys on "then")
 * would have wrongly forced plan mode.
 *
 * Run:  node --test test/plan-complexity.test.js
 * ----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import {
  isObviouslyTrivial,
  needsPlanning,
  assessComplexity,
} from '../lib/agent/plan.js';

/* --------------------- tiny LLM mock helper ----------------------------- */

/**
 * Build a fake LLM client whose stream() yields a single delta then ends.
 * Mirrors the real client's async-generator stream() contract used by callLlm.
 */
function mockLlm(reply) {
  return {
    async *stream(_messages, _opts) {
      yield { type: 'delta', text: reply };
    },
  };
}

/** Fake LLM whose stream() always throws. */
function throwingLlm(err) {
  return {
    async *stream() {
      throw err instanceof Error ? err : new Error(String(err));
    },
  };
}

/* ----------------------- isObviouslyTrivial ----------------------------- */

test('isObviouslyTrivial: empty / whitespace / greetings are trivial', () => {
  assert.equal(isObviouslyTrivial(''), true);
  assert.equal(isObviouslyTrivial('   \t\n  '), true);
  assert.equal(isObviouslyTrivial('hi'), true);
  assert.equal(isObviouslyTrivial('hello there'), true);
  assert.equal(isObviouslyTrivial('thanks!'), true);
  assert.equal(isObviouslyTrivial('quit'), true);
  assert.equal(isObviouslyTrivial('what does this do'), true);
});

test('isObviouslyTrivial: short single reads / questions are trivial', () => {
  assert.equal(isObviouslyTrivial('read the file foo'), true);
  assert.equal(isObviouslyTrivial('show me src/index.js'), true);
  assert.equal(isObviouslyTrivial('how do I configure the model'), true);
});

test('isObviouslyTrivial: terse input with a strong action verb is NOT trivial', () => {
  // Even very short, a verb like implement/refactor signals non-trivial work,
  // so we must NOT short-circuit - proceed to LLM assessment.
  assert.equal(isObviouslyTrivial('refactor everything'), false);
  assert.equal(isObviouslyTrivial('implement that now'), false);
});

test('isObviouslyTrivial: chained git workflow is NOT obviously trivial', () => {
  // This is the headline bug: the LLM (not regex) must decide. isObviouslyTrivial
  // is deliberately conservative and defers it to the assessment.
  const gitTask = 'git add -A then git commit with a message, after that git push';
  assert.equal(isObviouslyTrivial(gitTask), false);
});

/* ---------------------- needsPlanning (fallback) ------------------------ */
// Legacy regex heuristic is retained ONLY as the fallback. Sanity-check it
// still behaves, especially the known false positive that motivated the
// LLM gate: the chained git workflow.

test('needsPlanning (fallback regex): still flags the git workflow as complex', () => {
  // Documents WHY the regex is not the primary gate: "then" triggers it.
  const gitTask = 'git add -A then git commit with a message, after that git push';
  assert.equal(needsPlanning(gitTask), true);
});

/* ------------------------- assessComplexity ----------------------------- */

test('assessComplexity: obviously-trivial input skips the LLM (source: trivial)', async () => {
  let calls = 0;
  const llm = { async *stream() { calls++; yield { type: 'delta', text: '{"complex":true}' }; } };
  const r = await assessComplexity(llm, 'hi');
  assert.equal(r.complex, false);
  assert.equal(r.source, 'trivial');
  assert.equal(calls, 0, 'LLM must not be called for obviously-trivial input');
});

test('assessComplexity: LLM classifies a chained git workflow as SIMPLE', async () => {
  // The fix for the reported issue: the model understands intent.
  const llm = mockLlm('{"complex": false, "reason": "routine chained git workflow"}');
  const gitTask = 'git add -A then git commit with a message, after that git push';
  const r = await assessComplexity(llm, gitTask);
  assert.equal(r.complex, false);
  assert.equal(r.source, 'llm');
  assert.match(r.reason, /git/i);
});

test('assessComplexity: LLM classifies a refactor task as COMPLEX', async () => {
  const llm = mockLlm('{"complex": true, "reason": "multi-file refactor with design choices"}');
  const r = await assessComplexity(llm, 'refactor the auth module into smaller pieces');
  assert.equal(r.complex, true);
  assert.equal(r.source, 'llm');
});

test('assessComplexity: tolerates ```json fenced output', async () => {
  const llm = mockLlm('```json\n{"complex": true, "reason": "fenced"}\n```');
  const r = await assessComplexity(llm, 'migrate the config from yaml to toml');
  assert.equal(r.complex, true);
  assert.equal(r.source, 'llm');
});

test('assessComplexity: tolerates string-typed complex field', async () => {
  const llm = mockLlm('{"complex": "false", "reason": "string boolean"}');
  const r = await assessComplexity(llm, 'some mid-length task with no obvious signal here');
  assert.equal(r.complex, false);
  assert.equal(r.source, 'llm');
});

test('assessComplexity: unparseable LLM response -> conservative regex fallback', async () => {
  const llm = mockLlm('the task is simple');  // not JSON
  // A task the regex heuristic flags complex (multi-file) -> fallback must
  // surface that verdict rather than silently treating it as simple.
  const r = await assessComplexity(llm, 'update src/a.js and lib/b.js to share the helper');
  assert.equal(r.source, 'fallback');
  assert.equal(r.complex, true);
});

test('assessComplexity: LLM error -> regex fallback (user never blocked)', async () => {
  const llm = throwingLlm('network down');
  // Refactor verb -> regex fallback says complex.
  const r = await assessComplexity(llm, 'refactor the auth module into smaller pieces');
  assert.equal(r.source, 'fallback');
  assert.equal(r.complex, true);
  assert.match(r.reason, /fallback/i);
});

test('assessComplexity: no LLM at all -> regex fallback', async () => {
  const r = await assessComplexity(null, 'hi');
  // 'hi' is obviously trivial -> tier-1 short-circuit, no llm needed.
  assert.equal(r.source, 'trivial');
  assert.equal(r.complex, false);

  // A genuinely complex-looking input with no llm -> regex fallback.
  const r2 = await assessComplexity(null, 'refactor the auth module into smaller pieces');
  assert.equal(r2.source, 'fallback');
  assert.equal(r2.complex, true);
});

test('assessComplexity: abort signal propagates (ESC during assessment)', async () => {
  const llm = throwingLlm(new Error('should not matter'));
  const ctrl = new AbortController();
  ctrl.abort(new Error('interrupted by user (ESC)'));
  await assert.rejects(
    () => assessComplexity(llm, 'refactor the auth module into smaller pieces', { signal: ctrl.signal }),
    /interrupted/i
  );
});
