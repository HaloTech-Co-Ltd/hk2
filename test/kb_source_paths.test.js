import './_learn_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HK2_HOME } from '../lib/config/home.js';
import { addKbForProject } from '../lib/index/registry.js';
import { buildIndex } from '../lib/index/indexer.js';
import { deleteKb, readFiles, writeFiles } from '../lib/store/kb_store.js';
import { KBRuntime } from '../lib/retrieval/kb_runtime.js';
import { buildTools } from '../lib/agent/tools.js';
import { buildRequestGraph } from '../lib/agent/graph.js';
import { resetPermissionService } from '../lib/config/setting.js';

test('KB content checks and slices use sourceRoot and named extra roots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-source-paths-'));
  const project = {
    id: randomUUID(), sourcePath: dir, sourceRoot: 'src',
    extraRoots: [{ name: 'aux', relRoot: 'support' }],
    includeGlobs: ['**/*.js', '**/*.md'], excludeGlobs: [],
  };
  const oldSource = process.env.HK2_PROJECT_SOURCE;
  const oldId = process.env.HK2_PROJECT_ID;
  process.env.HK2_PROJECT_SOURCE = dir;
  process.env.HK2_PROJECT_ID = project.id;
  const config = path.join(HK2_HOME, 'settings', project.id, 'setting.json');
  try {
    for (const sub of ['src', 'support', 'docs']) await fs.mkdir(path.join(dir, sub));
    await fs.writeFile(path.join(dir, 'src/a.js'), 'function mainNeedle() { return "ACTUAL-SOURCE"; }\n');
    await fs.writeFile(path.join(dir, 'support/b.js'), 'function extraNeedle() { return "EXTRA-SOURCE"; }\n');
    await fs.writeFile(path.join(dir, 'a.js'), 'WRONG-SAME-NAME-FILE');
    await fs.writeFile(path.join(dir, 'docs/guide.md'), '# mainNeedle\nPUBLIC-PROJECT-DOC');
    await addKbForProject(project);
    await buildIndex(project.id, { skipSummary: true });
    const rt = new KBRuntime(project.id);
    await rt.load();
    const search = buildTools(rt, {}).find(t => t.name === 'kb_search');
    resetPermissionService();
    let result = await search.execute({ query: 'mainNeedle extraNeedle', skip_rewrite: true, with_slice: true });
    assert.match(result.results.find(r => r.name === 'mainNeedle').slice, /ACTUAL-SOURCE/);
    assert.match(result.results.find(r => r.name === 'extraNeedle').slice, /EXTRA-SOURCE/);
    assert.doesNotMatch(JSON.stringify(result), /WRONG-SAME-NAME/);
    let graph = await buildRequestGraph(rt, 'mainNeedle', { project });
    assert.ok(graph.docs.some(d => d.text.includes('PUBLIC-PROJECT-DOC')));

    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, JSON.stringify({ permissions: [
      { path: path.join(dir, 'src'), deny: 'rwx' },
      { path: path.join(dir, 'support'), deny: 'rwx' },
      { path: path.join(dir, 'docs'), deny: 'rwx' },
    ] }));
    resetPermissionService();
    for (const deleted of [false, true]) {
      if (deleted) {
        await fs.unlink(path.join(dir, 'src/a.js'));
        await fs.unlink(path.join(dir, 'support/b.js'));
      }
      result = await search.execute({ query: 'mainNeedle extraNeedle', skip_rewrite: true, with_slice: true });
      assert.equal(result.count, 2);
      for (const row of result.results) {
        assert.equal(row.snippet, undefined);
        assert.equal(row.slice, undefined);
      }
      assert.deepEqual(new Set(result.permissionFiltered), new Set([
        path.join(dir, 'src/a.js'), path.join(dir, 'support/b.js'),
      ]));
      graph = await buildRequestGraph(rt, 'mainNeedle extraNeedle', { project });
      assert.ok(graph.symbols.every(s => s.snippet === undefined));
      assert.equal(graph.docs.length, 0);
    }
  } finally {
    if (oldSource === undefined) delete process.env.HK2_PROJECT_SOURCE;
    else process.env.HK2_PROJECT_SOURCE = oldSource;
    if (oldId === undefined) delete process.env.HK2_PROJECT_ID;
    else process.env.HK2_PROJECT_ID = oldId;
    resetPermissionService();
    await fs.rm(path.dirname(config), { recursive: true, force: true });
    await deleteKb(project.id);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('named roots cannot shadow a denied primary directory, including legacy snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-root-shadow-'));
  const project = {
    id: randomUUID(), sourcePath: dir, sourceRoot: 'src',
    extraRoots: [{ name: 'aux', relRoot: 'support' }], includeGlobs: ['**/*.js'],
  };
  const oldSource = process.env.HK2_PROJECT_SOURCE;
  const oldId = process.env.HK2_PROJECT_ID;
  process.env.HK2_PROJECT_SOURCE = dir;
  process.env.HK2_PROJECT_ID = project.id;
  const config = path.join(HK2_HOME, 'settings', project.id, 'setting.json');
  try {
    await fs.mkdir(path.join(dir, 'src/aux'), { recursive: true });
    await fs.mkdir(path.join(dir, 'support'));
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, JSON.stringify({ permissions: [{ path: path.join(dir, 'src'), deny: 'rwx' }] }));
    await fs.writeFile(path.join(dir, 'src/aux/hidden.js'), 'function hiddenNeedle() { return "PRIVATE"; }');
    await addKbForProject(project);
    await buildIndex(project.id, { skipSummary: true });
    resetPermissionService();
    for (const legacy of [false, true]) {
      if (legacy) {
        const files = await readFiles(project.id);
        delete files.sourcePaths;
        await writeFiles(project.id, files);
      }
      const rt = new KBRuntime(project.id);
      await rt.load();
      const search = buildTools(rt, {}).find(t => t.name === 'kb_search');
      const result = await search.execute({ query: 'hiddenNeedle', skip_rewrite: true, with_slice: true });
      assert.equal(result.count, 1);
      assert.equal(result.results[0].snippet, undefined);
      assert.equal(result.results[0].slice, undefined);
    }
    // Even an unchanged incremental update backfills old file provenance.
    await buildIndex(project.id, { skipSummary: true });
    const before = await readFiles(project.id);
    assert.equal(before.sourcePaths['aux/hidden.js'], path.join(dir, 'src/aux/hidden.js'));
    await fs.writeFile(path.join(dir, 'support/hidden.js'), 'function publicNeedle() {}');
    await assert.rejects(buildIndex(project.id, { skipSummary: true }), /ambiguous indexed path/);
    assert.deepEqual(await readFiles(project.id), before);
  } finally {
    if (oldSource === undefined) delete process.env.HK2_PROJECT_SOURCE;
    else process.env.HK2_PROJECT_SOURCE = oldSource;
    if (oldId === undefined) delete process.env.HK2_PROJECT_ID;
    else process.env.HK2_PROJECT_ID = oldId;
    resetPermissionService();
    await fs.rm(path.dirname(config), { recursive: true, force: true });
    await deleteKb(project.id);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
