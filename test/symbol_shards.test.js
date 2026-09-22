import './_learn_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createKbDir, deleteKb, writeSymbolsShard, readSymbolsShard, listSymbolShards,
  writeFiles, writeCallgraph, writeInverted, loadSymbolById,
} from '../lib/store/kb_store.js';
import { BM25Index } from '../lib/index/bm25.js';
import { KBRuntime } from '../lib/retrieval/kb_runtime.js';

test('decimal shard boundaries remain queryable after runtime reload', async () => {
  const name = randomUUID();
  const numbers = [0, 9, 10, 15, 16, 99, 100, 9999, 10000];
  try {
    await createKbDir(name);
    const files = { byId: {}, byPath: {}, nextId: 2560001 };
    const callgraph = { byId: {}, nameIndex: {} };
    const bm = new BM25Index();
    const symbols = [];
    for (const n of numbers) {
      const fileId = n * 256 + 1;
      const sym = { id: `${fileId}:1`, fileId, name: `symbol${n}`, kind: 'function', lineStart: 1 };
      symbols.push(sym);
      files.byId[fileId] = { path: `file${n}.js` };
      files.byPath[`file${n}.js`] = fileId;
      callgraph.nameIndex[sym.name] = [sym.id];
      bm.addDoc(sym.id, ['common']);
      await writeSymbolsShard(name, n, { symbols: [sym] });
    }
    bm.finalize();
    await writeFiles(name, files);
    await writeCallgraph(name, callgraph);
    await writeInverted(name, bm.serialize());
    const listed = await listSymbolShards(name);
    assert.deepEqual(listed.map(s => s.shardNum), numbers);
    for (const [i, shard] of listed.entries()) {
      assert.deepEqual((await readSymbolsShard(name, shard.shardNum)).symbols, [symbols[i]]);
      assert.deepEqual(await loadSymbolById(name, symbols[i].id), symbols[i]);
    }
    const rt = new KBRuntime(name);
    await rt.load();
    assert.equal(rt.symbolsByFile.size, numbers.length);
    for (const sym of symbols) {
      assert.deepEqual(rt.getSymbolsByName(sym.name), [sym]);
      assert.deepEqual(rt.getSymbolById(sym.id), sym);
    }
    for (const hit of rt.bm.query(['common'], { topK: 20 })) {
      assert.ok(rt.getSymbolById(hit.symbolId), 'every inverted-index hit has a loaded symbol');
    }
  } finally {
    await deleteKb(name);
  }
});
