/*-------------------------------------------------------------------------
 *
 * Unit tests for the complexity gating that decides whether a task enters
 * interactive plan mode (lib/agent/plan.js :: needsPlanning).
 *
 * Run:  node --test test/plan-gating.test.js
 * ----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { needsPlanning } from '../lib/agent/plan.js';

/* ----------------------------- simple tasks ----------------------------- */

const SIMPLE = [
  ['empty string', ''],
  ['whitespace only', '   \t\n  '],
  ['greeting', 'hi'],
  ['greeting long', 'hello there'],
  ['thanks', 'thanks!'],
  ['single word', 'status'],
  ['tiny read', 'read file foo'],
  ['short question', 'what does this function do'],
  ['short question 2', 'how do I configure the model'],
  ['short where', "where's the config file"],
  ['help', 'can you help me'],
  ['exit', 'quit'],
  ['explain one thing', 'explain how this works'],
  ['single file read', 'show me src/index.js'],
  ['short list cmd', 'list the files'],
  ['version', 'what version is this'],
];

test('simple tasks do NOT need planning', () => {
  for (const [name, input] of SIMPLE) {
    assert.equal(
      needsPlanning(input),
      false,
      `expected simple for: ${name} -> "${input}"`
    );
  }
});

/* ---------------------------- complex tasks ----------------------------- */

const COMPLEX = [
  ['sequencing then', 'read the file then fix the bug then add a test'],
  ['sequencing first', 'first, set up the db, then run migrations'],
  ['multi-file', 'update src/a.js and lib/b.js to share the helper'],
  ['refactor verb', 'refactor the auth module into smaller pieces'],
  ['implement verb', 'implement a new caching layer for the API'],
  ['migrate verb', 'migrate the config from yaml to toml'],
  ['add a feature', 'add a feature to export reports as pdf'],
  ['build a system', 'build a system to sync data between two dbs'],
  ['numbered list', '1. do this\n2. then that\n3. and finally this'],
  ['bulleted list', '- step one\n- step two\n- step three'],
  ['long prose', 'I want to overhaul the way we handle user sessions, the current approach has a lot of problems with concurrency and we should redesign it to use a token rotation strategy with a refresh mechanism and proper invalidation'],
  ['two file extensions', 'fix the bug in server.js and also update utils.ts'],
];

test('complex tasks DO need planning', () => {
  for (const [name, input] of COMPLEX) {
    assert.equal(
      needsPlanning(input),
      true,
      `expected complex for: ${name} -> "${input}"`
    );
  }
});

/* ----------------------------- edge cases ------------------------------- */

test('ambiguous mid-length default is to plan (conservative)', () => {
  // 13 words, no clear complex/trivial signal -> ambiguous -> plan.
  const s = 'please look at the thing and make sure it is working as intended now';
  assert.equal(needsPlanning(s), true);
});

test('returns false for null / undefined input', () => {
  assert.equal(needsPlanning(null), false);
  assert.equal(needsPlanning(undefined), false);
});

test('single file mention is not enough to be complex', () => {
  // One file + short + trivial intent -> simple.
  assert.equal(needsPlanning('read src/index.js'), false);
  assert.equal(needsPlanning('show me lib/agent/plan.js'), false);
});

test('complex verb in a tiny task still triggers planning (conservative)', () => {
  // Even very short inputs with a strong action verb (implement/refactor/...)
  // are treated as complex: the verb signals non-trivial work regardless of
  // length. Length-based short-circuits only apply when no complex signal is
  // present.
  assert.equal(needsPlanning('implement that now please'), true);
  assert.equal(needsPlanning('refactor everything'), true);
});

test('list detection works with asterisk and plus bullets', () => {
  assert.equal(needsPlanning('* item a\n* item b'), true);
  assert.equal(needsPlanning('+ one\n+ two\n+ three'), true);
});

test('gating constants are internally consistent', () => {
  // The simple/complex word thresholds must not overlap in a way that makes
  // the function self-contradictory. Tiny < simple <= complex-elsewhere.
  // This guards against accidental reordering of the thresholds.
  const tiny = 'a b c d e f'; // 6 words -> SIMPLE_WORD_MAX_TINY
  const words = tiny.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 6, 'sanity: tiny fixture has <=6 words');
  assert.equal(needsPlanning(tiny), false, '6-word input is simple');
});
