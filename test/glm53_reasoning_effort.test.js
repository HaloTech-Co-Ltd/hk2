/*-------------------------------------------------------------------------
 *
 * glm-5.3 / glm-5.3-flash (BigModel) reasoning_effort regression tests.
 *
 * Model types glm-5.3 and glm-5.3-flash (BigModel) declare model-specific
 * features (MODEL_TYPE_FEATURES in lib/config/home.js):
 *   - reasoning defaults to ON (deep-reasoning model)
 *   - option `reasoning_effort` ∈ { max (default/recommended), high, low }
 *
 * These tests lock in the four layers:
 *   1. config: enum defaults/normalization, validation, resolveModelRef
 *   2. CLI: /model add|set reject invalid effort values; glm-5.3 add
 *      defaults reasoning on
 *   3. adapter wire mapping: applyModelTypeFeatures / streamOpenAI inject
 *      thinking:{type:'enabled'} + reasoning_effort ONLY for the glm-5.3
 *      family (glm-5.3 / glm-5.3-flash)
 *   4. client: LLMClient forwards modelType/modelOptions to the adapter
 *
 * Run:  node --test test/glm53_reasoning_effort.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  ensureHome, loadModels, saveModels, resolveModelRef,
  effectiveModelOptions, validateModelOptionsForType,
  modelTypeDefaultReasoning, modelTypeFeatures,
} from '../lib/config/home.js';
import { streamOpenAI, completeOpenAI, applyModelTypeFeatures } from '../lib/llm/openai_adapter.js';
import { streamAnthropic } from '../lib/llm/anthropic_adapter.js';
import { LLMClient } from '../lib/llm/client.js';
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

/* ------------------------------------------------------------------ */
/* 1. Config layer                                                     */
/* ------------------------------------------------------------------ */

test('glm-5.3 declares reasoning_effort (max/high/low, default max) and default reasoning on', () => {
  const feats = modelTypeFeatures('glm-5.3');
  assert.ok(feats, 'glm-5.3 has declared features');
  assert.deepEqual(feats.options.reasoning_effort.values, ['max', 'high', 'low']);
  assert.equal(feats.options.reasoning_effort.default, 'max');
  assert.equal(modelTypeDefaultReasoning('glm-5.3'), true);
  assert.equal(modelTypeDefaultReasoning('glm-5.2'), false, 'other types unaffected');
  assert.equal(modelTypeDefaultReasoning('generic'), false);
  assert.equal(modelTypeFeatures('glm-5.2'), null, 'no feature block for other types');
  assert.equal(modelTypeFeatures('GLM-5.3').options.reasoning_effort.default, 'max', 'case-insensitive');
});

test('glm-5.3-flash declares the same feature set as glm-5.3', () => {
  const feats = modelTypeFeatures('glm-5.3-flash');
  assert.ok(feats, 'glm-5.3-flash has declared features');
  assert.deepEqual(feats.options.reasoning_effort.values, ['max', 'high', 'low']);
  assert.equal(feats.options.reasoning_effort.default, 'max');
  assert.equal(modelTypeDefaultReasoning('glm-5.3-flash'), true, 'flash also defaults reasoning on');
  assert.equal(effectiveModelOptions('glm-5.3-flash', { reasoning_effort: 'HIGH' }).reasoning_effort, 'high', 'case-normalized');
  assert.equal(validateModelOptionsForType('glm-5.3-flash', { reasoning_effort: 'medium' })?.includes('reasoning_effort must be one of'), true, 'enum validation applies');
});

test('effectiveModelOptions fills the default and normalizes case for glm-5.3', () => {
  assert.equal(effectiveModelOptions('glm-5.3', {}).reasoning_effort, 'max', 'default is max');
  assert.equal(effectiveModelOptions('glm-5.3', undefined).reasoning_effort, 'max', 'missing options → default');
  assert.equal(effectiveModelOptions('glm-5.3', { reasoning_effort: 'high' }).reasoning_effort, 'high');
  assert.equal(effectiveModelOptions('glm-5.3', { reasoning_effort: 'LOW' }).reasoning_effort, 'low', 'case-normalized');
  assert.equal(effectiveModelOptions('glm-5.3', { reasoning_effort: 'bogus' }).reasoning_effort, 'max', 'hand-edited junk falls back to default');
  // Unknown keys pass through untouched; other types are not governed.
  assert.deepEqual(effectiveModelOptions('glm-5.3', { top_k: 5 }), { top_k: 5, reasoning_effort: 'max' });
  assert.deepEqual(effectiveModelOptions('glm-5.2', { reasoning_effort: 'high' }), { reasoning_effort: 'high' }, 'non-5.3 type leaves options alone');
});

test('validateModelOptionsForType accepts the enum and rejects everything else', () => {
  assert.equal(validateModelOptionsForType('glm-5.3', { reasoning_effort: 'max' }), null);
  assert.equal(validateModelOptionsForType('glm-5.3', { reasoning_effort: 'High' }), null, 'case-insensitive');
  assert.ok(validateModelOptionsForType('glm-5.3', { reasoning_effort: 'medium' }).includes('reasoning_effort must be one of'), 'medium rejected');
  assert.ok(validateModelOptionsForType('glm-5.3', { reasoning_effort: 42 }).includes('reasoning_effort must be one of'), 'numbers rejected');
  assert.equal(validateModelOptionsForType('glm-5.3', { top_k: 50 }), null, 'unrelated keys are free-form');
  assert.equal(validateModelOptionsForType('glm-5.2', { reasoning_effort: 'medium' }), null, 'types without features skip validation');
});

test('resolveModelRef resolves glm-5.3 with normalized options and reasoning on', async () => {
  await emptyRegistry();
  await saveModels({
    providers: {
      bigmodel: {
        api: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'k',
        models: [
          { id: 'glm-5.3', name: 'glm-5.3', contextWindow: 131072, modelType: 'glm-5.3', modelOptions: { reasoning_effort: 'LOW' } },
          { id: 'bare', name: 'glm-5.3', contextWindow: 131072, modelType: 'glm-5.3' },
        ],
      },
    },
    default: 'bigmodel/glm-5.3',
  });
  const cfg = await resolveModelRef('bigmodel/glm-5.3');
  assert.equal(cfg.modelType, 'glm-5.3');
  assert.equal(cfg.modelOptions.reasoning_effort, 'low', 'stored value normalized');
  assert.equal(cfg.enableReasoning, true, 'glm-5.3 defaults reasoning on');

  const bare = await resolveModelRef('bigmodel/bare');
  assert.equal(bare.modelOptions.reasoning_effort, 'max', 'no stored options → default max');
  assert.equal(bare.enableReasoning, true);

  // Explicit reasoning:false on the entry still wins over the type default.
  const { providers } = await loadModels();
  providers.bigmodel.models[1].reasoning = false;
  await saveModels({ providers, default: 'bigmodel/glm-5.3' });
  const off = await resolveModelRef('bigmodel/bare');
  assert.equal(off.enableReasoning, false, 'explicit reasoning:false wins');
});

/* ------------------------------------------------------------------ */
/* 2. CLI layer                                                        */
/* ------------------------------------------------------------------ */

test('/model add --model-type=glm-5.3 defaults reasoning on and validates reasoning_effort', async () => {
  await emptyRegistry();
  const { ctx, prints } = makeCtx();

  await dispatchSlash('/model add bigmodel glm-5.3 --model-type=glm-5.3', ctx);
  const { providers } = await loadModels();
  assert.equal(providers.bigmodel.models[0].reasoning, true, 'glm-5.3 add defaults reasoning on');

  // Valid effort value persists.
  await dispatchSlash(`/model set bigmodel/glm-5.3 --model-options='{"reasoning_effort":"high"}'`, ctx);
  let { providers: p2 } = await loadModels();
  assert.deepEqual(p2.bigmodel.models[0].modelOptions, { reasoning_effort: 'high' }, 'valid effort stored');

  // Invalid effort value is rejected, nothing persisted.
  prints.length = 0;
  await dispatchSlash(`/model set bigmodel/glm-5.3 --model-options='{"reasoning_effort":"medium"}'`, ctx);
  let { providers: p3 } = await loadModels();
  assert.deepEqual(p3.bigmodel.models[0].modelOptions, { reasoning_effort: 'high' }, 'invalid effort leaves the old value intact');
  assert.ok(prints.some((p) => p.includes('reasoning_effort must be one of: max, high, low')), 'prints the enum error');

  // add path rejects invalid effort too.
  prints.length = 0;
  await dispatchSlash(`/model add bigmodel bad --model-type=glm-5.3 --model-options='{"reasoning_effort":"extreme"}'`, ctx);
  const { providers: p4 } = await loadModels();
  assert.equal((p4.bigmodel.models || []).some(m => m.id === 'bad'), false, 'invalid add stores nothing');

  // glm-5.3-flash add also defaults reasoning on.
  await dispatchSlash('/model add bigmodel flash --model-type=glm-5.3-flash', ctx);
  const { providers: p6 } = await loadModels();
  const flash = p6.bigmodel.models.find(m => m.id === 'flash');
  assert.equal(flash.reasoning, true, 'glm-5.3-flash add defaults reasoning on');
  assert.equal(flash.modelType, 'glm-5.3-flash');

  // set --model-options validated against the STORED type when --model-type is absent.
  prints.length = 0;
  await dispatchSlash(`/model add bigmodel ok2 --model-type=glm-5.3`, ctx);
  await dispatchSlash(`/model set bigmodel/ok2 --model-options='{"reasoning_effort":"nope"}'`, ctx);
  const { providers: p5 } = await loadModels();
  const ok2 = p5.bigmodel.models.find(m => m.id === 'ok2');
  assert.equal(ok2.modelOptions, undefined, 'set without --model-type still validates against the stored glm-5.3 type');
  assert.ok(prints.some((p) => p.includes('reasoning_effort must be one of')), 'prints the enum error');
});

/* ------------------------------------------------------------------ */
/* 3. Adapter wire mapping                                             */
/* ------------------------------------------------------------------ */

test('applyModelTypeFeatures maps glm-5.3 to thinking + reasoning_effort (and only glm-5.3)', () => {
  const body = {};
  applyModelTypeFeatures(body, { modelType: 'glm-5.3', modelOptions: {}, enableReasoning: true });
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'max', 'defaults to the recommended max');

  const low = {};
  applyModelTypeFeatures(low, { modelType: 'glm-5.3', modelOptions: { reasoning_effort: 'low' }, enableReasoning: true });
  assert.equal(low.reasoning_effort, 'low');

  const off = {};
  applyModelTypeFeatures(off, { modelType: 'glm-5.3', modelOptions: { reasoning_effort: 'low' }, enableReasoning: false });
  assert.equal('thinking' in off, false, 'reasoning off → no thinking block');
  assert.equal('reasoning_effort' in off, false, 'reasoning off → no effort field');

  const other = {};
  applyModelTypeFeatures(other, { modelType: 'glm-5.2', modelOptions: { reasoning_effort: 'low' }, enableReasoning: true });
  assert.deepEqual(other, {}, 'non-glm-5.3 types are untouched');

  // glm-5.3-flash shares the same wire mapping.
  const flash = {};
  applyModelTypeFeatures(flash, { modelType: 'glm-5.3-flash', modelOptions: { reasoning_effort: 'low' }, enableReasoning: true });
  assert.deepEqual(flash.thinking, { type: 'enabled' }, 'flash gets the thinking block');
  assert.equal(flash.reasoning_effort, 'low');
});

function makeSseResp(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: enc.encode(chunks[i++]) }
          : { done: true, value: undefined }),
      }),
    },
  };
}

async function captureStreamBody(args) {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return makeSseResp(['data: [DONE]\n\n']);
  };
  try {
    for await (const _evt of streamOpenAI({ timeoutMs: 1000, ...args })) { /* drain */ }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'fetch was not called');
  return captured;
}

test('streamOpenAI sends thinking + reasoning_effort for glm-5.3 end to end', async () => {
  const base = {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'k',
    model: 'glm-5.3',
    messages: [{ role: 'user', content: '分析一下这道数学题的解题思路' }],
    maxChars: 8192,
    enableReasoning: true,
  };
  const glm = await captureStreamBody({ ...base, modelType: 'glm-5.3', modelOptions: {} });
  assert.deepEqual(glm.thinking, { type: 'enabled' });
  assert.equal(glm.reasoning_effort, 'max');

  const high = await captureStreamBody({ ...base, modelType: 'glm-5.3', modelOptions: { reasoning_effort: 'high' } });
  assert.equal(high.reasoning_effort, 'high');

  const off = await captureStreamBody({ ...base, modelType: 'glm-5.3', modelOptions: { reasoning_effort: 'high' }, enableReasoning: false });
  assert.equal('thinking' in off, false);
  assert.equal('reasoning_effort' in off, false);
  assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false }, 'the existing off-switch keeps working');

  const plain = await captureStreamBody({ ...base, model: 'gpt-4o', modelType: 'gpt-5.5', modelOptions: {} });
  assert.equal('thinking' in plain, false, 'other types get no thinking block');
  assert.equal('reasoning_effort' in plain, false, 'other types get no effort field');

  const flash = await captureStreamBody({ ...base, model: 'glm-5.3-flash', modelType: 'glm-5.3-flash', modelOptions: {} });
  assert.deepEqual(flash.thinking, { type: 'enabled' }, 'flash gets the thinking block end to end');
  assert.equal(flash.reasoning_effort, 'max', 'flash defaults to max');
});

test('LLMClient forwards modelType/modelOptions to the OpenAI adapter', async () => {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return makeSseResp(['data: [DONE]\n\n']);
  };
  try {
    const client = new LLMClient({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'k',
      model: 'glm-5.3',
      style: 'openai',
      modelType: 'glm-5.3',
      modelOptions: { reasoning_effort: 'low' },
      enableReasoning: true,
    });
    for await (const _evt of client.stream([{ role: 'user', content: 'hi' }])) { /* drain */ }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'fetch was not called');
  assert.deepEqual(captured.thinking, { type: 'enabled' });
  assert.equal(captured.reasoning_effort, 'low');
});

test('completeOpenAI also maps glm-5.3 features (non-streaming path)', async () => {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' } }] }) };
  };
  try {
    await completeOpenAI({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'k', model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      modelType: 'glm-5.3', modelOptions: { reasoning_effort: 'high' }, enableReasoning: true, timeoutMs: 1000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(captured.thinking, { type: 'enabled' });
  assert.equal(captured.reasoning_effort, 'high');
});

/* ------------------------------------------------------------------ */
/* 4. Anthropic adapter                                                */
/* ------------------------------------------------------------------ */

function makeAnthropicResp(events) {
  const enc = new TextEncoder();
  const frames = events.map(e => (e.event ? `event: ${e.event}\n` : '') + `data: ${JSON.stringify(e.data)}\n\n`).join('');
  let sent = false;
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: enc.encode(frames) };
        },
      }),
    },
  };
}

async function captureAnthropicBody(args) {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return makeAnthropicResp([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
  };
  try {
    for await (const _evt of streamAnthropic({ timeoutMs: 1000, ...args })) { /* drain */ }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'fetch was not called');
  return captured;
}

test('streamAnthropic sends thinking + reasoning_effort for glm-5.3 (anthropic-compatible endpoint)', async () => {
  const base = {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'k',
    model: 'glm-5.3',
    messages: [{ role: 'user', content: '分析一下这道数学题的解题思路' }],
    maxChars: 8192,
    enableReasoning: true,
  };
  // Default effort: max (recommended).
  const glm = await captureAnthropicBody({ ...base, modelType: 'glm-5.3', modelOptions: {} });
  assert.deepEqual(glm.thinking, { type: 'enabled', budget_tokens: glm.thinking.budget_tokens }, 'thinking block kept');
  assert.ok(typeof glm.thinking.budget_tokens === 'number' && glm.thinking.budget_tokens > 0);
  assert.equal(glm.reasoning_effort, 'max', 'defaults to max');

  // Explicit effort level.
  const low = await captureAnthropicBody({ ...base, modelType: 'glm-5.3', modelOptions: { reasoning_effort: 'low' } });
  assert.equal(low.reasoning_effort, 'low');
  assert.ok(low.thinking, 'thinking stays on with an explicit effort');

  // Reasoning off → neither field.
  const off = await captureAnthropicBody({ ...base, modelType: 'glm-5.3', modelOptions: { reasoning_effort: 'low' }, enableReasoning: false });
  assert.equal('thinking' in off, false);
  assert.equal('reasoning_effort' in off, false);

  // glm-5.3-flash on the anthropic-compatible endpoint: same mapping.
  const flash = await captureAnthropicBody({ ...base, model: 'glm-5.3-flash', modelType: 'glm-5.3-flash', modelOptions: {} });
  assert.equal(flash.reasoning_effort, 'max', 'flash defaults to max');
  assert.ok(flash.thinking, 'flash keeps the thinking block');

  // Other model types: unchanged body (no effort field).
  const other = await captureAnthropicBody({ ...base, model: 'glm-5.2', modelType: 'glm-5.2', modelOptions: {} });
  assert.equal('reasoning_effort' in other, false, 'non-glm-5.3 types untouched');
  assert.ok(other.thinking, 'pre-existing thinking behavior for other types is intact');
});

test('LLMClient forwards modelType/modelOptions to the Anthropic adapter too', async () => {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return makeAnthropicResp([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
  };
  try {
    const client = new LLMClient({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
           apiKey: 'k',
      model: 'glm-5.3',
      style: 'anthropic',
      modelType: 'glm-5.3',
      modelOptions: { reasoning_effort: 'high' },
      enableReasoning: true,
    });
    for await (const _evt of client.stream([{ role: 'user', content: 'hi' }])) { /* drain */ }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'fetch was not called');
  assert.equal(captured.reasoning_effort, 'high');
  assert.ok(captured.thinking, 'thinking block still present');
});
