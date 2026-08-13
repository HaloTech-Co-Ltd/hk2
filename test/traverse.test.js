/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/graph/traverse.js - the pure, side-effect-free BFS /
 * call-chain helpers that the KB runtime layer loads the on-disk JSON into.
 *
 * All functions are read-only over the supplied adjacency maps, so the tests
 * build small in-memory graphs and assert the traversal shape directly.
 *
 * Run:  node --test test/traverse.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { bfsForward, bfsBackward, buildReverse, callChain } from '../lib/graph/traverse.js';

/* A diamond: a -> b,c ; b -> d ; c -> d ; d -> e
 *   a
 *  / \
 * b   c
 *  \ / \
 *   d   e
 */
const FWD = {
  a: ['b', 'c'],
  b: ['d'],
  c: ['d', 'e'],
  d: ['e'],
  e: [],
};
const REV = buildReverse(FWD);

test('buildReverse inverts forward adjacency and de-duplicates', () => {
  const rev = buildReverse(FWD);
  assert.deepEqual(rev.d.sort(), ['b', 'c']);
  assert.deepEqual(rev.e.sort(), ['c', 'd']);
  // sources with no incoming edges are absent.
  assert.ok(!('a' in rev));
});

test('buildReverse is a no-op for duplicate edges (does not double-list a src)', () => {
  const rev = buildReverse({ x: ['y', 'y'], y: [] });
  assert.deepEqual(rev.y, ['x']);
});

test('bfsForward visits start + reachable nodes within maxDepth', () => {
  const { nodes, layers } = bfsForward('a', FWD, { maxDepth: 2 });
  // layer 0: a ; layer 1: b,c ; layer 2: d (via b/c) and e (via c, depth-2 edge)
  assert.deepEqual(layers[0], ['a']);
  assert.deepEqual(layers[1].sort(), ['b', 'c']);
  assert.ok(layers[2].includes('d'));
  assert.ok(nodes.has('e'), 'e is reachable at depth 2 via a->c->e');
});

test('bfsForward respects maxNodes cap (stops once visited reaches the cap)', () => {
  // cap at 3: a + b + c (or a + b + d, depending on order) -> e never reached.
  const { nodes } = bfsForward('a', FWD, { maxDepth: 5, maxNodes: 3 });
  assert.ok(nodes.size <= 3, `capped at 3, got ${nodes.size}`);
  assert.ok(nodes.has('a'));
});

test('bfsForward handles a start with no outgoing edges', () => {
  const { nodes, layers } = bfsForward('e', FWD);
  assert.deepEqual(layers, [['e']]);
  assert.equal(nodes.size, 1);
});

test('bfsForward terminates on a cycle (no infinite loop)', () => {
  const cyclic = { a: ['b'], b: ['c'], c: ['a'] };
  const { nodes } = bfsForward('a', cyclic, { maxDepth: 10 });
  assert.equal(nodes.size, 3);
  assert.ok(nodes.has('a') && nodes.has('b') && nodes.has('c'));
});

test('bfsForward ignores edges to unknown destinations (sparse map)', () => {
  const sparse = { a: ['b', 'ghost'] };
  const { nodes } = bfsForward('a', sparse, { maxDepth: 2 });
  assert.ok(nodes.has('b'));
  // 'ghost' has no entry; it is still visited (it was referenced) but contributes
  // no further edges. The key invariant: no throw, and the known node is found.
  assert.equal(nodes.size, 3);
});

test('bfsBackward walks the reverse map from a leaf to its callers', () => {
  const { nodes } = bfsBackward('e', REV);
  assert.ok(nodes.has('e'));
  assert.ok(nodes.has('c') || nodes.has('d'), 'reached at least one caller of e');
});

test('callChain returns both forward and backward node sets', () => {
  const { forward, backward } = callChain('d', FWD, REV, { maxDepth: 3 });
  // forward from d: d, e
  assert.ok(forward.has('d') && forward.has('e'));
  // backward from d: d, b, c, a
  assert.ok(backward.has('d') && backward.has('a'));
});

test('callChain defaults are applied when opts omitted', () => {
  const { forward, backward } = callChain('a', FWD, REV);
  assert.ok(forward.has('a'));
  assert.ok(backward.has('a'));
});
