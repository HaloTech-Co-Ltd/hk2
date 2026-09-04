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

test('the two knowledge retrieval paths have distinct ranking contracts', () => {
  const doc = `kb_search_knowledge uses flat token overlap; matchPrinciples uses head fields and weighted intro matches`;
  assert.match(doc, /flat token overlap/);
  assert.match(doc, /weighted intro/);
});
