/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/graph/builder.js - the knowledge-graph builder.
 *
 * Regression coverage for the post-index build phases:
 *   - contains edges derived from symbol.parentSymbolId (this used to
 *     `symbols.find(s => s.id === node.symbolId.slice(1))`, which was both
 *     O(N^2) and sliced the wrong id, silently dropping most contains edges)
 *   - calls resolution priority: same file > same directory > first candidate
 *
 * Run:  node --test test/graph_builder.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { buildKnowledgeGraph } from '../lib/graph/builder.js';

function sym(id, overrides = {}) {
  return {
    id,
    name: id,
    kind: 'function',
    fileId: 1,
    lineStart: 1,
    lineEnd: 1,
    signature: '',
    body: '',
    references: [],
    qualName: id,
    parentSymbolId: null,
    ...overrides,
  };
}

test('contains edges are derived from parentSymbolId', () => {
  const symbols = [
    sym('1:10', { name: 'Container', kind: 'struct' }),
    sym('1:20', { name: 'field', kind: 'field', parentSymbolId: '1:10' }),
    sym('1:30', { name: 'method', kind: 'method', parentSymbolId: '1:10' }),
  ];
  const graph = buildKnowledgeGraph(symbols, { 1: { path: 'a.c' } });

  assert.equal(graph.nodes.size, 3);
  assert.deepEqual(
    [...graph.edges.contains['g1:10']].sort(),
    ['g1:20', 'g1:30'],
  );
});

test('calls resolve to a same-file symbol first', () => {
  const symbols = [
    sym('1:10', { name: 'foo', fileId: 1 }),
    sym('1:20', { name: 'caller', fileId: 1, references: ['foo'] }),
    sym('2:10', { name: 'foo', fileId: 2 }),
  ];
  const graph = buildKnowledgeGraph(symbols, {
    1: { path: 'src/a.c' },
    2: { path: 'src/b.c' },
  });

  assert.deepEqual(graph.edges.calls['g1:20'], ['g1:10']);
});

test('calls fall back to a same-directory symbol, then first candidate', () => {
  const symbols = [
    sym('1:10', { name: 'foo', fileId: 1 }),
    sym('4:10', { name: 'foo', fileId: 4 }),
    sym('2:20', { name: 'caller', fileId: 2, references: ['foo'] }),
  ];
  const graph = buildKnowledgeGraph(symbols, {
    1: { path: 'src/a.c' },
    2: { path: 'src/b.c' },
    4: { path: 'other/d.c' },
  });

  // caller (src/b.c) has no same-file foo; prefers src/a.c over other/d.c.
  assert.deepEqual(graph.edges.calls['g2:20'], ['g1:10']);
});

// Regression for the post-"collected N symbols" hang. The old contains-edge
// loop did `symbols.find(s => s.id === node.symbolId.slice(1))` for every
// node — O(N^2). With N=20000 that was ~400M string comparisons and would
// take many seconds; the fixed linear lookup finishes well under a second.
// We assert the builder is effectively linear here so this never regresses.
test('large parent/child graph builds in linear time (no O(N^2) scan)', () => {
  const N = 20000;
  const symbols = [];
  for (let i = 1; i <= N; i++) {
    const containerId = `${i}:1`;
    symbols.push(sym(containerId, { name: `Container${i}`, kind: 'struct' }));
    symbols.push(sym(`${i}:2`, {
      name: `field${i}`, kind: 'field', parentSymbolId: containerId,
    }));
  }
  const files = {};
  for (let i = 1; i <= N; i++) files[i] = { path: `f${i}.c` };

  const t0 = Date.now();
  const graph = buildKnowledgeGraph(symbols, files);
  const ms = Date.now() - t0;

  assert.equal(graph.nodes.size, N * 2);
  // Every container has exactly one child member.
  let containsEdges = 0;
  for (const lst of Object.values(graph.edges.contains)) containsEdges += lst.length;
  assert.equal(containsEdges, N);
  // Linear: 40k symbols must finish comfortably under 2s (the O(N^2) version
  // blew well past this). Generous ceiling to avoid CI flakiness.
  assert.ok(ms < 2000, `build took ${ms}ms for ${N * 2} symbols — expected linear`);
});
