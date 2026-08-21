/*-------------------------------------------------------------------------
 *
 * Unit tests for the MERGED /kb knowledge learn (src/slash/kb.js):
 *   - mode resolution (doc vs code) incl. legacy `init` alias routing
 *   - CODE mode end-to-end with a real built KB index (mock LLM)
 *   - plan validation fallback (hallucinated paths -> directory grouping)
 *   - planning budget / batch guidance scaling
 *
 * Run:  node --test test/learn_code_mode.test.js
 * ----------------------------------------------------------------------*/

// MUST be the first import: isolates HK2_HOME so the project store + KB root
// are per-test-run temp dirs.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cmdKb, __learnTest } from '../src/slash/kb.js';
import * as home from '../lib/config/home.js';
import { buildIndex } from '../lib/index/indexer.js';
import { addKbForProject } from '../lib/index/registry.js';

const { parsePlanText, planningBudgetFor, batchGuidanceFor, buildDirMap, expandDirPlan, dirTreePlan } = __learnTest;

/* ------------------------- mode resolution / routing -------------------- */

async function makeCodeProject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-code-'));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content);
  }
  const p = await home.registerProject({ sourcePath: dir, name: 'learn-code-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) });
  // registerProject points the global `current` at the newest project, but
  // tests share one HK2_HOME — pin current explicitly so getProjectOrFail()
  // resolves THIS project even if another test registers concurrently.
  await home.setCurrentProject(p.id);
  await addKbForProject(p);
  // skipSummary: no LLM summaries during index build (we pass no llm anyway).
  await buildIndex(p.id, { skipSummary: true });
  return { dir, p };
}

function makeMockCtx({ planOutput, extractOutput, prints = [] }) {
  let call = 0;
  return {
    prints,
    llm: { /* truthy presence check */ },
    streamLLM: async function* () {
      call++;
      if (call === 1) yield { type: 'delta', text: planOutput };
      else yield { type: 'delta', text: extractOutput };
    },
    print: (s) => { prints.push(String(s)); },
    setPhase: () => {},
    confirm: async () => true,
    rt: null,
  };
}

test('legacy /kb knowledge init alias routes to the merged learn handler (code mode)', async () => {
  const { dir, p } = await makeCodeProject({
    'src/one.js': 'export function alpha() { return 1; }\n',
    'src/two.js': 'export function beta() { return 2; }\n',
  });
  try {
    const prints = [];
    // ctx.rt must be populated: the real REPL provides the session runtime.
    const { getRuntime } = await import('../lib/retrieval/kb_runtime.js');
    const rt = await getRuntime(p.id);
    const ctx = makeMockCtx({
      planOutput: 'core | core helpers | src/one.js, src/two.js\n',
      extractOutput: '[]',
      prints,
    });
    ctx.rt = rt;
    await cmdKb(['knowledge', 'init', '--dry-run'], ctx);
    const out = prints.join('\n');
    assert.match(out, /mode=code/);
    assert.match(out, /LLM plan parsed: 1 batch/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('merged learn CODE mode plans + executes batches over indexed files', async () => {
  const { dir, p } = await makeCodeProject({
    'lib/util.js': 'export function Util() {}\n',
    'lib/net.js': 'export function Net() {}\n',
  });
  try {
    const prints = [];
    const { getRuntime } = await import('../lib/retrieval/kb_runtime.js');
    const rt = await getRuntime(p.id);
    const ctx = makeMockCtx({
      planOutput: 'lib-layer | library code | lib/util.js, lib/net.js\n',
      extractOutput: JSON.stringify([{
        id: 'lib-summary', title: 'Lib summary', intro: 'The lib layer.',
        keyFiles: ['lib/util.js'], keySymbols: ['Util'], keywords: ['lib'],
      }]),
      prints,
    });
    ctx.rt = rt;
    await cmdKb(['knowledge', 'learn', '--dry-run'], ctx);
    const out = prints.join('\n');
    assert.match(out, /mode=code/);
    assert.match(out, /deep-read: 2 file/);
    assert.match(out, /\[ACCEPT\] lib-summary/);
    assert.match(out, /\[dry-run\] 1 entries would have been validated & written/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CODE mode falls back to directory grouping when the plan is garbage', async () => {
  const { dir, p } = await makeCodeProject({
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': 'export const b = 2;\n',
    'doc/c.md': '# doc\n\nhello\n',
  });
  try {
    const prints = [];
    const { getRuntime } = await import('../lib/retrieval/kb_runtime.js');
    const rt = await getRuntime(p.id);
    const ctx = makeMockCtx({
      // Prose output — parsePlanText must reject it.
      planOutput: 'I will study this project carefully, starting with the core.\nThere are several modules here.',
      extractOutput: '[]',
      prints,
    });
    ctx.rt = rt;
    await cmdKb(['knowledge', 'learn', '--dry-run', '--no-survey'], ctx);
    const out = prints.join('\n');
    assert.match(out, /mode=code/);
    // Fallback plan: one batch per top-level directory.
    assert.match(out, /proceeding with deterministic directory grouping/);
    assert.match(out, /Study plan: 2 batches/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CODE mode --base-dir scopes the study to an indexed subdirectory', async () => {
  const { dir, p } = await makeCodeProject({
    'src/one.js': 'export function one() {}\n',
    'other/two.js': 'export function two() {}\n',
  });
  try {
    const prints = [];
    const { getRuntime } = await import('../lib/retrieval/kb_runtime.js');
    const rt = await getRuntime(p.id);
    const ctx = makeMockCtx({
      planOutput: 'src-only | src module | src/one.js\n',
      extractOutput: '[]',
      prints,
    });
    ctx.rt = rt;
    await cmdKb(['knowledge', 'learn', '--base-dir=src', '--dry-run'], ctx);
    const out = prints.join('\n');
    assert.match(out, /mode=code/);
    assert.match(out, /base-dir: src \(code scope, 1 indexed files?\)/);
    // Only the scoped file is studied.
    assert.match(out, /deep-read: 1 file/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------- parsePlanText hardening extras ------------------ */

test('parsePlanText normalizes full-width commas between files', () => {
  const plan = parsePlanText('topic-a | desc | src/x.js，src/y.js');
  assert.ok(plan);
  assert.deepEqual(plan[0].files, ['src/x.js', 'src/y.js']);
});

/* -------------------------- budget scaling ------------------------------ */

test('planningBudgetFor scales with file count and stays bounded', () => {
  assert.equal(planningBudgetFor(1), 65536);
  assert.equal(planningBudgetFor(500), 65536);
  assert.equal(planningBudgetFor(1000), 120000);
  assert.equal(planningBudgetFor(3500), 420000);
  assert.equal(planningBudgetFor(100000), 500000); // capped
});

test('batchGuidanceFor switches to explicit batch count above 900 files', () => {
  assert.equal(batchGuidanceFor(300), 'Aim for 5-30 batches.');
  assert.match(batchGuidanceFor(3500), /Aim for 117 batches/);
});

/* -------------------- hierarchical (large-project) planning -------------- */

const fakeRt = (paths) => ({
  files: { byId: Object.fromEntries(paths.map((p2, i) => [String(i + 1), { path: p2, symbolCount: 1 }])) },
});

test('buildDirMap aggregates files per directory with counts', () => {
  const dm = buildDirMap(fakeRt(['src/a.js', 'src/b.js', 'lib/c.js', 'top.md']));
  assert.equal(dm.fileCount, 4);
  assert.equal(dm.dirCount, 3); // src, lib, (root)
  const src = dm.dirs.find(d => d.dir === 'src');
  assert.equal(src.fileCount, 2);
  assert.ok(dm.text.includes('src/ (2 files'));
});

test('expandDirPlan expands directory tokens into concrete files and splits mega-batches', () => {
  const paths = [];
  for (let i = 0; i < 45; i++) paths.push(`src/big/f${i}.c`);
  paths.push('lib/x.c');
  const dm = buildDirMap(fakeRt(paths));
  const dirPlan = [
    { topic: 'big-module', description: 'the big one', files: ['src/big/'] },
    { topic: 'lib', description: 'lib', files: ['lib/'] },
    { topic: 'hallucinated', description: 'nope', files: ['does/not/exist/'] },
  ];
  const out = expandDirPlan(dirPlan, dm);
  // 45 files split into two 30-file chunks + 1 lib batch; hallucinated dir dropped.
  assert.equal(out.length, 3);
  assert.equal(out[0].files.length, 30);
  assert.equal(out[1].files.length, 15);
  assert.deepEqual(out[2].files, ['lib/x.c']);
  // Every file covered exactly once.
  const all = out.flatMap(b => b.files);
  assert.equal(new Set(all).size, 46);
});

test('dirTreePlan covers every file in <=30-file batches', () => {
  const paths = [];
  for (let i = 0; i < 70; i++) paths.push(`src/m${i}.c`);
  paths.push('doc/readme.md');
  const plan = dirTreePlan(fakeRt(paths));
  const all = plan.flatMap(b => b.files);
  assert.equal(all.length, 71);
  assert.equal(new Set(all).size, 71); // no dup, no loss
  for (const b of plan) assert.ok(b.files.length <= 30, `batch too big: ${b.files.length}`);
  assert.ok(plan.some(b => b.topic.startsWith('src-')), 'src dir becomes a topic');
});

test('expandDirPlan keeps explicit file paths the LLM echoed', () => {
  const dm = buildDirMap(fakeRt(['src/a.js', 'src/b.js']));
  const out = expandDirPlan([{ topic: 't', description: '', files: ['src/a.js'] }], dm);
  assert.deepEqual(out[0].files, ['src/a.js']);
});
