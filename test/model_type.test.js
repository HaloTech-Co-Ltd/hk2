/*-------------------------------------------------------------------------
 *
 * model-type enum regression tests.
 *
 * Models carry a `modelType` field so hk2 can apply model-specific behavior.
 * Only the supported set is accepted (case-insensitively normalized); unknown
 * values are rejected by /model add|set, and omitted values default to
 * `generic`. These tests lock in the enum + the two CLI entry points.
 *
 * Run:  node --test test/model_type.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  ensureHome, loadModels, saveModels, resolveModelRef,
  normalizeModelType, supportedModelTypes, DEFAULT_MODEL_TYPE,
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

test('supported model types are an exact, generic-terminated set', () => {
  const types = supportedModelTypes();
  assert.equal(types[types.length - 1], 'generic', 'generic is listed last');
  assert.ok(types.includes('generic'), 'generic is present');
  assert.equal(new Set(types).size, types.length, 'no duplicates');
  // Spot-check a few vendors so a typo in the list is caught early.
  for (const t of ['claude-fable-5', 'gpt-5.6-sol', 'deepseek-v4-pro', 'qwen-3.8-max', 'glm-5-turbo', 'kimi-k3']) {
    assert.ok(types.includes(t), `${t} is supported`);
  }
  assert.equal(DEFAULT_MODEL_TYPE, 'generic');
});

test('normalizeModelType is case-insensitive and rejects unknown values', () => {
  assert.equal(normalizeModelType('gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(normalizeModelType('GLM-5.2'), 'glm-5.2');
  assert.equal(normalizeModelType(' generic '), 'generic');
  assert.equal(normalizeModelType('bogus'), null);
  assert.equal(normalizeModelType(''), null);
  assert.equal(normalizeModelType(null), null);
});

test('/model add --model-type persists the normalized type', async () => {
  await emptyRegistry();
  const { ctx } = makeCtx();

  await dispatchSlash('/model add prov gpt-model --model-type=GPT-5.6-SOL', ctx);
  const { providers } = await loadModels();
  assert.equal(providers.prov.models[0].modelType, 'gpt-5.6-sol', 'type stored, case-normalized');
});

test('/model add --model-type with an unknown value is rejected and stores nothing', async () => {
  await emptyRegistry();
  const { ctx, prints } = makeCtx();

  await dispatchSlash('/model add prov bad --model-type=not-a-type', ctx);
  const { providers } = await loadModels();
  assert.deepEqual(Object.keys(providers), [], 'no provider created on invalid type');
  assert.ok(prints.some((p) => p.includes('Unknown model type: not-a-type')), 'prints the unknown type');
  assert.ok(prints.some((p) => p.includes('Supported model types:')), 'prints supported types');
});

test('/model add without --model-type defaults to generic', async () => {
  await emptyRegistry();
  const { ctx } = makeCtx();

  await dispatchSlash('/model add prov plain', ctx);
  const { providers } = await loadModels();
  assert.equal(providers.prov.models[0].modelType, 'generic', 'defaults to generic');
});

test('/model set --model-type updates the type and rejects unknown values', async () => {
  await emptyRegistry();
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/model add prov model --model-type=generic', ctx);

  await dispatchSlash('/model set prov/model --model-type=GLM-5.2', ctx);
  let { providers } = await loadModels();
  assert.equal(providers.prov.models[0].modelType, 'glm-5.2', 'set normalizes case');

  prints.length = 0;
  await dispatchSlash('/model set prov/model --model-type=oops', ctx);
  ({ providers } = await loadModels());
  assert.equal(providers.prov.models[0].modelType, 'glm-5.2', 'invalid set leaves the old value intact');
  assert.ok(prints.some((p) => p.includes('Unknown model type: oops')), 'prints the unknown type');
});

test('resolveModelRef carries modelType (and falls back to generic for legacy records)', async () => {
  await emptyRegistry();
  const { ctx } = makeCtx();
  await dispatchSlash('/model add prov typed --model-type=qwen-3.8-max', ctx);

  const typed = await resolveModelRef('prov/typed');
  assert.equal(typed.modelType, 'qwen-3.8-max', 'resolved config exposes modelType');

  // Legacy record with no modelType must fall back to generic.
  await saveModels({
    providers: {
      leg: { api: 'openai', baseUrl: '', apiKey: 'k', models: [{ id: 'old', name: 'old', contextWindow: 65536 }] },
    },
    default: 'leg/old',
  });
  const legacy = await resolveModelRef('leg/old');
  assert.equal(legacy.modelType, 'generic', 'legacy record resolves to generic');
});
