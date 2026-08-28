/*-------------------------------------------------------------------------
 *
 * HK2_LLMAPI_TIMEOUT_MS_SIMPLE — timeout resolution for the lightweight
 * single-shot LLM phases (query rewrite / request clarity assessment).
 *
 * Before this variable existed both rewriteQuery and assessRequest
 * hardcoded a 15000ms (15s) cap at every call site, which was far too
 * tight for slow providers (reasoning models). The resolution now lives
 * in a single shared helper (llmApiTimeoutMsSimple in lib/llm/timeout.js)
 * consumed INSIDE rewrite_query.js — call sites no longer pass a
 * hardcoded timeoutMs.
 *
 * These tests pin:
 *
 *   1. pure resolution: unset/garbage -> 300000, explicit 0 -> 0
 *      (no-timeout), positive int -> passthrough, re-read every call.
 *   2. wiring: rewriteQuery / assessRequest forward the resolved default
 *      to llm.stream as opts.timeoutMs when the caller passes none.
 *   3. precedence: an explicit opts.timeoutMs still beats the env default.
 *
 * Run:  node --test test/llm_timeout_simple_env.test.js
 *-----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import {
  llmApiTimeoutMsSimple,
  DEFAULT_LLM_TIMEOUT_MS_SIMPLE,
} from '../lib/llm/timeout.js';
import { rewriteQuery, assessRequest } from '../lib/retrieval/rewrite_query.js';

/* ------------------------- 1. pure resolution ------------------------- */

test('llmApiTimeoutMsSimple: unset / empty / garbage -> default 300000', () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
  try {
    for (const v of [undefined, '', '   ', 'abc', '-5', '-1']) {
      if (v === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
      else process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = v;
      assert.equal(
        llmApiTimeoutMsSimple(),
        DEFAULT_LLM_TIMEOUT_MS_SIMPLE,
        `value ${JSON.stringify(v)} must fall back to the default`
      );
    }
    assert.equal(DEFAULT_LLM_TIMEOUT_MS_SIMPLE, 300000, 'default constant is 300000ms (300s)');
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
    else process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = saved;
  }
});

test('llmApiTimeoutMsSimple: explicit 0 -> 0 (no timeout); positive int passthrough', () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
  try {
    process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = '0';
    assert.equal(llmApiTimeoutMsSimple(), 0, 'explicit 0 means no timeout');
    process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = '45000';
    assert.equal(llmApiTimeoutMsSimple(), 45000, 'positive integer passes through');
    process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = '  90000  ';
    assert.equal(llmApiTimeoutMsSimple(), 90000, 'surrounding whitespace is trimmed');
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
    else process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = saved;
  }
});

test('llmApiTimeoutMsSimple: independent from HK2_LLMAPI_TIMEOUT_MS', () => {
  const savedSimple = process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
  const savedMain = process.env.HK2_LLMAPI_TIMEOUT_MS;
  try {
    process.env.HK2_LLMAPI_TIMEOUT_MS = '123456';
    delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
    assert.equal(
      llmApiTimeoutMsSimple(),
      300000,
      'the main timeout var must NOT feed the simple-phase default'
    );
  } finally {
    if (savedSimple === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
    else process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = savedSimple;
    if (savedMain === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    else process.env.HK2_LLMAPI_TIMEOUT_MS = savedMain;
  }
});

/* --------------------- 2/3. wiring through rewrite_query --------------- */

// Fake LLM that records the opts it was called with, then yields a canned
// well-formed response so rewriteQuery / assessRequest complete normally.
function spyLlm(raw, bucket) {
  return {
    stream: async function* (_messages, opts) {
      bucket.push(opts);
      yield { type: 'delta', text: raw };
    },
  };
}

test('rewriteQuery / assessRequest forward the env default as opts.timeoutMs', async () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
  process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = '4321';
  try {
    const rewriteOpts = [];
    const r = await rewriteQuery(
      spyLlm(JSON.stringify({ intent: 'x', functionNames: ['foo'], keywords: ['bar'] }), rewriteOpts),
      'foo the bar'
    );
    assert.equal(r.fallback, false);
    assert.equal(rewriteOpts[0].timeoutMs, 4321, 'rewriteQuery must stamp the env value');

    const assessOpts = [];
    const a = await assessRequest(spyLlm(JSON.stringify({ clear: true }), assessOpts), 'do a thing');
    assert.equal(a.clear, true);
    assert.equal(assessOpts[0].timeoutMs, 4321, 'assessRequest must stamp the env value');
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
    else process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = saved;
  }
});

test('rewriteQuery / assessRequest default to 300000 when the env var is unset', async () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
  delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
  try {
    const rewriteOpts = [];
    await rewriteQuery(
      spyLlm(JSON.stringify({ intent: 'x', functionNames: [], keywords: [] }), rewriteOpts),
      'some query'
    );
    assert.equal(rewriteOpts[0].timeoutMs, 300000, 'default must be 300000ms, not the old 15000');

    const assessOpts = [];
    await assessRequest(spyLlm(JSON.stringify({ clear: true }), assessOpts), 'some query');
    assert.equal(assessOpts[0].timeoutMs, 300000, 'default must be 300000ms, not the old 15000');
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
    else process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = saved;
  }
});

test('explicit opts.timeoutMs still beats the env default (precedence intact)', async () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
  process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = '4321';
  try {
    const rewriteOpts = [];
    await rewriteQuery(
      spyLlm(JSON.stringify({ intent: 'x', functionNames: [], keywords: [] }), rewriteOpts),
      'some query',
      { timeoutMs: 777 }
    );
    assert.equal(rewriteOpts[0].timeoutMs, 777, 'opts.timeoutMs must win');

    const assessOpts = [];
    await assessRequest(spyLlm(JSON.stringify({ clear: true }), assessOpts), 'some query', {
      timeoutMs: 888,
    });
    assert.equal(assessOpts[0].timeoutMs, 888, 'opts.timeoutMs must win');
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
    else process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE = saved;
  }
});
