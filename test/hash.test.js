/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/util/hash.js - the hashing primitives used across the
 * indexer (content tags, stale-anchor protection, fileId composition).
 *
 * Run:  node --test test/hash.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { sha256, shortHash, fileIdFromPath } from '../lib/util/hash.js';

test('sha256 matches Node crypto for utf-8 input', () => {
  const input = 'hello world';
  assert.equal(sha256(input), crypto.createHash('sha256').update(input, 'utf8').digest('hex'));
});

test('sha256 is deterministic for the same input', () => {
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
});

test('sha256 handles empty and multi-byte (CJK) input', () => {
  assert.equal(sha256(''), crypto.createHash('sha256').update('', 'utf8').digest('hex'));
  // CJK bytes must be hashed as utf-8, not latin-1 (which would differ).
  const cjk = '你好';
  assert.equal(sha256(cjk), crypto.createHash('sha256').update(cjk, 'utf8').digest('hex'));
  // Sanity: a different CJK string yields a different digest.
  assert.notEqual(sha256('你好'), sha256('再见'));
});

test('shortHash returns the first 8 hex chars of sha256', () => {
  const input = 'some file content';
  assert.equal(shortHash(input), sha256(input).slice(0, 8));
  assert.equal(shortHash(input).length, 8);
  // Collision sanity: distinct inputs should usually differ.
  assert.notEqual(shortHash('a'), shortHash('b'));
});

test('shortHash is stable across calls (pure function)', () => {
  assert.equal(shortHash('tag-content'), shortHash('tag-content'));
});

test('fileIdFromPath composes path:line', () => {
  assert.equal(fileIdFromPath('src/lib/foo.js', 42), 'src/lib/foo.js:42');
  assert.equal(fileIdFromPath('a/b.c', 1), 'a/b.c:1');
  // line 0 is a valid (if unusual) value and is preserved.
  assert.equal(fileIdFromPath('x.js', 0), 'x.js:0');
});
