/*-------------------------------------------------------------------------
 *
 * Unit tests for the enhanced /kb knowledge housekeep:
 *   - --model=<provider/model-id> resolution (valid / invalid refs)
 *   - Phase 1: broken-entry scan + confirm-gated removal
 *   - Phase 2: deterministic pre-filter clustering (clusterSimilarEntries)
 *     + LLM-judged duplicate/similar merge with confirmation
 *   - Phase 3 (scope=all): Eden↔Holy conflict detection (findConflictingHoly)
 *     + per-pair resolution options (stamp / delete / merge-into-Holy / skip)
 *   - supreme-code entry is NEVER touched
 *   - knowledge indexes (holy.idx.json / eden.idx.json) rebuilt after writes
 *
 * Run:  node --test test/kb_housekeep.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let tmpKbRoot = '';
let origKbDir = '';
let origHome = '';
const PID = 'kb-housekeep-test';

test.before(async () => {
  origKbDir = process.env.HK2_KB_DIR || '';
  origHome = process.env.HK2_HOME || '';
  tmpKbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-housekeep-'));
  process.env.HK2_KB_DIR = tmpKbRoot;
  process.env.HK2_HOME = tmpKbRoot;
});

test.after(async () => {
  if (origKbDir) process.env.HK2_KB_DIR = origKbDir; else delete process.env.HK2_KB_DIR;
  if (origHome) process.env.HK2_HOME = origHome; else delete process.env.HK2_HOME;
  await fs.rm(tmpKbRoot, { recursive: true, force: true }).catch(() => {});
});

/* ---------------- helpers ---------------- */

function mockLLM(judgments) {
  // judgments: array of verdict objects consumed in call order
  const queue = [...judgments];
  return {
    stream: async function* () {
      const v = queue.length ? queue.shift() : null;
      if (v === 'THROW') throw new Error('llm down');
      yield { type: 'delta', text: v == null ? '' : JSON.stringify(v) };
    },
  };
}

function mockCtx({ confirmAnswers = [], chooseAnswers = [], llm = null, project = null } = {}) {
  const output = [];
  const confirms = [...confirmAnswers];
  const chooses = [...chooseAnswers];
  return {
    output,
    print: (s) => output.push(String(s)),
    confirm: async () => (confirms.length ? confirms.shift() : false),
    choose: async () => (chooses.length ? chooses.shift() : null),
    getCurrentProject: async () => project || { id: PID, name: PID },
    llm,
    noteReloadKb: () => {},
  };
}

let projectReady = false;
async function setupProject() {
  if (!projectReady) {
    const srcDir = path.join(tmpKbRoot, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    const { addKbForProject } = await import('../lib/index/registry.js');
    await addKbForProject({ id: PID, name: PID, sourcePath: srcDir });
    projectReady = true;
  }
  const store = await import('../lib/store/kb_store.js');
  return store;
}

async function resetSpaces(store) {
  // wipe all knowledge in both spaces (except permanent supreme-code which
  // deleteKnowledge refuses) and any stale per-space idx files, so each test
  // starts from a known baseline.
  for (const space of ['holy', 'eden']) {
    for (const e of await store.listKnowledge(PID, space)) {
      if (e.id === 'hk2-supreme-code') continue;
      await store.deleteKnowledge(PID, space, e.id).catch(() => {});
    }
    const idxPath = path.join(tmpKbRoot, PID, `${space}.idx.json`);
    await fs.rm(idxPath, { force: true }).catch(() => {});
  }
}

async function seedEntry(store, space, entry) {
  await store.writeKnowledge(PID, space, entry);
}

function edenDupA() {
  return {
    id: 'sql-cmds', space: 'eden',
    title: 'SQL Command Catalog',
    keywords: ['sql', 'commands', 'catalog'],
    intro: 'A list of supported SQL commands: SELECT, INSERT, UPDATE, DELETE.',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}
function edenDupB() {
  return {
    id: 'sql-commands-list', space: 'eden',
    title: 'SQL Commands List',
    keywords: ['sql', 'commands', 'catalog', 'list'],
    intro: 'Commands supported: SELECT, INSERT, plus MERGE now.',
    createdAt: '2024-02-01T00:00:00.000Z',
  };
}
function edenUnique() {
  return {
    id: 'release-checklist', space: 'eden',
    title: 'Release Checklist',
    keywords: ['release', 'checklist'],
    intro: 'Steps to cut a release.',
    createdAt: '2024-03-01T00:00:00.000Z',
  };
}
function holyAuthority() {
  return {
    id: 'sql-authoritative', space: 'holy',
    title: 'SQL Command Catalog (authoritative)',
    keywords: ['sql', 'commands', 'catalog'],
    intro: 'The definitive SQL surface.',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

/* ---------------- pure helpers: clusterSimilarEntries / findConflictingHoly ---------------- */

test('clusterSimilarEntries: keyword-overlap clustering + title containment + superseded exclusion', async () => {
  const { __housekeepTest } = await import('../src/slash/kb.js');
  const a = { id: 'a', title: 'Sql Command Catalog', keywords: ['sql', 'commands', 'catalog'] };
  const b = { id: 'b', title: 'SQL Command List', keywords: ['sql', 'commands', 'catalog', 'list'] };
  const c = { id: 'c', title: 'Parser Internals', keywords: ['parser', 'ast', 'tokens'] };
  const d = { id: 'd', title: 'Sql Command Catalog Extended Notes', keywords: ['notes'] };
  const retired = { id: 'r', title: 'Sql Command Catalog Old', keywords: ['sql', 'commands', 'catalog'], supersededBy: 'holy:x' };

  const clusters = __housekeepTest.clusterSimilarEntries([a, b, c, d, retired]);
  assert.equal(clusters.length, 1, 'exactly one cluster (a+b+d); c distinct, retired excluded');
  const ids = clusters[0].map(e => e.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'd']);
});

test('clusterSimilarEntries: 0.6 threshold boundary — exactly 0.6 does NOT cluster', async () => {
  const { __housekeepTest } = await import('../src/slash/kb.js');
  // denominator is the SMALLER keyword set (same as findHolyConflict):
  // overlap 3 / min(5,5) = 0.6 exactly → not > 0.6 → no cluster
  const a = { id: 'a', title: 'Alpha', keywords: ['k1', 'k2', 'k3', 'k4', 'k5'] };
  const b = { id: 'b', title: 'Beta', keywords: ['k1', 'k2', 'k3', 'm1', 'm2'] };
  assert.equal(__housekeepTest.clusterSimilarEntries([a, b]).length, 0);
  // overlap 4 / 5 = 0.8 > 0.6 → clusters
  const b2 = { id: 'b', title: 'Beta', keywords: ['k1', 'k2', 'k3', 'k4', 'm1'] };
  assert.equal(__housekeepTest.clusterSimilarEntries([a, b2]).length, 1);
});

test('findConflictingHoly: same heuristics as graph.js findHolyConflict', async () => {
  const { __housekeepTest } = await import('../src/slash/kb.js');
  const holy = [
    { id: 'h1', title: 'Sql Command Catalog', keywords: ['sql', 'commands'] },
    { id: 'h2', title: 'Wal Replay Loop', keywords: ['wal', 'replay'] },
  ];
  const hit = __housekeepTest.findConflictingHoly(
    { title: 'SQL COMMAND CATALOG quick notes', keywords: [] }, holy);
  assert.equal(hit.id, 'h1'); // title containment, case-insensitive
  const hit2 = __housekeepTest.findConflictingHoly(
    { title: 'Unrelated Title', keywords: ['wal', 'replay', 'extra'] }, holy);
  assert.equal(hit2.id, 'h2'); // keyword overlap 2/2 = 1.0 > 0.6
  const miss = __housekeepTest.findConflictingHoly(
    { title: 'Unrelated', keywords: ['btree', 'vacuum'] }, holy);
  assert.equal(miss, null);
});

/* ---------------- full command flow ---------------- */

test('usage line: missing scope prints usage and exits', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');
  const ctx = mockCtx({ llm: mockLLM([]) });
  await cmdKb(['knowledge', 'housekeep'], ctx);
  assert.ok(ctx.output.some(l => l.includes('Usage: /kb knowledge housekeep')), 'usage shown');
});

test('--model with unknown ref: friendly error, no writes', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');
  const ctx = mockCtx({ llm: mockLLM([]) });
  await cmdKb(['knowledge', 'housekeep', 'eden', '--model=nope/missing-model'], ctx);
  assert.ok(ctx.output.some(l => /model not found|invalid --model/i.test(l)), 'model error surfaced');
  assert.equal((await store.listKnowledge(PID, 'eden')).length, 0);
});

test('no LLM configured: clear guidance', async () => {
  await setupProject();
  const { cmdKb } = await import('../src/slash/kb.js');
  const ctx = mockCtx({ llm: null });
  await cmdKb(['knowledge', 'housekeep', 'eden'], ctx);
  assert.ok(ctx.output.some(l => l.includes('No LLM configured')));
});

test('Phase 1: broken entries removed after y/N; Phase 2 merge confirmed; supreme-code untouched; index rebuilt', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');
  const { readSupremeCode } = await import('../lib/store/supreme_code.js');

  await seedEntry(store, 'eden', { id: 'broken-1', space: 'eden', title: '', intro: 'x' }); // broken
  await seedEntry(store, 'eden', edenDupA());
  await seedEntry(store, 'eden', edenDupB());
  await seedEntry(store, 'eden', edenUnique());

  const scBefore = JSON.stringify(await readSupremeCode(PID));

  // LLM sees ONE cluster [sql-cmds, sql-commands-list] and says duplicate + merged
  const llm = mockLLM([{
    relation: 'duplicate',
    reason: 'same catalog',
    merged: {
      title: 'SQL Command Catalog (merged)',
      intro: 'SELECT, INSERT, UPDATE, DELETE, MERGE.',
      keywords: ['sql', 'commands', 'catalog', 'merge'],
    },
  }]);
  const ctx = mockCtx({
    llm,
    confirmAnswers: [true /* remove broken */, true /* merge */],
  });
  await cmdKb(['knowledge', 'housekeep', 'eden'], ctx);

  const eden = await store.listKnowledge(PID, 'eden');
  const ids = eden.map(e => e.id).sort();

  // broken-1 removed; sql-commands-list merged away; sql-cmds rewritten in place; unique kept
  assert.ok(!ids.includes('broken-1'), 'broken entry removed');
  assert.ok(!ids.includes('sql-commands-list'), 'duplicate removed after merge');
  assert.ok(ids.includes('sql-cmds'), 'primary merged entry kept (oldest id)');
  assert.ok(ids.includes('release-checklist'), 'unrelated entry untouched');

  const merged = eden.find(e => e.id === 'sql-cmds');
  assert.equal(merged.title, 'SQL Command Catalog (merged)');
  assert.ok(merged.intro.includes('MERGE'));
  assert.ok(Array.isArray(merged.housekeptFrom) && merged.housekeptFrom.includes('sql-commands-list'));
  assert.equal(merged.source, 'kb-knowledge-housekeep');

  // keywords unioned
  assert.ok(merged.keywords.includes('list'));

  // supreme code untouched
  assert.equal(JSON.stringify(await readSupremeCode(PID)), scBefore);

  // knowledge index rebuilt with the eden entries
  const idx = await store.readKnowledgeIndex(PID, 'eden');
  assert.ok(idx, 'eden.idx.json exists');
  assert.equal(idx.space, 'eden');
  assert.equal(idx.entryCount, eden.length);
  assert.ok(idx.index && idx.index.N === eden.length, 'BM25 doc count matches entries');

  // summary line
  assert.ok(ctx.output.some(l => l.includes('Housekeep complete')));
  assert.ok(ctx.output.some(l => l.includes('rebuilt eden knowledge index')));
});

test('Phase 3: already-superseded eden entries are not re-flagged (banner stacking guard)', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');
  await seedEntry(store, 'holy', holyAuthority());
  await seedEntry(store, 'eden', {
    ...edenDupA(),
    supersededBy: 'holy:sql-authoritative', // resolved by a PREVIOUS run
    intro: '[Superseded by holy:sql-authoritative — Holy Space takes precedence.]\n\nA list of supported SQL commands.',
  });

  let judged = 0;
  const llm = {
    stream: async function* () {
      judged++;
      yield { type: 'delta', text: JSON.stringify({ relation: 'conflict', reason: 'r', suggestion: 's', merged: null }) };
    },
  };
  let menuShown = false;
  const ctx = mockCtx({ llm });
  ctx.choose = async () => { menuShown = true; return 4; };
  await cmdKb(['knowledge', 'housekeep', 'all'], ctx);

  assert.equal(judged, 0, 'retired entries must not spend a judge call');
  assert.ok(!menuShown, 'no resolution menu for retired entries');
  assert.ok(ctx.output.some(l => l.includes('no Eden↔Holy conflict candidates')),
    'a space whose only conflict was already resolved reports none');
});

test('Phase 2: merged keywords from the LLM land in the written entry (preview parity)', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');
  await seedEntry(store, 'eden', edenDupA());
  await seedEntry(store, 'eden', edenDupB());

  const llm = mockLLM([{
    relation: 'duplicate', reason: 'r',
    merged: { title: 'SQL Command Catalog (merged)', intro: 'fused', keywords: ['merge-stmt', 'catalog'] },
  }]);
  const ctx = mockCtx({ llm, confirmAnswers: [true] });
  await cmdKb(['knowledge', 'housekeep', 'eden'], ctx);

  const merged = await store.readKnowledge(PID, 'eden', 'sql-cmds');
  assert.ok(merged.keywords.includes('merge-stmt'), 'LLM fused keyword preserved');
  assert.ok(merged.keywords.includes('list'), 'member keyword union still preserved');
  // preview parity: every keyword advertised at the y/N prompt is on disk
  const previewLine = ctx.output.find(l => l.includes('merged keywords:'));
  for (const kw of previewLine.replace('merged keywords:', '').trim().split(', ')) {
    assert.ok(merged.keywords.includes(kw), `previewed keyword "${kw}" must be written`);
  }
});

test('Phase 2: declined merge → nothing written, no index rebuild', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');
  await seedEntry(store, 'eden', edenDupA());
  await seedEntry(store, 'eden', edenDupB());

  const llm = mockLLM([{ relation: 'similar', reason: 'r', merged: { title: 'T', intro: 'I', keywords: [] } }]);
  const ctx = mockCtx({ llm, confirmAnswers: [false] });
  await cmdKb(['knowledge', 'housekeep', 'eden'], ctx);

  const eden = await store.listKnowledge(PID, 'eden');
  assert.equal(eden.length, 2, 'both kept');
  assert.ok(ctx.output.some(l => l.includes('No changes written')));
  assert.equal(await store.readKnowledgeIndex(PID, 'eden'), null, 'no idx written');
});

test('Phase 2: judge call failure → cluster skipped gracefully', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');
  await seedEntry(store, 'eden', edenDupA());
  await seedEntry(store, 'eden', edenDupB());

  const llm = mockLLM(['THROW']);
  const ctx = mockCtx({ llm, confirmAnswers: [] });
  await cmdKb(['knowledge', 'housekeep', 'eden'], ctx);

  assert.equal((await store.listKnowledge(PID, 'eden')).length, 2, 'untouched on judge failure');
  assert.ok(ctx.output.some(l => l.includes('judge unavailable')));
});

test('Phase 3 (scope=all): stamp / delete / merge-into-holy / skip options', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');

  await seedEntry(store, 'holy', holyAuthority());
  await seedEntry(store, 'eden', edenDupA());   // conflicts with holy (keywords identical)
  await seedEntry(store, 'eden', edenUnique()); // no conflict

  // choose=1 → stamp supersededBy
  let llm = mockLLM([{ relation: 'conflict', reason: 'r', suggestion: 's', merged: null }]);
  let ctx = mockCtx({ llm, confirmAnswers: [], chooseAnswers: [1] });
  await cmdKb(['knowledge', 'housekeep', 'all'], ctx);
  let e = await store.readKnowledge(PID, 'eden', 'sql-cmds');
  assert.equal(e.supersededBy, 'holy:sql-authoritative');
  assert.ok(e.intro.startsWith('[Superseded by holy:sql-authoritative'));
  assert.ok(ctx.output.some(l => l.includes('stamped eden "sql-cmds"')));

  // reset eden entry, choose=2 → delete eden
  await seedEntry(store, 'eden', edenDupA());
  llm = mockLLM([{ relation: 'duplicate', reason: 'r', suggestion: 's', merged: null }]);
  ctx = mockCtx({ llm, confirmAnswers: [], chooseAnswers: [2] });
  await cmdKb(['knowledge', 'housekeep', 'all'], ctx);
  assert.equal(await store.readKnowledge(PID, 'eden', 'sql-cmds'), null, 'eden deleted');
  assert.equal((await store.readKnowledge(PID, 'eden', 'release-checklist')).id, 'release-checklist');

  // reset, choose=3 + confirm=true → holy rewritten with merged content
  await seedEntry(store, 'eden', edenDupA());
  llm = mockLLM([{
    relation: 'conflict', reason: 'r', suggestion: 's',
    merged: { title: 'SQL Command Catalog (authoritative)', intro: 'Definitive surface, now with MERGE.', keywords: ['sql', 'commands'] },
  }]);
  ctx = mockCtx({ llm, confirmAnswers: [true], chooseAnswers: [3] });
  await cmdKb(['knowledge', 'housekeep', 'all'], ctx);
  const h = await store.readKnowledge(PID, 'holy', 'sql-authoritative');
  assert.ok(h.intro.includes('MERGE'), 'holy intro rewritten');
  assert.ok(Array.isArray(h.housekeptFrom) && h.housekeptFrom.includes('sql-cmds'));

  // holy idx rebuilt too (both spaces on scope=all)
  const hIdx = await store.readKnowledgeIndex(PID, 'holy');
  assert.ok(hIdx && hIdx.space === 'holy');

  // reset, choose=4 → skip: nothing changes
  await seedEntry(store, 'eden', edenDupA());
  llm = mockLLM([{ relation: 'conflict', reason: 'r', suggestion: 's', merged: null }]);
  ctx = mockCtx({ llm, confirmAnswers: [], chooseAnswers: [4] });
  await cmdKb(['knowledge', 'housekeep', 'all'], ctx);
  e = await store.readKnowledge(PID, 'eden', 'sql-cmds');
  assert.ok(e && !e.supersededBy, 'skip leaves eden unstamped');
});

test('Phase 3: complementary verdict → no prompt, no write', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  const { cmdKb } = await import('../src/slash/kb.js');
  await seedEntry(store, 'holy', holyAuthority());
  await seedEntry(store, 'eden', edenDupA());

  const llm = mockLLM([{ relation: 'complementary', reason: 'fine', suggestion: '', merged: null }]);
  let chose = false;
  const ctx = mockCtx({ llm, confirmAnswers: [], chooseAnswers: [], });
  ctx.choose = async () => { chose = true; return 4; };
  await cmdKb(['knowledge', 'housekeep', 'all'], ctx);
  assert.ok(!chose, 'no menu shown for complementary');
  assert.ok(ctx.output.some(l => l.includes('complementary')));
});

test('rebuildKnowledgeIndex: fresh BM25 doc per entry, superseded still indexed', async () => {
  const store = await setupProject();
  await resetSpaces(store);
  await seedEntry(store, 'eden', edenUnique());
  await seedEntry(store, 'eden', { ...edenDupA(), supersededBy: 'holy:x' });

  const { count } = await store.rebuildKnowledgeIndex(PID, 'eden');
  assert.equal(count, 2);
  const idx = await store.readKnowledgeIndex(PID, 'eden');
  const { BM25Index } = await import('../lib/index/bm25.js');
  const bm = BM25Index.deserialize(idx.index);
  assert.equal(bm.N, 2);
  // querying a keyword from the title hits the right doc
  const hits = bm.query(['release', 'checklist']);
  assert.ok(hits.some(h => h.symbolId === 'release-checklist'));
});
