/*-------------------------------------------------------------------------
 * Regression tests for issues #5 and #6 (LLM config plumbing).
 *
 * #5 — /model maxTokens was write-only config: stored & displayed by
 *      /model list|show, but resolveModelRef never read it and the adapters
 *      always derived max_tokens from contextWindow/4. Fixed end-to-end:
 *      resolveModelRef passes maxTokens → LLMClient._buildArgs maps it to
 *      maxOutputTokens → openai adapters send it verbatim as max_tokens
 *      (stream + complete), the anthropic adapter scales its thinking/text
 *      budgets from it. Unset falls back to the old derivation (unchanged).
 *
 * #6 — LLMClient.complete() (openai branch) built its args by hand and
 *      dropped signal + config.headers, skipped the fail-fast config
 *      validation, and silently routed unknown styles to the openai path.
 *      completeOpenAI additionally had no signal parameter at all. Fixed:
 *      both methods share _buildArgs(); completeOpenAI bridges an external
 *      abort signal into the request.
 *
 * Run:  node --test test/llm_maxtokens_complete.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import { completeOpenAI } from '../lib/llm/openai_adapter.js';
import { LLMClient } from '../lib/llm/client.js';
import { resolveModelRef } from '../lib/config/home.js';
import fs from 'node:fs/promises';
import path from 'node:path';


// ---- fetch mocking -------------------------------------------------------

function installFetchMock(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

// ---- #5: maxTokens plumbing ----------------------------------------------

test('resolveModelRef passes maxTokens through to the client config', async () => {
  // _learn_setup.js already isolated HK2_HOME to a temp dir; MODELS_PATH is
  // resolved from it at module load, so writing here is already sandboxed.
  const { MODELS_PATH } = await import('../lib/config/home.js');
  await fs.writeFile(MODELS_PATH, JSON.stringify({
    providers: {
      openai: {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
        models: [
          { id: 'gpt-x', name: 'gpt-x', contextWindow: 128000, maxTokens: 1234 },
          { id: 'gpt-y', name: 'gpt-y', contextWindow: 128000 }, // no maxTokens
        ],
      },
    },
    default: null,
  }));
  const withExplicit = await resolveModelRef('openai/gpt-x');
  assert.equal(withExplicit.maxTokens, 1234);
  const without = await resolveModelRef('openai/gpt-y');
  assert.equal(without.maxTokens, undefined);
});

test('completeOpenAI sends explicit maxOutputTokens as max_tokens', async () => {
  const mock = installFetchMock(() => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
  try {
    await completeOpenAI({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hello' }],
      maxChars: 128000,
      maxOutputTokens: 1234,
      timeoutMs: 1000,
    });
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.max_tokens, 1234);
  } finally {
    mock.restore();
  }
});

test('completeOpenAI falls back to maxChars/4 derivation when maxOutputTokens unset', async () => {
  const mock = installFetchMock(() => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
  try {
    await completeOpenAI({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hello' }],
      maxChars: 128000,
      timeoutMs: 1000,
    });
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.max_tokens, 32000); // min(32768, 128000/4)
  } finally {
    mock.restore();
  }
});

test('LLMClient.complete() maps config.maxTokens → request max_tokens', async () => {
  const mock = installFetchMock(() => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
  try {
    const client = new LLMClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'gpt-x',
      maxChars: 128000,
      maxTokens: 1234,
      style: 'openai',
    });
    await client.complete([{ role: 'user', content: 'hello' }], { timeoutMs: 1000 });
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.max_tokens, 1234);
  } finally {
    mock.restore();
  }
});

// ---- #6: complete() signal / headers / validation ------------------------

test('LLMClient.complete() forwards config headers to the request', async () => {
  const mock = installFetchMock(() => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
  try {
    const client = new LLMClient({
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-test',
      model: 'gpt-x',
      headers: { 'X-Custom-Auth': 'secret-token', 'X-Trace-Id': 't-1' },
      style: 'openai',
    });
    await client.complete([{ role: 'user', content: 'hello' }], { timeoutMs: 1000 });
    const headers = mock.calls[0].init.headers;
    assert.equal(headers['X-Custom-Auth'], 'secret-token');
    assert.equal(headers['X-Trace-Id'], 't-1');
  } finally {
    mock.restore();
  }
});

test('LLMClient.complete() rejects immediately when the external signal aborts', async () => {
  // fetch that never settles on its own; only the abort signal cancels it.
  const mock = installFetchMock((_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(init.signal.reason ?? new Error('aborted')), { once: true });
  }));
  try {
    const client = new LLMClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'gpt-x',
      style: 'openai',
      timeout: 5000,
    });
    const ctrl = new AbortController();
    const p = client.complete([{ role: 'user', content: 'hello' }], { signal: ctrl.signal });
    // Give the request a tick to start, then abort.
    setTimeout(() => ctrl.abort(new Error('user cancelled')), 20);
    await assert.rejects(p, /user cancelled|aborted/);
  } finally {
    mock.restore();
  }
});

test('LLMClient.complete() fail-fast on missing baseUrl (no request sent)', async () => {
  const mock = installFetchMock(() => jsonResponse({}));
  try {
    const client = new LLMClient({ apiKey: 'sk-test', model: 'gpt-x', style: 'openai' });
    await assert.rejects(client.complete([{ role: 'user', content: 'x' }]), /baseUrl not configured/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('LLMClient.complete() throws on unknown style instead of routing to openai', async () => {
  const mock = installFetchMock(() => jsonResponse({}));
  try {
    const client = new LLMClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'm',
      style: 'bogus',
    });
    await assert.rejects(client.complete([{ role: 'user', content: 'x' }]), /Unknown LLM style: bogus/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});
