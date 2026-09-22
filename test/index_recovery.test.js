import './_learn_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { addKbForProject } from '../lib/index/registry.js';
import { buildIndex } from '../lib/index/indexer.js';
import { kbDir, deleteKb, readFiles, readKnowledge, readSymbolsShard } from '../lib/store/kb_store.js';
import { readDocIndex } from '../lib/store/doc_index_store.js';
import { KBRuntime } from '../lib/retrieval/kb_runtime.js';

const indexerUrl = new URL('../lib/index/indexer.js', import.meta.url).href;

function interruptedBuild(id, afterShard = false) {
  const code = `
    import fs from 'node:fs/promises';
    import { buildIndex } from ${JSON.stringify(indexerUrl)};
    const rename = fs.rename;
    fs.rename = async (...args) => {
      const result = await rename(...args);
      if (${afterShard} && /symbols\\.\\d+\\.json$/.test(args[1])) process.exit(93);
      return result;
    };
    await buildIndex(${JSON.stringify(id)}, {
      skipSummary: true, concurrency: 1, checkpointInterval: 1,
      onProgress(p) {
        if (!${afterShard} && p.file.startsWith('[checkpoint saved')) process.exit(93);
      },
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: process.env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 93, result.stderr);
}

for (const mode of ['initial', 'incremental', 'after-shard']) {
  test(`index recovery after interrupted ${mode} build preserves code and docs`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-recovery-'));
    const id = randomUUID();
    try {
      const codePath = path.join(dir, 'a.js');
      const docPath = path.join(dir, 'guide.md');
      await fs.writeFile(codePath, 'function beforeChange() { return 1; }');
      await fs.writeFile(docPath, '# Guide\nOld documentation');
      await addKbForProject({ id, sourcePath: dir, includeGlobs: ['**/*.js', '**/*.md'] });
      if (mode !== 'initial') await buildIndex(id, { skipSummary: true });
      await fs.writeFile(codePath, 'function afterChange() { return 2; }');
      await fs.writeFile(docPath, '# Guide\nUpdated documentation with `afterChange`');
      interruptedBuild(id, mode === 'after-shard');
      const checkpoint = JSON.parse(await fs.readFile(path.join(kbDir(id), 'checkpoint.json'), 'utf8'));
      assert.equal(checkpoint.phase, 'parse');
      assert.ok(checkpoint.processedFiles.length > 0);
      const stats = await buildIndex(id, { skipSummary: true });
      assert.equal(stats.totalFiles, 2);
      assert.equal(stats.totalSymbols, 1);
      const rt = new KBRuntime(id);
      await rt.load();
      assert.equal(rt.getSymbolsByName('afterChange').length, 1);
      assert.equal(rt.getSymbolsByName('beforeChange').length, 0);
      assert.match((await readKnowledge(id, 'eden', 'doc:guide.md')).intro, /Updated documentation/);
      assert.equal((await readDocIndex(id)).meta.docCount, 1);
      await assert.rejects(fs.stat(path.join(kbDir(id), 'checkpoint.json')), { code: 'ENOENT' });
    } finally {
      await deleteKb(id);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('legacy parse checkpoint cannot skip a registry hash with missing symbols', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-recovery-legacy-'));
  const id = randomUUID();
  try {
    await fs.writeFile(path.join(dir, 'a.js'), 'function restoreMe() {}');
    await addKbForProject({ id, sourcePath: dir, includeGlobs: ['**/*.js'] });
    await buildIndex(id, { skipSummary: true });
    const files = await readFiles(id);
    await fs.writeFile(path.join(kbDir(id), 'checkpoint.json'), JSON.stringify({
      phase: 'parse', processedFiles: [{ path: 'a.js', hash: files.byId[1].hash }],
    }));
    await fs.unlink(path.join(kbDir(id), 'symbols.0000.json'));
    await buildIndex(id, { skipSummary: true });
    assert.equal((await readSymbolsShard(id, 0)).symbols[0].name, 'restoreMe');
  } finally {
    await deleteKb(id);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
