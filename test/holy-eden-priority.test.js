/*-------------------------------------------------------------------------
 *
 * Unit tests for Holy-over-Eden KB priority:
 *
 *   1. Retrieval layering (buildRequestGraph): Holy entries ALWAYS rank
 *      ahead of Eden entries in graph.knowledge, even when the Eden entry
 *      matches the query better.
 *   2. Conflict suppression: an Eden entry that conflicts with a Holy entry
 *      (title containment / keyword overlap > 0.6) is removed from
 *      graph.knowledge and recorded in graph.conflicts.
 *   3. renderRequestGraph emits the Holy-precedence header and a conflicts
 *      section telling the model to follow Holy.
 *
 * Run:  node --test test/holy-eden-priority.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import { buildRequestGraph, renderRequestGraph } from '../lib/agent/graph.js';

/* Minimal rt stub: buildRequestGraph only touches knowledgeBySpace, bm (via
 * codeSearch — stubbed to return []), callgraph, getSymbolById, getFilePath,
 * and the graph helpers guarded by `if (rt.graph)`. */
function mockRt({ holy = [], eden = [] } = {}) {
  return {
    name: 'priority-test',
    knowledgeBySpace: { holy, eden },
    allKnowledge: () => [...holy, ...eden],
    bm: { query: () => [] },          // codeSearch returns [] -> no symbol noise
    callgraph: { byId: {} },
    graph: null,                       // skip call-chain/class context blocks
    getSymbolById: () => null,
    getFilePath: () => null,
    reloadKnowledge: () => {},
  };
}

const HOLY = {
  id: 'wal-replay-loop',
  title: 'WAL replay loop',
  intro: 'Holy truth: the canonical description of the WAL replay loop.',
  keyFiles: ['src/wal.c'],
  keySymbols: ['walReplay'],
  keywords: ['wal', 'replay', 'loop'],
};

const EDEN_DUP = {
  id: 'wal-replay-notes',
  title: 'WAL replay loop notes',
  intro: 'Eden (stale) notes about the WAL replay loop.',
  keywords: ['wal', 'replay', 'loop'],
};

const EDEN_OK = {
  id: 'wal-buffer-notes',
  title: 'WAL buffer management',
  intro: 'Eden notes on WAL buffers — matches the query but shares only 1/2 keywords with the Holy entry (overlap 0.5 <= 0.6).',
  keywords: ['wal', 'buffer'],
};

const QUERY = 'how does the wal replay loop work';

test('Holy entries rank ahead of Eden even when Eden matches better', async () => {
  const noisyEden = {
    id: 'wal-eden-strong',
    title: 'wal replay loop',
    intro: 'Eden entry with an extremely strong match.',
    keywords: ['wal', 'replay', 'loop', 'wal', 'replay', 'loop'],
  };
  const rt = mockRt({ holy: [HOLY], eden: [noisyEden, EDEN_OK] });
  const g = await buildRequestGraph(rt, QUERY, { project: null });
  assert.ok(g.knowledge.length >= 1, 'at least the Holy entry should match');
  const spaces = g.knowledge.map(k => k.space);
  const firstEden = spaces.indexOf('eden');
  const lastHoly = spaces.lastIndexOf('holy');
  if (firstEden !== -1) {
    assert.ok(lastHoly < firstEden, `every holy entry must precede every eden entry (spaces=${spaces.join(',')})`);
  }
});

test('Eden entry conflicting with Holy is suppressed and recorded in conflicts', async () => {
  const rt = mockRt({ holy: [HOLY], eden: [EDEN_DUP] });
  const g = await buildRequestGraph(rt, QUERY, { project: null });
  const ids = g.knowledge.map(k => k.id);
  assert.ok(ids.includes('wal-replay-loop'), 'the Holy entry is injected');
  assert.ok(!ids.includes('wal-replay-notes'), 'the conflicting Eden entry is suppressed');
  assert.equal(g.conflicts.length, 1);
  assert.equal(g.conflicts[0].eden.id, 'wal-replay-notes');
  assert.equal(g.conflicts[0].holy.id, 'wal-replay-loop');
  assert.match(g.summary, /eden conflict/i);
});

test('Non-conflicting Eden entries are still injected (after Holy)', async () => {
  const rt = mockRt({ holy: [HOLY], eden: [EDEN_OK] });
  const g = await buildRequestGraph(rt, QUERY, { project: null });
  const ids = g.knowledge.map(k => k.id);
  assert.ok(ids.includes('wal-replay-loop'));
  assert.ok(ids.includes('wal-buffer-notes'), 'unrelated Eden entry stays in context');
  assert.equal(g.conflicts.length, 0);
});

test('Keyword-overlap conflict (>0.6) is detected even with distinct titles', async () => {
  const edenKw = {
    id: 'replay-engine-notes',
    title: 'Notes on the replay engine internals',
    intro: 'Shares most keywords with the Holy entry.',
    keywords: ['wal', 'replay', 'loop'],
  };
  const rt = mockRt({ holy: [HOLY], eden: [edenKw] });
  const g = await buildRequestGraph(rt, QUERY, { project: null });
  assert.equal(g.conflicts.length, 1, '3/3 keyword overlap must count as a conflict');
  assert.ok(!g.knowledge.map(k => k.id).includes('replay-engine-notes'));
});

test('Low keyword overlap (<={0.6} threshold) is NOT a conflict', async () => {
  const edenFar = {
    id: 'loop-unroller',
    title: 'Loop unroller optimization',
    intro: 'Only shares the keyword loop.',
    keywords: ['loop', 'unroller', 'optimization'],
  };
  const rt = mockRt({ holy: [HOLY], eden: [edenFar] });
  const g = await buildRequestGraph(rt, QUERY, { project: null });
  assert.equal(g.conflicts.length, 0);
});

test('renderRequestGraph states Holy precedence and lists suppressed Eden entries', async () => {
  const rt = mockRt({ holy: [HOLY], eden: [EDEN_DUP] });
  const g = await buildRequestGraph(rt, QUERY, { project: null });
  const text = renderRequestGraph(g);
  assert.match(text, /Holy first, then Eden/);
  assert.match(text, /Holy-over-Eden conflicts/);
  assert.match(text, /wal-replay-notes.*superseded by.*wal-replay-loop|superseded by holy "WAL replay loop"/);
  assert.ok(!text.includes('Eden (stale) notes'), 'suppressed Eden intro must not be rendered');
});

test('No holy entries at all -> Eden matched normally, zero conflicts', async () => {
  const rt = mockRt({ holy: [], eden: [EDEN_DUP, EDEN_OK] });
  const g = await buildRequestGraph(rt, QUERY, { project: null });
  assert.equal(g.conflicts.length, 0);
  assert.ok(g.knowledge.every(k => k.space === 'eden'));
});
