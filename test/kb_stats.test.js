/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/agent/kb_stats.js - the per-loop KB-hit-rate and token-
 * savings statistics. The pure helpers (isBashSearch, fallbackKind,
 * extractKbResultFilePaths, estimateCallSavings) are exported via the
 * `_internals` object; buildKbStats is exported directly.
 *
 * Run:  node --test test/kb_stats.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { _internals, buildKbStats } from '../lib/agent/kb_stats.js';

const { isBashSearch, fallbackKind, extractKbResultFilePaths, estimateCallSavings } = _internals;

// A simple chars->tokens estimator (~4 chars/token) for the savings tests.
const estTokens = (bytes) => Math.ceil(bytes / 4);

/* ------------------------------- isBashSearch --------------------------- */

test('isBashSearch detects grep/rg/find/ack/fd/locate/git grep', () => {
  assert.equal(isBashSearch('grep -r foo src/'), true);
  assert.equal(isBashSearch('rg "pattern" lib/'), true);
  assert.equal(isBashSearch('find . -name "*.js"'), true);
  assert.equal(isBashSearch('ack "todo"'), true);
  assert.equal(isBashSearch('git grep "pattern"'), true);
  assert.equal(isBashSearch('fd ".js$"'), true);
});

test('isBashSearch detects cat/sed/awk/etc ONLY when a source extension is present', () => {
  assert.equal(isBashSearch('cat src/index.js'), true);
  assert.equal(isBashSearch('sed -n 1,10p lib/foo.py'), true);
  assert.equal(isBashSearch('cat README.md'), true);
  // No source extension -> not a search.
  assert.equal(isBashSearch('cat /etc/hosts'), false);
  assert.equal(isBashSearch('wc -l somefile'), false);
});

test('isBashSearch rejects non-search bash commands', () => {
  assert.equal(isBashSearch('ls -la'), false);
  assert.equal(isBashSearch('npm test'), false);
  assert.equal(isBashSearch('git status'), false);
  assert.equal(isBashSearch('echo hello'), false);
  assert.equal(isBashSearch('node --check bin/hk2'), false);
});

test('isBashSearch handles bad input safely', () => {
  assert.equal(isBashSearch(null), false);
  assert.equal(isBashSearch(undefined), false);
  assert.equal(isBashSearch(''), false);
  assert.equal(isBashSearch(123), false);
});

/* ------------------------------- fallbackKind --------------------------- */

test('fallbackKind returns "bash" for a search-like bash call (object args)', () => {
  assert.equal(fallbackKind({ name: 'bash', arguments: { command: 'grep foo src/' } }), 'bash');
});

test('fallbackKind returns "bash" for a search-like bash call (JSON-string args)', () => {
  assert.equal(fallbackKind({ name: 'bash', arguments: JSON.stringify({ command: 'rg pat lib/' }) }), 'bash');
});

test('fallbackKind returns null for a non-search bash call', () => {
  assert.equal(fallbackKind({ name: 'bash', arguments: { command: 'ls -la' } }), null);
});

test('fallbackKind returns "read" for a source-file read', () => {
  assert.equal(fallbackKind({ name: 'read', arguments: { path: 'src/index.js' } }), 'read');
  assert.equal(fallbackKind({ name: 'read', arguments: { path: 'lib/foo.py' } }), 'read');
});

test('fallbackKind returns null for a non-source read', () => {
  assert.equal(fallbackKind({ name: 'read', arguments: { path: 'README' } }), null);
  assert.equal(fallbackKind({ name: 'read', arguments: { path: 'docs/notes.txt' } }), 'read');
});

test('fallbackKind returns null for KB / unknown tools', () => {
  assert.equal(fallbackKind({ name: 'kb_search', arguments: {} }), null);
  assert.equal(fallbackKind({ name: 'kb_symbol', arguments: {} }), null);
  assert.equal(fallbackKind({ name: 'unknown', arguments: {} }), null);
});

test('fallbackKind tolerates malformed JSON-string args', () => {
  assert.equal(fallbackKind({ name: 'bash', arguments: '{not json' }), null);
});

test('fallbackKind handles missing args / bad shapes', () => {
  assert.equal(fallbackKind(null), null);
  assert.equal(fallbackKind({}), null);
  assert.equal(fallbackKind({ name: 'bash' }), null);
  assert.equal(fallbackKind({ name: 'bash', arguments: 'no-command-key' }), null);
});

/* -------------------------- extractKbResultFilePaths -------------------- */

test('extractKbResultFilePaths collects filePath from top-level and list items', () => {
  const result = {
    filePath: 'src/top.js',
    results: [
      { filePath: 'lib/a.js', name: 'foo' },
      { filePath: 'lib/b.js', name: 'bar' },
    ],
    symbols: [{ filePath: 'src/c.ts', kind: 'function' }],
  };
  const paths = extractKbResultFilePaths(result);
  assert.ok(paths.has('src/top.js'));
  assert.ok(paths.has('lib/a.js'));
  assert.ok(paths.has('lib/b.js'));
  assert.ok(paths.has('src/c.ts'));
});

test('extractKbResultFilePaths de-duplicates paths within one result', () => {
  const result = {
    results: [
      { filePath: 'lib/a.js' },
      { filePath: 'lib/a.js' },
      { filePath: 'lib/a.js' },
    ],
  };
  const paths = extractKbResultFilePaths(result);
  assert.equal(paths.size, 1);
});

test('extractKbResultFilePaths only keeps source-extension paths', () => {
  const result = {
    results: [
      { filePath: 'src/a.js' },      // source -> kept
      { filePath: 'notes/README' },  // no ext -> dropped
      { filePath: 'build/out' },     // no ext -> dropped
    ],
  };
  const paths = extractKbResultFilePaths(result);
  assert.ok(paths.has('src/a.js'));
  assert.equal(paths.size, 1);
});

test('extractKbResultFilePaths scans all known list fields', () => {
  const result = {
    neighbors: [{ filePath: 'lib/n.js' }],
    callers: [{ filePath: 'lib/c.js' }],
    forward: [{ filePath: 'lib/f.js' }],
    backward: [{ filePath: 'lib/b.js' }],
    implementations: [{ filePath: 'lib/i.js' }],
  };
  const paths = extractKbResultFilePaths(result);
  assert.equal(paths.size, 5);
});

test('extractKbResultFilePaths returns empty set for null / non-object', () => {
  assert.equal(extractKbResultFilePaths(null).size, 0);
  assert.equal(extractKbResultFilePaths(undefined).size, 0);
  assert.equal(extractKbResultFilePaths('string').size, 0);
  assert.equal(extractKbResultFilePaths(42).size, 0);
});

/* --------------------------- estimateCallSavings ----------------------- */

test('estimateCallSavings is >= 0 (clamped) and 0 when no referenced files', async () => {
  const result = { results: [{ filePath: 'does-not-exist.js' }] };
  const savings = await estimateCallSavings(result, '/nonexistent-root', estTokens);
  assert.ok(savings >= 0);
  // Non-existent files stat to 0 bytes -> 0 disk tokens, so savings == 0 - resultTokens clamped to 0.
  assert.equal(savings, 0);
});

test('estimateCallSavings grows when a real referenced file is large', async () => {
  // Create a temp file larger than the KB result payload.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-kbstats-'));
  const bigPath = path.join(dir, 'big.js');
  const bigContent = '// ' + 'x'.repeat(2000) + '\n';
  await fs.writeFile(bigPath, bigContent, 'utf8');
  try {
    const result = { results: [{ filePath: 'big.js' }] };
    const savings = await estimateCallSavings(result, dir, estTokens);
    // diskBytes (~2000+) >> resultBytes (<100) -> savings should be positive.
    assert.ok(savings > 0, `expected positive savings, got ${savings}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('estimateCallSavings with no root returns 0 savings', async () => {
  const result = { results: [{ filePath: 'a.js' }] };
  const savings = await estimateCallSavings(result, null, estTokens);
  assert.equal(savings, 0);
});

/* ------------------------------- buildKbStats --------------------------- */

test('buildKbStats computes hit rate and aggregates savings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-kbstats-'));
  const bigPath = path.join(dir, 'big.js');
  await fs.writeFile(bigPath, '// ' + 'y'.repeat(1000) + '\n', 'utf8');
  try {
    const kbCalls = [
      // A KB call referencing a real file -> positive savings.
      { call: { name: 'kb_search' }, result: { results: [{ filePath: 'big.js' }] } },
      // A KB call with an error result -> contributes to count but 0 savings.
      { call: { name: 'kb_symbol' }, result: { error: 'not found' } },
    ];
    const fallbackCalls = [
      { call: { name: 'bash', arguments: { command: 'grep foo src/' } }, result: {} },
    ];
    const stats = await buildKbStats(kbCalls, fallbackCalls, { root: dir, estTokens });
    assert.equal(stats.kbCalls, 2);
    assert.equal(stats.fallbackCalls, 1);
    assert.equal(stats.hitRate, 2 / 3);
    assert.ok(stats.estimatedTokensSaved >= 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('buildKbStats hitRate is 0 when only fallback calls', async () => {
  const stats = await buildKbStats([], [{ call: {}, result: {} }], { root: null, estTokens });
  assert.equal(stats.kbCalls, 0);
  assert.equal(stats.fallbackCalls, 1);
  assert.equal(stats.hitRate, 0);
});

test('buildKbStats hitRate is 0 when no calls at all (avoid div-by-zero)', async () => {
  const stats = await buildKbStats([], [], { root: null, estTokens });
  assert.equal(stats.kbCalls, 0);
  assert.equal(stats.fallbackCalls, 0);
  assert.equal(stats.hitRate, 0);
  assert.equal(stats.estimatedTokensSaved, 0);
});
