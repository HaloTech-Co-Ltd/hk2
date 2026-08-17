import test from 'node:test';
import assert from 'node:assert/strict';

// MUST come before importing kb.js: isolates the project store + KB root.
import './_learn_setup.js';
import { __learnTest, cmdKb } from '../src/slash/kb.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as home from '../lib/config/home.js';

const { parseJsonArrayLoose } = __learnTest;

/* ---------------------- parseJsonArrayLoose (Bug 2 helper) --------------- */

test('parseJsonArrayLoose parses a bare JSON array', () => {
  const v = parseJsonArrayLoose('[{"id":"a"}]', '');
  assert.deepEqual(v, [{ id: 'a' }]);
});

test('parseJsonArrayLoose unwraps a fenced ```json block', () => {
  const v = parseJsonArrayLoose('```json\n[{"id":"a"}]\n```', '');
  assert.deepEqual(v, [{ id: 'a' }]);
});

test('parseJsonArrayLoose slices the array out of surrounding prose', () => {
  const v = parseJsonArrayLoose('Here is the extraction:\n[{"id":"a"}]\nHope this helps.', '');
  assert.deepEqual(v, [{ id: 'a' }]);
});

test('parseJsonArrayLoose falls back to the reasoning channel', () => {
  const v = parseJsonArrayLoose('', 'thinking about the docs... [{"id":"b"}] ...done');
  assert.deepEqual(v, [{ id: 'b' }]);
});

test('parseJsonArrayLoose prefers content over reasoning', () => {
  const v = parseJsonArrayLoose('[{"id":"content"}]', '[{"id":"reasoning"}]');
  assert.deepEqual(v, [{ id: 'content' }]);
});

test('parseJsonArrayLoose returns null for non-array JSON and garbage', () => {
  assert.equal(parseJsonArrayLoose('{"id":"object"}', ''), null);
  assert.equal(parseJsonArrayLoose('prose with no json', 'more prose'), null);
  assert.equal(parseJsonArrayLoose('', ''), null);
});

/* -------- studySources retry behavior (Bug 2 end-to-end, doc mode) ------- */

let __proj = null;
async function ensureProject(sourceDir) {
  __proj = await home.registerProject({ sourcePath: sourceDir, name: 'learn-retry-test-' + Date.now() });
  return __proj;
}

function makeRetryCtx({ outputs }) {
  const prints = [];
  let call = 0;
  return {
    prints,
    llm: {},
    streamLLM: async function* () {
      const o = outputs[Math.min(call, outputs.length - 1)];
      call++;
      if (o === null) throw new Error('boom');           // network failure
      else if (o.reasoning) yield { type: 'reasoning', text: o.reasoning };
      else yield { type: 'delta', text: o.text };
    },
    print: (s) => { prints.push(String(s)); },
    setPhase: () => {},
    confirm: async () => true,
    rt: null,
    getCurrentProject: async () => __proj,
  };
}

test('extraction retries with reasoning disabled and then accepts entries', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-retry-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\nSome knowledge here.\n');
    await ensureProject(tmpDir);
    // Call 1 (plan, reasoning on): plan. Call 2 (extract, reasoning on): garbage.
    // Call 3 (extract retry, reasoning OFF): valid JSON array -> must be used.
    const ctx = makeRetryCtx({ outputs: [
      { text: 'overview | intro batch | a.md\n' },   // plan (content)
      { text: 'I could not produce JSON, sorry.' },  // extract attempt 1: prose
      { text: '[{"id":"ok-entry","title":"T","intro":"I","keyFiles":[],"keySymbols":[],"keywords":[]}]' }, // retry
    ] });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md'), '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /extraction output unparseable — retrying with reasoning disabled/);
    assert.match(out, /\[ACCEPT\] ok-entry/);
    assert.doesNotMatch(out, /could not parse as JSON array — skipping/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('extraction skip message reports content/reasoning sizes and head (diagnostics)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-diag-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\nKnowledge.\n');
    await ensureProject(tmpDir);
    const ctx = makeRetryCtx({ outputs: [
      { text: 'overview | intro batch | a.md\n' },
      { text: 'no json anywhere at all' },   // attempt 1
      { text: 'still no json' },            // retry
    ] });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md'), '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /could not parse as JSON array — skipping\. content=\d+c reasoning=\d+c; head: /);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/* -------- Phase 1 doc-mode planning retry (Bug 1 end-to-end) -------------- */

test('doc-mode planning retries with reasoning disabled when the plan is unparseable', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-planretry-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# A\n\nfirst doc');
    await fs.writeFile(path.join(tmpDir, 'b.md'), '# B\n\nsecond doc');
    await ensureProject(tmpDir);
    // Call 1 (plan, reasoning ON): unparseable prose. Call 2 (plan retry,
    // reasoning OFF): valid pipe plan. Call 3+ (extract): [].
    const ctx = makeRetryCtx({ outputs: [
      { text: 'Let me think about how to group these documents nicely.' }, // plan attempt 1
      { text: 'docs | both docs | a.md, b.md\n' },                        // plan retry
      { text: '[]' },                                                      // extract
    ] });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--base-dir=' + tmpDir, '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /\[Phase 1\] No parseable plan from content or reasoning - retrying with reasoning disabled/);
    assert.match(out, /\[Phase 1\] LLM plan parsed: 1 batch/);
    // No per-file fallback batches: the retry plan grouped both files.
    assert.doesNotMatch(out, /falling back to per-file batches/);
    assert.match(out, /Study plan: 1 batch/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('doc-mode planning still falls back to per-file batches when both attempts fail', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-planfail-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# A\n\nfirst doc');
    await fs.writeFile(path.join(tmpDir, 'b.md'), '# B\n\nsecond doc');
    await ensureProject(tmpDir);
    const ctx = makeRetryCtx({ outputs: [
      { text: 'prose, no pipes' },   // plan attempt 1
      { text: 'more prose' },        // plan retry
      { text: '[]' },                // extract
    ] });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--base-dir=' + tmpDir, '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /falling back to per-file batches/);
    // reconcilePlan safety net: each file gets its own fallback batch.
    assert.match(out, /Study plan: 2 batches/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
