import './_learn_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addKbForProject } from '../lib/index/registry.js';
import { buildIndex } from '../lib/index/indexer.js';
import { deleteKb, getMeta, saveMeta, readFiles, listSymbolShards, writeSymbolsShard } from '../lib/store/kb_store.js';
import { KBRuntime } from '../lib/retrieval/kb_runtime.js';

test('updates remove deleted, renamed and excluded code from every index', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-deletions-'));
  const id = randomUUID();
  try {
    await fs.writeFile(path.join(dir, 'keep.js'), 'function keepFn() { return dropFn(); }');
    await fs.writeFile(path.join(dir, 'drop.js'), 'function dropFn() { return 1; }');
    await addKbForProject({ id, sourcePath: dir, includeGlobs: ['**/*.js'] });
    await buildIndex(id, { skipSummary: true });
    await writeSymbolsShard(id, 2, { symbols: [{ id: '512:1', fileId: 512, name: 'orphanFn' }] });
    await fs.unlink(path.join(dir, 'drop.js'));
    await fs.rename(path.join(dir, 'keep.js'), path.join(dir, 'renamed.js'));
    let stats = await buildIndex(id, { skipSummary: true });
    assert.equal(stats.totalFiles, 1);
    assert.equal(stats.totalSymbols, 1);
    let rt = new KBRuntime(id);
    await rt.load();
    assert.equal(rt.getSymbolsByName('dropFn').length, 0);
    assert.equal(rt.getFilePath(rt.getSymbolsByName('keepFn')[0].fileId), 'renamed.js');
    assert.deepEqual(Object.keys((await readFiles(id)).byPath), ['renamed.js']);
    assert.equal(rt.graph.nodes.size, 1);
    assert.equal((await listSymbolShards(id)).length, 1);
    const meta = await getMeta(id);
    await saveMeta(id, { ...meta, excludeGlobs: ['**/*.js'] });
    for (const full of [false, true]) {
      stats = await buildIndex(id, { skipSummary: true, full });
      assert.equal(stats.totalFiles, 0);
      assert.equal(stats.totalSymbols, 0);
      assert.equal(stats.graphNodes, 0);
      assert.deepEqual(await listSymbolShards(id), []);
      rt = new KBRuntime(id);
      await rt.load();
      assert.equal(rt.symbolsByFile.size, 0);
      assert.equal(rt.getSymbolsByName('keepFn').length, 0);
      assert.equal(rt.bm.N, 0);
    }
    // An actually empty scan must also clear a previous nonempty full build.
    await saveMeta(id, meta);
    await buildIndex(id, { skipSummary: true });
    await fs.unlink(path.join(dir, 'renamed.js'));
    assert.equal((await buildIndex(id, { skipSummary: true, full: true })).totalFiles, 0);
  } finally {
    await deleteKb(id);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an unavailable source root does not erase an existing index', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-scan-failure-'));
  const dir = path.join(base, 'src');
  const id = randomUUID();
  try {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'a.js'), 'function keepWhenOffline() {}');
    await addKbForProject({ id, sourcePath: dir, includeGlobs: ['**/*.js'] });
    await buildIndex(id, { skipSummary: true });
    const before = await readFiles(id);
    await fs.rename(dir, path.join(base, 'offline'));
    await assert.rejects(buildIndex(id, { skipSummary: true }), { code: 'ENOENT' });
    assert.deepEqual(await readFiles(id), before);
    const rt = new KBRuntime(id);
    await rt.load();
    assert.equal(rt.getSymbolsByName('keepWhenOffline').length, 1);
  } finally {
    await deleteKb(id);
    await fs.rm(base, { recursive: true, force: true });
  }
});
