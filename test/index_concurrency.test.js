/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/index/concurrency.js - the HK2_INDEX_PARALLEL resolver
 * that drives the KB index parse-pool width.
 *
 * Semantics under test:
 *   - explicit `concurrency` arg wins over everything
 *   - HK2_INDEX_PARALLEL unset/empty/'0'/negative/non-numeric → auto (CPU count)
 *   - HK2_INDEX_PARALLEL = positive int N → N
 *   - result is always an integer >= 1
 *
 * Run:  node --test test/index_concurrency.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import { resolveIndexConcurrency } from '../lib/index/concurrency.js';

/* ---------------------- explicit concurrency override -------------------- */

test('explicit concurrency arg takes precedence over env', () => {
  const got = resolveIndexConcurrency({ concurrency: 3, env: { HK2_INDEX_PARALLEL: '99' }, cpus: () => 16 });
  assert.equal(got, 3);
});

test('explicit concurrency is floored and clamped to >= 1', () => {
  assert.equal(resolveIndexConcurrency({ concurrency: 5.9, env: {}, cpus: () => 8 }), 5);
  assert.equal(resolveIndexConcurrency({ concurrency: 0.4, env: {}, cpus: () => 8 }), 1);
});

test('non-positive / non-numeric explicit concurrency falls through to env', () => {
  // 0 / -2 / NaN / non-number are ignored, env then auto applies.
  assert.equal(resolveIndexConcurrency({ concurrency: 0, env: {}, cpus: () => 6 }), 6);
  assert.equal(resolveIndexConcurrency({ concurrency: -2, env: {}, cpus: () => 6 }), 6);
  assert.equal(resolveIndexConcurrency({ concurrency: NaN, env: {}, cpus: () => 6 }), 6);
  assert.equal(resolveIndexConcurrency({ concurrency: 'nope', env: {}, cpus: () => 6 }), 6);
});

/* ----------------------------- HK2_INDEX_PARALLEL ------------------------ */

test('HK2_INDEX_PARALLEL positive int is honored', () => {
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: '12' }, cpus: () => 4 }), 12);
});

test('HK2_INDEX_PARALLEL=1 (fully serial) is honored', () => {
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: '1' }, cpus: () => 32 }), 1);
});

test('HK2_INDEX_PARALLEL=0 means auto (CPU count)', () => {
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: '0' }, cpus: () => 16 }), 16);
});

test('HK2_INDEX_PARALLEL unset means auto (CPU count)', () => {
  assert.equal(resolveIndexConcurrency({ env: {}, cpus: () => 16 }), 16);
});

test('HK2_INDEX_PARALLEL empty string means auto', () => {
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: '' }, cpus: () => 8 }), 8);
});

test('HK2_INDEX_PARALLEL negative means auto', () => {
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: '-4' }, cpus: () => 8 }), 8);
});

test('HK2_INDEX_PARALLEL non-integer / garbage means auto', () => {
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: 'many' }, cpus: () => 8 }), 8);
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: '1e3' }, cpus: () => 8 }), 8);
  // Floats are not accepted: the variable is documented as a CPU count (integer).
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: '6.7' }, cpus: () => 8 }), 8);
  // Whitespace around a valid integer is tolerated.
  assert.equal(resolveIndexConcurrency({ env: { HK2_INDEX_PARALLEL: '  4  ' }, cpus: () => 8 }), 4);
});

/* -------------------------------- clamping ------------------------------- */

test('result is always an integer >= 1 even with a degenerate CPU probe', () => {
  assert.equal(resolveIndexConcurrency({ env: {}, cpus: () => 0 }), 1);
  assert.equal(resolveIndexConcurrency({ env: {}, cpus: () => -3 }), 1);
});

/* ------------------------- default (no injection) ------------------------ */

test('default resolution against the real process env / host', () => {
  const got = resolveIndexConcurrency();
  assert.ok(Number.isInteger(got), 'must be an integer');
  assert.ok(got >= 1, 'must be >= 1');
  // Auto mode should track the host parallelism (same family of probe).
  const expected = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  assert.equal(got, expected);
});
