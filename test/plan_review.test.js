/*-------------------------------------------------------------------------
 *
 * Plan Review tests.
 *
 * Two concerns:
 *   1. Config: the `plan-review` phase is registered in PHASE_KEYS so the
 *      /model set-phase machinery (normalizePhaseName, supportedPhaseNames,
 *      get/set/clearPhaseModelRef) treats it exactly like `rewrite-query`.
 *   2. reviewPlan(): parses the reviewer's JSON into issues, coerces bad
 *      shapes safely, and degrades gracefully (returns {ok:true}) on any
 *      failure (empty plan, non-JSON output, LLM exception, ok without
 *      issues, not-ok with no usable issues) so the caller never blocks.
 *
 * The review LLM is faked with a tiny async generator that yields delta
 * events, matching the LLMClient.stream contract reviewPlan relies on.
 *
 * Run:  node --test test/plan_review.test.js
 *----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ensureHome, loadModels, saveModels,
  registerProject, setCurrentProject, getCurrentProject,
  getPhaseModelRef, setPhaseModelRef, clearPhaseModelRef,
  normalizePhaseName, supportedPhaseNames,
} from '../lib/config/home.js';
import { createSession, buildCtx, reloadAll } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';
import { reviewPlan } from '../lib/agent/plan_review.js';

let __seq = 0;
async function makeSourceDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hk2-plrev-${name}-`));
}

async function seedModels() {
  await ensureHome();
  await saveModels({
    providers: {
      provA: {
        api: 'openai',
        baseUrl: 'http://a.example/v1',
        apiKey: 'sk-a',
        models: [{ id: 'model-a', name: 'A', contextWindow: 8192, temperature: 0.2 }],
      },
      provB: {
        api: 'openai',
        baseUrl: 'http://b.example/v1',
        apiKey: 'sk-b',
        models: [{ id: 'model-b', name: 'B', contextWindow: 8192, temperature: 0.2 }],
      },
    },
    default: 'provA/model-a',
  });
}

async function makeProject(name) {
  const n = ++__seq;
  const src = await makeSourceDir(`${name}${n}`);
  return registerProject({ name: `${name}${n}`, sourcePath: src });
}

// Fake LLM: yields the given text as a single delta event, matching the
// {type:'delta', text} contract reviewPlan consumes from llm.stream().
function fakeLlm(outputText) {
  return {
    stream: async function* () {
      yield { type: 'delta', text: outputText };
    },
  };
}

// Fake LLM that throws inside stream - simulates an LLM call failure.
function throwingLlm(err = new Error('boom')) {
  return {
    stream: async function* () { throw err; },
  };
}

// ---------------------------------------------------------------------------
// 1. Config: plan-review phase is registered like rewrite-query
// ---------------------------------------------------------------------------

test('normalizePhaseName maps plan-review to the storage key', () => {
  assert.equal(normalizePhaseName('plan-review'), 'planReview');
  assert.equal(normalizePhaseName('Plan-Review'), 'planReview'); // case-insensitive
  assert.equal(normalizePhaseName('plan_review'), null); // underscore form NOT accepted
  assert.equal(normalizePhaseName(''), null);
  assert.equal(normalizePhaseName(null), null);
});

test('supportedPhaseNames advertises plan-review', () => {
  const names = supportedPhaseNames();
  assert.ok(names.includes('plan-review'), `expected plan-review in ${JSON.stringify(names)}`);
  assert.ok(names.includes('rewrite-query'), 'rewrite-query still present');
});

test('setPhaseModelRef persists and getPhaseModelRef reads back plan-review', async () => {
  await seedModels();
  const p = await makeProject('setget');
  assert.equal(getPhaseModelRef(p, 'plan-review'), null, 'no override before set');

  const updated = await setPhaseModelRef(p.id, 'plan-review', 'provB/model-b');
  assert.ok(updated, 'setPhaseModelRef returned the updated record');
  assert.equal(updated.phaseModels?.planReview, 'provB/model-b', 'stored under the storage key');
  assert.equal(getPhaseModelRef(updated, 'plan-review'), 'provB/model-b', 'read back via CLI name');

  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'plan-review'), 'provB/model-b', 'persisted across reload');
});

test('clearPhaseModelRef removes the plan-review override and preserves rewrite-query', async () => {
  await seedModels();
  const p = await makeProject('clear');
  await setPhaseModelRef(p.id, 'plan-review', 'provB/model-b');
  await setPhaseModelRef(p.id, 'rewrite-query', 'provB/model-b');

  const cleared = await clearPhaseModelRef(p.id, 'plan-review');
  assert.ok(cleared, 'clear returned the updated record');
  assert.equal(getPhaseModelRef(cleared, 'plan-review'), null, 'plan-review override removed');
  assert.equal(getPhaseModelRef(cleared, 'rewrite-query'), 'provB/model-b', 'rewrite-query preserved');
});

test('plan-review override is per-project', async () => {
  await seedModels();
  const a = await makeProject('projA');
  const b = await makeProject('projB');

  await setPhaseModelRef(a.id, 'plan-review', 'provB/model-b');
  const { getProject } = await import('../lib/config/home.js');
  assert.equal(getPhaseModelRef(await getProject(a.id), 'plan-review'), 'provB/model-b', 'A has the override');
  assert.equal(getPhaseModelRef(await getProject(b.id), 'plan-review'), null, 'B unaffected');
});

test('/model set-phase persists plan-review on the current project', async () => {
  await seedModels();
  const p = await makeProject('cli');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  const handled = await dispatchSlash('/model set-phase --phase=plan-review provB/model-b', ctx);
  assert.equal(handled, true, 'dispatchSlash handled the command');
  assert.ok(
    prints.some((s) => s.includes('Phase model set') && s.includes('plan-review') && s.includes('provB/model-b')),
    `expected a confirmation, got: ${JSON.stringify(prints)}`,
  );

  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'plan-review'), 'provB/model-b', 'persisted on the project');
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session model unchanged');
});

test('/model set-phase rejects an unknown phase still', async () => {
  await seedModels();
  const p = await makeProject('badphase');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/model set-phase --phase=bogus provB/model-b', ctx);
  assert.ok(prints.some((s) => s.includes('Unknown phase')), `expected unknown-phase error, got: ${JSON.stringify(prints)}`);
});

// ---------------------------------------------------------------------------
// 2. reviewPlan(): JSON parsing, coercion, graceful fallback
// ---------------------------------------------------------------------------

test('reviewPlan returns ok with no issues when the reviewer approves', async () => {
  const out = '{"ok": true, "issues": []}';
  const result = await reviewPlan(fakeLlm(out), 'Summary: do X\nStep 1: ...');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reviewPlan parses issues when the reviewer finds problems', async () => {
  const out = JSON.stringify({
    ok: false,
    issues: [
      {
        title: 'Step 2 depends on Step 4',
        detail: 'Step 2 needs the migration from Step 4 to exist first.',
        suggestion: 'Reorder so Step 4 runs before Step 2.',
      },
      {
        title: 'Step 1 strategy is vague',
        detail: '"refactor" is not actionable as a strategy.',
        suggestion: 'Specify which module and the target structure.',
      },
    ],
  });
  const result = await reviewPlan(fakeLlm(out), 'Summary: ...');
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].title, 'Step 2 depends on Step 4');
  assert.equal(result.issues[0].suggestion, 'Reorder so Step 4 runs before Step 2.');
  assert.equal(result.issues[1].detail.includes('not actionable'), true);
});

test('reviewPlan tolerates markdown-fenced JSON', async () => {
  const out = '```json\n{"ok": false, "issues": [{"title": "x", "detail": "d", "suggestion": "s"}]}\n```';
  const result = await reviewPlan(fakeLlm(out), 'Summary: ...');
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].title, 'x');
});

test('reviewPlan drops issues missing a title', async () => {
  const out = JSON.stringify({
    ok: false,
    issues: [
      { title: 'keep me', detail: 'd', suggestion: 's' },
      { detail: 'no title', suggestion: 's' }, // dropped: no title
      { title: '   ', detail: 'd', suggestion: 's' }, // dropped: blank title
    ],
  });
  const result = await reviewPlan(fakeLlm(out), 'Summary: ...');
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].title, 'keep me');
});

test('reviewPlan treats ok-without-issues and not-ok-with-no-issues as ok', async () => {
  // Missing ok field -> treated as ok.
  let result = await reviewPlan(fakeLlm('{"issues": []}'), 'Summary: ...');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  // ok explicitly true.
  result = await reviewPlan(fakeLlm('{"ok": true, "issues": [{"title":"x"}]}'), 'Summary: ...');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  // not-ok but no usable issues -> treated as ok to avoid a dead-end prompt.
  result = await reviewPlan(fakeLlm('{"ok": false, "issues": []}'), 'Summary: ...');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  // not-ok but issues is not an array -> ok.
  result = await reviewPlan(fakeLlm('{"ok": false, "issues": "string"}'), 'Summary: ...');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reviewPlan returns ok on a non-JSON LLM output', async () => {
  const result = await reviewPlan(fakeLlm('sorry, I cannot review that'), 'Summary: ...');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reviewPlan returns ok when the LLM stream throws', async () => {
  const result = await reviewPlan(throwingLlm(new Error('network down')), 'Summary: ...');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reviewPlan returns ok for an empty plan text', async () => {
  const result = await reviewPlan(fakeLlm('{"ok": false, "issues": [{"title":"x"}]}'), '');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  const result2 = await reviewPlan(fakeLlm('{"ok": false, "issues": [{"title":"x"}]}'), '   ');
  assert.equal(result2.ok, true);
});

test('reviewPlan forwards the abort signal to the LLM stream', async () => {
  let receivedSignal = null;
  const llm = {
    stream: async function* (_messages, opts) {
      receivedSignal = opts?.signal;
      yield { type: 'delta', text: '{"ok": true, "issues": []}' };
    },
  };
  const ac = new AbortController();
  await reviewPlan(llm, 'Summary: ...', { signal: ac.signal });
  assert.equal(receivedSignal, ac.signal, 'signal was forwarded to the stream');
});
