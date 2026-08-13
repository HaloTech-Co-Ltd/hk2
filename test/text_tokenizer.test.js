/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/index/text_tokenizer.js - the analyzer that turns
 * source text / symbol names into the BM25 tokens. Covers:
 *   - tokenizeText: ASCII snake/camel split, stop-word removal, stemming
 *   - CJK bigram extraction
 *   - expandQueryVariants: morphological variant generation
 *   - tokenizeSymbol: name/signature/body weighting
 *
 * Run:  node --test test/text_tokenizer.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { tokenizeText, tokenizeSymbol, expandQueryVariants } from '../lib/index/text_tokenizer.js';

/* ----------------------------- tokenizeText ---------------------------- */

test('tokenizeText returns [] for empty / null / whitespace input', () => {
  assert.deepEqual(tokenizeText(''), []);
  assert.deepEqual(tokenizeText(null), []);
  assert.deepEqual(tokenizeText('   \t\n  '), []);
});

test('tokenizeText splits snake_case into parts', () => {
  const t = tokenizeText('parse_config_file');
  assert.ok(t.includes('parse'));
  assert.ok(t.includes('config'));
  assert.ok(t.includes('file'));
});

test('tokenizeText splits camelCase and PascalCase', () => {
  const t = tokenizeText('parseConfigFile');
  assert.ok(t.includes('parse'));
  assert.ok(t.includes('config'));
  assert.ok(t.includes('file'));
  const t2 = tokenizeText('HttpClient');
  assert.ok(t2.includes('http'));
  assert.ok(t2.includes('client'));
});

test('tokenizeText lowercases and applies suffix rules (running -> runn)', () => {
  // The -ing rule strips the suffix but keeps the doubled consonant ('runn'),
  // so 'running' indexes as 'runn', not 'run'. By design: the query side runs
  // expandQueryVariants to cover both forms.
  const t = tokenizeText('running parsing migrated');
  assert.ok(t.includes('runn'), `expected 'runn', got ${JSON.stringify(t)}`);
  assert.ok(t.includes('par'));
  assert.ok(t.includes('migrat'));
});

test('tokenizeText drops English stop words and stems -er forms', () => {
  const t = tokenizeText('the function is a helper');
  // 'the', 'is', 'a' are stop words and must not appear.
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('is'));
  assert.ok(!t.includes('a'));
  // 'function' is a stop word; 'helper' stems via -er to 'help'.
  assert.ok(t.includes('help'), `expected 'help' (helper->help), got ${JSON.stringify(t)}`);
});

test('tokenizeText extracts CJK bigrams', () => {
  const t = tokenizeText('解析配置文件');
  // 5 CJK chars -> 4 bigrams: 解析, 析配, 配置, 置文, 文件 (5 tokens).
  assert.ok(t.length > 0, 'CJK input produced no tokens');
  assert.ok(t.some(tok => /[\u4e00-\u9fff]/.test(tok)), 'expected CJK bigram tokens');
});

test('tokenizeText handles mixed CJK + ASCII', () => {
  const t = tokenizeText('解析 parse_config');
  assert.ok(t.some(tok => /[\u4e00-\u9fff]/.test(tok)), 'CJK bigrams kept');
  assert.ok(t.includes('parse'));
  assert.ok(t.includes('config'));
});

test('tokenizeText preserves standalone numbers and stems -or words', () => {
  const t = tokenizeText('error 404 v2');
  // 'error' matches the -or suffix rule -> 'err'.
  assert.ok(t.includes('err'), `expected 'err' (error->err), got ${JSON.stringify(t)}`);
  assert.ok(t.includes('404'));
  assert.ok(t.includes('2'));
});

test('tokenizeText expandQuery option does not crash and still returns base tokens', () => {
  const base = tokenizeText('parse config');
  const expanded = tokenizeText('parse config', { expandQuery: true });
  assert.ok(base.every(t => expanded.includes(t)));
});

/* --------------------------- expandQueryVariants ------------------------ */

test('expandQueryVariants always includes the original token', () => {
  const v = expandQueryVariants('running');
  assert.ok(v.includes('running'));
});

test('expandQueryVariants strips common suffixes (running -> runn)', () => {
  const v = expandQueryVariants('running');
  // -ing rule keeps the doubled consonant: running -> runn.
  assert.ok(v.includes('runn'));
  assert.ok(v.includes('running'));
});

test('expandQueryVariants handles -ation forms (registration -> regist variants)', () => {
  const v = expandQueryVariants('registration');
  assert.ok(v.includes('regist'));
});

test('expandQueryVariants returns at least the token for short input', () => {
  const v = expandQueryVariants('ab');
  assert.ok(v.includes('ab'));
  assert.ok(Array.isArray(v));
});

test('expandQueryVariants de-duplicates (returns a Set-like array)', () => {
  const v = expandQueryVariants('testing');
  const unique = new Set(v);
  assert.equal(v.length, unique.size, 'variants must be unique');
});

/* ----------------------------- tokenizeSymbol --------------------------- */

test('tokenizeSymbol weights name tokens 3x and signature 2x', () => {
  const tokens = tokenizeSymbol({
    name: 'parseConfig',
    signature: 'parseConfig(opts)',
    body: '',
  });
  // 'parse' (from 'parse') comes from the name (3x) + signature (2x) = 5.
  const count = tokens.filter(t => t === 'parse').length;
  assert.equal(count, 5, `expected 'parse' x5, got ${count}`);
});

test('tokenizeSymbol reads body when present (capped)', () => {
  const tokens = tokenizeSymbol({
    name: 'foo',
    signature: '',
    body: 'bar baz qux',
  });
  assert.ok(tokens.includes('bar'));
  assert.ok(tokens.includes('baz'));
  assert.ok(tokens.includes('qux'));
});

test('tokenizeSymbol tolerates a symbol with no fields', () => {
  const tokens = tokenizeSymbol({});
  assert.deepEqual(tokens, []);
});

test('tokenizeSymbol tolerates missing body (undefined)', () => {
  const tokens = tokenizeSymbol({ name: 'foo', signature: '' });
  assert.ok(tokens.includes('foo'));
});
