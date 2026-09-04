import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../lib/agent/tools.js';
import { matchPrinciples } from '../lib/retrieval/context_builder.js';

function entry(id, title, intro, keywords = [], space = 'eden') {
  return { id, title, intro, keywords, space };
}

test('kb_search_knowledge gives each token one equal-weight point across the haystack', async () => {
  const rt = { allKnowledge: () => [
    entry('one', 'needle', 'needle in intro', ['needle']),
    entry('two', 'needle', '', []),
    entry('three', 'other', 'nothing', []),
  ] };
  const tool = buildTools(rt, {}).find(t => t.name === 'kb_search_knowledge');
  const result = await tool.execute({ query: 'needle', top_k: 20 });
  assert.equal(result.results[0].score, 1, 'a token contributes once despite appearing in multiple fields');
  assert.equal(result.results[1].score, 1, 'title-only and multi-field hits have equal score');
  assert.equal(result.count, 2);
});

test('kb_search_knowledge defaults to five and clamps top_k to 1-20', async () => {
  const entries = Array.from({ length: 25 }, (_, i) => entry(`x-${i}`, `common ${i}`, '', []));
  const tool = buildTools({ allKnowledge: () => entries }, {}).find(t => t.name === 'kb_search_knowledge');
  assert.equal((await tool.execute({ query: 'common' })).results.length, 5);
  assert.equal((await tool.execute({ query: 'common', top_k: 0 })).results.length, 5);
  assert.equal((await tool.execute({ query: 'common', top_k: 99 })).results.length, 20);
  assert.equal((await tool.execute({ query: 'common', top_k: -1 })).results.length, 1);
});

test('matchPrinciples uses head hits as primary and intro hits at weight 0.3', () => {
  const hits = matchPrinciples([
    entry('head', 'alpha', 'unrelated', [], 'holy'),
    entry('intro', 'unrelated', 'alpha', [], 'holy'),
  ], 'alpha');
  assert.equal(hits[0].principle.id, 'head');
  assert.equal(hits.find(h => h.principle.id === 'intro').score, 0.3 / Math.sqrt(8));
  assert.equal(hits.length, 2, 'turn-start matcher returns at most two');
});

test('knowledge tool and turn-start matcher rank the same entries differently', async () => {
  const entries = [
    entry('intro-only', 'unrelated', 'alpha', [], 'eden'),
    entry('head-hit', 'alpha', 'unrelated', [], 'eden'),
  ];
  const tool = buildTools({ allKnowledge: () => entries }, {}).find(t => t.name === 'kb_search_knowledge');
  const flat = await tool.execute({ query: 'alpha', top_k: 2 });
  assert.deepEqual(flat.results.map(r => r.id), ['intro-only', 'head-hit']);
  assert.deepEqual(flat.results.map(r => r.score), [1, 1]);
  const weighted = matchPrinciples(entries, 'alpha');
  assert.deepEqual(weighted.map(r => r.principle.id), ['head-hit', 'intro-only']);
});

test('knowledge search counts duplicate token occurrences and reports pre-limit count', async () => {
  const entries = [
    entry('one', 'alpha', 'alpha', [], 'eden'),
    entry('two', 'alpha', '', [], 'eden'),
  ];
  const tool = buildTools({ allKnowledge: () => entries }, {}).find(t => t.name === 'kb_search_knowledge');
  const r = await tool.execute({ query: 'alpha alpha', top_k: 1 });
  assert.equal(r.count, 2);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].score, 2);
});
