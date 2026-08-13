/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/index/bm25.js - the in-memory BM25 inverted index used
 * by the KB code-search pipeline. addDoc/query/removeDoc/serialize/deserialize.
 *
 * Run:  node --test test/bm25.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { BM25Index } from '../lib/index/bm25.js';

function buildIdx() {
  const idx = new BM25Index();
  idx.addDoc('sym:1', ['parse', 'tree', 'node']);
  idx.addDoc('sym:2', ['token', 'lexer', 'scan']);
  idx.addDoc('sym:3', ['parse', 'error', 'recover']);
  idx.finalize();
  return idx;
}

test('addDoc records term frequencies and doc length', () => {
  const idx = new BM25Index();
  idx.addDoc('s1', ['a', 'a', 'b']);
  assert.equal(idx.N, 1);
  assert.equal(idx.docLen.get('s1'), 3);
  // tf of 'a' is 2.
  assert.equal(idx.postings.get('a').get('s1'), 2);
  assert.equal(idx.df.get('a'), 1);
});

test('addDoc ignores empty tokens (no empty doc created)', () => {
  const idx = new BM25Index();
  idx.addDoc('s1', []);
  assert.equal(idx.N, 0);
  assert.ok(!idx.docLen.has('s1'));
});

test('addDoc ignores a missing symbolId', () => {
  const idx = new BM25Index();
  idx.addDoc(null, ['a']);
  idx.addDoc('', ['a']);
  assert.equal(idx.N, 0);
});

test('finalize computes avgdl over all docs', () => {
  const idx = new BM25Index();
  idx.addDoc('s1', ['a', 'b']);
  idx.addDoc('s2', ['a', 'b', 'c', 'd']);
  idx.finalize();
  assert.equal(idx.N, 2);
  assert.equal(idx.avgdl, 3); // (2 + 4) / 2
});

test('finalize on an empty index yields avgdl 0', () => {
  const idx = new BM25Index();
  idx.finalize();
  assert.equal(idx.avgdl, 0);
  assert.equal(idx.N, 0);
});

test('query returns [] on an empty index or empty query', () => {
  const idx = new BM25Index();
  idx.finalize();
  assert.deepEqual(idx.query(['anything']), []);
  const idx2 = buildIdx();
  assert.deepEqual(idx2.query([]), []);
});

test('query ranks the document containing the rarest term higher', () => {
  const idx = buildIdx();
  // 'parse' appears in sym:1 and sym:3 (df=2); 'tree' only in sym:1 (df=1).
  // A query for ['parse', 'tree'] should rank sym:1 first (it has both).
  const res = idx.query(['parse', 'tree']);
  assert.ok(res.length >= 1);
  assert.equal(res[0].symbolId, 'sym:1');
});

test('query de-duplicates repeated query tokens', () => {
  const idx = buildIdx();
  const once = idx.query(['parse']);
  const repeated = idx.query(['parse', 'parse', 'parse']);
  // Repeating the same token must not inflate the score (dedup by token).
  assert.equal(once[0].score, repeated[0].score);
});

test('query respects topK and returns at most topK results', () => {
  const idx = buildIdx();
  const res = idx.query(['parse'], { topK: 1 });
  assert.ok(res.length <= 1);
});

test('query honors restrictTo allow-list', () => {
  const idx = buildIdx();
  const res = idx.query(['parse'], { restrictTo: new Set(['sym:3']) });
  assert.ok(res.every(r => r.symbolId === 'sym:3'));
});

test('query returns scores in descending order', () => {
  const idx = buildIdx();
  const res = idx.query(['parse'], { topK: 10 });
  for (let i = 1; i < res.length; i++) {
    assert.ok(res[i - 1].score >= res[i].score, 'scores must be non-increasing');
  }
});

test('removeDoc drops the document and updates df', () => {
  const idx = buildIdx();
  idx.removeDoc('sym:1');
  assert.equal(idx.N, 2);
  assert.ok(!idx.docLen.has('sym:1'));
  // 'tree' only appeared in sym:1, so its df should fall to 0 and be pruned.
  assert.ok(!idx.df.has('tree'));
  assert.ok(!idx.postings.has('tree'));
  // 'parse' still appears in sym:3 -> df 1.
  assert.equal(idx.df.get('parse'), 1);
});

test('removeDoc is a no-op for an unknown symbolId', () => {
  const idx = buildIdx();
  const nBefore = idx.N;
  idx.removeDoc('does-not-exist');
  assert.equal(idx.N, nBefore);
});

test('removeDoc then re-addDoc keeps df consistent', () => {
  const idx = buildIdx();
  idx.removeDoc('sym:1');
  idx.addDoc('sym:1', ['parse', 'tree', 'node']);
  idx.finalize();
  assert.equal(idx.df.get('parse'), 2);
  assert.equal(idx.df.get('tree'), 1);
  const res = idx.query(['tree']);
  assert.equal(res[0].symbolId, 'sym:1');
});

test('serialize/deserialize round-trips the index', () => {
  const idx = buildIdx();
  const obj = idx.serialize();
  const restored = BM25Index.deserialize(obj);
  // Same query, same ranking after round-trip.
  const before = idx.query(['parse', 'tree']);
  const after = restored.query(['parse', 'tree']);
  assert.deepEqual(
    after.map(r => r.symbolId),
    before.map(r => r.symbolId),
  );
  assert.equal(restored.N, idx.N);
  assert.equal(restored.avgdl, idx.avgdl);
});

test('deserialize tolerates a minimal/empty payload', () => {
  const restored = BM25Index.deserialize({});
  assert.equal(restored.N, 0);
  assert.equal(restored.avgdl, 0);
  restored.finalize();
  assert.deepEqual(restored.query(['x']), []);
});

test('deserialize with null fields does not throw', () => {
  const restored = BM25Index.deserialize({ N: 1, avgdl: 3, df: null, docLen: null, inverted: null });
  assert.equal(restored.N, 1);
  assert.equal(restored.avgdl, 3);
  assert.deepEqual(restored.query(['x']), []);
});
