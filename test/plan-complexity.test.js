/*-------------------------------------------------------------------------
 *
 * Unit tests for the lightweight complexity heuristics (lib/agent/plan.js).
 *
 * hk2 no longer runs a separate pre-execution complexity-assessment pass:
 * planning is now LLM-driven (the system prompt instructs the agent to call
 * the `plan` tool when it decides a task is complex enough to need a
 * user-confirmed plan). These tests cover the two cheap, dependency-free
 * regex heuristics that remain as reference / fallback helpers:
 *   1. isObviouslyTrivial() - synchronous pre-filter for definite-simple tasks.
 *   2. needsPlanning()      - legacy regex heuristic (multi-step / multi-file).
 *
 * The headline requirement these guard: a routine chained workflow like
 * "git add -A then git commit then git push" is NOT obviously trivial
 * (isObviouslyTrivial defers it), even though the regex heuristic
 * (needsPlanning, which keys on "then") would flag it as complex. The real
 * triage decision is now the LLM\'s, not the regex\'s.
 *
 * Run:  node --test test/plan-complexity.test.js
 * ----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import {
  isObviouslyTrivial,
  needsPlanning,
} from '../lib/agent/plan.js';

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
  // so we must NOT short-circuit - defer to the (LLM) decision.
  assert.equal(isObviouslyTrivial('refactor everything'), false);
  assert.equal(isObviouslyTrivial('implement that now'), false);
});

test('isObviouslyTrivial: chained git workflow is NOT obviously trivial', () => {
  // The regex cannot understand intent; isObviouslyTrivial is deliberately
  // conservative and defers it. The LLM (via the system prompt) decides.
  const gitTask = 'git add -A then git commit with a message, after that git push';
  assert.equal(isObviouslyTrivial(gitTask), false);
});

/* ---------------------- needsPlanning (heuristic) ----------------------- */
// The regex heuristic is retained as a cheap reference / fallback. Sanity-check
// it still behaves, especially the known false positive that motivated making
// the LLM (not regex) the real decision-maker: the chained git workflow.

test('needsPlanning (regex): still flags the git workflow as complex', () => {
  // Documents WHY the regex is not the decision-maker: "then" triggers it.
  const gitTask = 'git add -A then git commit with a message, after that git push';
  assert.equal(needsPlanning(gitTask), true);
});
