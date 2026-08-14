/*-------------------------------------------------------------------------
 *
 * model-options (--model-options) regression tests.
 *
 * Models carry a free-form `modelOptions` JSON object so different models can
 * have their own model-specific feature options (any number of keys).
 * `/model add` and `/model set` accept --model-options=<JSON object>; invalid
 * JSON (or non-object JSON) is rejected before anything is persisted; the
 * default is "no options" (empty). resolveModelRef exposes the parsed object
 * and falls back to {} for legacy records.
 *
 * Run:  node --test test/model_options.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  ensureHome, loadModels, saveModels, resolveModelRef,
  normalizeModelOptions,
} from '../lib/config/home.js';
import { createSession, buildCtx } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';

function makeCtx() {
  const session = createSession(null);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  return { ctx, prints };
}

async function emptyRegistry() {
  await ensureHome();
  await saveModels({ providers: {}, default: null });
}

test('normalizeModelOptions accepts JSON objects and rejects everything else', () => {
  assert.deepEqual(normalizeModelOptions('{"a":1,"b":"x","c":true}'), { a: 1, b: 'x', c: true });
  assert.deepEqual(normalizeModelOptions('{}'), {}, 'empty object is valid (= no options)');
  assert.deepEqual(normalizeModelOptions('{"nested":{"deep":[1,2]}}'), { nested: { deep: [1, 2] } });
  assert.deepEqual(normalizeModelOptions({ from: 'code' }), { from: 'code' }, 'already-parsed object round-trips');
  assert.equal(normalizeModelOptions('not json'), null, 'malformed JSON rejected');
  assert.equal(normalizeModelOptions('[1,2,3]'), null, 'arrays rejected');
  assert.equal(normalizeModelOptions('"str"'), null, 'scalars rejected');
  assert.equal(normalizeModelOptions(''), null);
  assert.equal(normalizeModelOptions(undefined), null);
});

test('/model add --model-options persists the parsed object', async () => {
  await emptyRegistry();
  const { ctx } = makeCtx();

  await dispatchSlash(`/model add prov qwen-max --model-options='{"enable_thinking":true,"top_k":50}'`, ctx);
  const { providers } = await loadModels();
  assert.deepEqual(providers.prov.models[0].modelOptions, { enable_thinking: true, top_k: 50 }, 'options stored as an object');
});

test('/model add --model-options with invalid JSON is rejected and stores nothing', async () => {
  await emptyRegistry();
  const { ctx, prints } = makeCtx();

  await dispatchSlash(`/model add prov bad --model-options='{"a":'`, ctx);
  const { providers } = await loadModels();
  assert.deepEqual(Object.keys(providers), [], 'no provider created on invalid options');
  assert.ok(prints.some((p) => p.includes('Invalid --model-options')), 'prints the invalid-options error');
});

test('/model add --model-options with non-object JSON (array) is rejected', async () => {
  await emptyRegistry();
  const { ctx, prints } = makeCtx();

  await dispatchSlash(`/model add prov bad --model-options='[1,2]'`, ctx);
  const { providers } = await loadModels();
  assert.deepEqual(Object.keys(providers), [], 'no provider created for array options');
  assert.ok(prints.some((p) => p.includes('Invalid --model-options')), 'prints the invalid-options error');
});

test('/model add without --model-options defaults to no options', async () => {
  await emptyRegistry();
  const { ctx } = makeCtx();

  await dispatchSlash('/model add prov plain', ctx);
  const { providers } = await loadModels();
  assert.equal(providers.prov.models[0].modelOptions, undefined, 'field left absent on a fresh entry');
  const cfg = await resolveModelRef('prov/plain');
  assert.deepEqual(cfg.modelOptions, {}, 'resolveModelRef defaults to empty object');
});

test('/model set --model-options replaces the value; invalid input leaves it intact', async () => {
  await emptyRegistry();
  const { ctx, prints } = makeCtx();
  await dispatchSlash(`/model add prov model --model-options='{"a":1}'`, ctx);

  await dispatchSlash(`/model set prov/model --model-options='{"thinking":{"type":"enabled"},"b":2}'`, ctx);
  let { providers } = await loadModels();
  assert.deepEqual(providers.prov.models[0].modelOptions, { thinking: { type: 'enabled' }, b: 2 }, 'set replaces wholesale (nested values ok)');

  // Invalid value: rejected, old value intact.
  prints.length = 0;
  await dispatchSlash(`/model set prov/model --model-options='nope'`, ctx);
  ({ providers } = await loadModels());
  assert.deepEqual(providers.prov.models[0].modelOptions, { thinking: { type: 'enabled' }, b: 2 }, 'invalid set leaves the old value intact');
  assert.ok(prints.some((p) => p.includes('Invalid --model-options')), 'prints the invalid-options error');

  // Explicit '{}' clears back to no options.
  await dispatchSlash(`/model set prov/model --model-options='{}'`, ctx);
  ({ providers } = await loadModels());
  assert.deepEqual(providers.prov.models[0].modelOptions, {}, "explicit '{}' clears the options");
});

test('/model set without --model-options keeps the current value', async () => {
  await emptyRegistry();
  const { ctx } = makeCtx();
  await dispatchSlash(`/model add prov model --model-options='{"keep":true}'`, ctx);

  await dispatchSlash('/model set prov/model --temperature=0.9', ctx);
  const { providers } = await loadModels();
  assert.deepEqual(providers.prov.models[0].modelOptions, { keep: true }, 'omitted flag keeps the current options');
});

test('resolveModelRef carries modelOptions and falls back to {} for legacy records', async () => {
  await emptyRegistry();

  await saveModels({
    providers: {
      leg: { api: 'openai', baseUrl: '', apiKey: 'k', models: [{ id: 'old', name: 'old', contextWindow: 65536 }] },
      typ: { api: 'openai', baseUrl: '', apiKey: 'k', models: [{ id: 'new', name: 'new', contextWindow: 65536, modelOptions: { x: 1, y: [1, 2] } }] },
    },
    default: 'typ/new',
  });
  const legacy = await resolveModelRef('leg/old');
  assert.deepEqual(legacy.modelOptions, {}, 'legacy record resolves to empty options');
  const typed = await resolveModelRef('typ/new');
  assert.deepEqual(typed.modelOptions, { x: 1, y: [1, 2] }, 'resolved config exposes the parsed options');
});

test('/model list and /model show display modelOptions', async () => {
  await emptyRegistry();
  const { ctx, prints } = makeCtx();
  await dispatchSlash(`/model add prov opt --model-options='{"enable_thinking":true}'`, ctx);
  await dispatchSlash('/model set-default prov/opt', ctx);

  prints.length = 0;
  await dispatchSlash('/model list', ctx);
  assert.ok(prints.some((p) => p.includes('modelOptions:') && p.includes('enable_thinking=true')), 'list shows the options');

  prints.length = 0;
  await dispatchSlash('/model show', ctx);
  assert.ok(prints.some((p) => p.includes('modelOptions:') && p.includes('enable_thinking=true')), 'show displays the options');
});
