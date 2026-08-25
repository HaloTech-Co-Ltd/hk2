/*-------------------------------------------------------------------------
 *
 * HK2_LLMAPI_TIMEOUT_MS env-var verification.
 *
 * The LLM request timeout default (3600000ms) is resolved through the
 * shared helper lib/llm/timeout.js (llmApiTimeoutMs). These tests pin:
 *
 *   1. pure resolution: unset/garbage -> 3600000, explicit 0 -> 0
 *      (no-timeout), positive int -> passthrough, re-read every call.
 *   2. end-to-end: a client with NO config.timeout and NO opts.timeoutMs
 *      arms the ENV value's abort timer through streamOpenAI.
 *   3. precedence intact: opts.timeoutMs and config.timeout still beat
 *      the env default (the ?? chain must not be weakened).
 *   4. resolveModelRef stamps config.timeout from the env value so the
 *      interactive path (LLMClient built from a resolved model) honors it.
 *
 * Run:  node --test test/llm_timeout_env.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import { llmApiTimeoutMs, DEFAULT_LLM_TIMEOUT_MS } from '../lib/llm/timeout.js';
import { LLMClient } from '../lib/llm/client.js';
import { streamOpenAI } from '../lib/llm/openai_adapter.js';

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

function makeHangingFetchResponse(signal) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: () => new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error('aborted'));
          if (signal.aborted) return abort();
          signal.addEventListener('abort', abort, { once: true });
        }),
      }),
    },
  };
}

/** Spy setTimeout; hanging fetch mock. `started` resolves with the abort signal. */
function instrumentStreamingFetch() {
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  let startedResolve;
  const started = new Promise((r) => { startedResolve = r; });
  globalThis.setTimeout = (fn, delay, ...rest) => {
    timers.push(delay);
    return originalSetTimeout(fn, delay, ...rest);
  };
  globalThis.fetch = async (_url, init) => {
    startedResolve(init.signal);
    return makeHangingFetchResponse(init.signal);
  };
  const restore = () => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  };
  return { timers, started, restore };
}

const MSGS = [{ role: 'user', content: 'hi' }];

/* ------------------------- 1. pure resolution ------------------------- */

test('llmApiTimeoutMs: unset / empty / garbage -> default 3600000', () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS;
  try {
    for (const v of [undefined, '', '   ', 'abc', '-5']) {
      if (v === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
      else process.env.HK2_LLMAPI_TIMEOUT_MS = v;
      assert.equal(llmApiTimeoutMs(), DEFAULT_LLM_TIMEOUT_MS, `value ${JSON.stringify(v)} must fall back to the default`);
    }
    assert.equal(DEFAULT_LLM_TIMEOUT_MS, 3600000, 'default constant is 3600000ms');
    // Lenient leading-digit parse — same parseInt semantics as the existing
    // HK2_PLAN_TIMEOUT_MS handling in src/slash/kb.js.
    process.env.HK2_LLMAPI_TIMEOUT_MS = '12abc';
    assert.equal(llmApiTimeoutMs(), 12, 'parseInt-style lenient parse (project convention)');
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    else process.env.HK2_LLMAPI_TIMEOUT_MS = saved;
  }
});

test('llmApiTimeoutMs: explicit 0 -> 0 (no timeout); positive int passthrough', () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS;
  try {
    process.env.HK2_LLMAPI_TIMEOUT_MS = '0';
    assert.equal(llmApiTimeoutMs(), 0, 'explicit 0 means no timeout');
    process.env.HK2_LLMAPI_TIMEOUT_MS = '45000';
    assert.equal(llmApiTimeoutMs(), 45000, 'positive integer passes through');
    // numeric-string trimming
    process.env.HK2_LLMAPI_TIMEOUT_MS = '  7200000  ';
    assert.equal(llmApiTimeoutMs(), 7200000, 'surrounding whitespace is trimmed');
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    else process.env.HK2_LLMAPI_TIMEOUT_MS = saved;
  }
});

/* ------------------------- 2. end-to-end wiring ------------------------ */

test('adapter fallback: no timeoutMs -> env default arms the abort timer', async () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS;
  process.env.HK2_LLMAPI_TIMEOUT_MS = '4321';
  const user = new AbortController();
  const { timers, started, restore } = instrumentStreamingFetch();
  const pump = (async () => {
    for await (const _evt of streamOpenAI({
      baseUrl: 'https://x.example', apiKey: 'k', model: 'm', messages: MSGS,
      signal: user.signal,
    })) { /* drain */ }
  })();
  try {
    await started;
    await sleep(50);
    assert.ok(timers.includes(4321), `adapter must fall back to the env default 4321 (saw: ${JSON.stringify(timers)})`);
    user.abort(new Error('done'));
    await pump.catch(() => {});
  } finally {
    restore();
    user.abort();
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    else process.env.HK2_LLMAPI_TIMEOUT_MS = saved;
  }
});

test('LLMClient default chain: env value flows through ?? to the adapter', async () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS;
  process.env.HK2_LLMAPI_TIMEOUT_MS = '7777';
  // NO config.timeout, NO opts.timeoutMs -> env default must win.
  const client = new LLMClient({
    style: 'openai', baseUrl: 'https://x.example', apiKey: 'k', model: 'm',
  });
  const user = new AbortController();
  const { timers, started, restore } = instrumentStreamingFetch();
  const pump = (async () => {
    for await (const _evt of client.stream(MSGS, { signal: user.signal })) { /* drain */ }
  })();
  try {
    await started;
    await sleep(50);
    assert.ok(timers.includes(7777), `client ?? chain must resolve to the env default 7777 (saw: ${JSON.stringify(timers)})`);
    user.abort(new Error('done'));
    await pump.catch(() => {});
  } finally {
    restore();
    user.abort();
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    else process.env.HK2_LLMAPI_TIMEOUT_MS = saved;
  }
});

/* --------------------------- 3. precedence ----------------------------- */

test('precedence intact: config.timeout beats the env default', async () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS;
  process.env.HK2_LLMAPI_TIMEOUT_MS = '999999';
  const client = new LLMClient({
    style: 'openai', baseUrl: 'https://x.example', apiKey: 'k', model: 'm',
    timeout: 1234,
  });
  const user = new AbortController();
  const { timers, started, restore } = instrumentStreamingFetch();
  const pump = (async () => {
    for await (const _evt of client.stream(MSGS, { signal: user.signal })) { /* drain */ }
  })();
  try {
    await started;
    await sleep(50);
    assert.ok(timers.includes(1234) && !timers.includes(999999),
      `config.timeout=1234 must beat env 999999 (saw: ${JSON.stringify(timers)})`);
    user.abort(new Error('done'));
    await pump.catch(() => {});
  } finally {
    restore();
    user.abort();
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    else process.env.HK2_LLMAPI_TIMEOUT_MS = saved;
  }
});

test('precedence intact: explicit opts.timeoutMs: 0 still means NO timeout even with env set', async () => {
  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS;
  process.env.HK2_LLMAPI_TIMEOUT_MS = '654321';
  const client = new LLMClient({
    style: 'openai', baseUrl: 'https://x.example', apiKey: 'k', model: 'm',
  });
  const user = new AbortController();
  const { timers, started, restore } = instrumentStreamingFetch();
  const pump = (async () => {
    for await (const _evt of client.stream(MSGS, { timeoutMs: 0, signal: user.signal })) { /* drain */ }
  })();
  try {
    await started;
    await sleep(50);
    assert.equal(timers.length, 0, `timeoutMs:0 must arm nothing despite env (saw: ${JSON.stringify(timers)})`);
    user.abort(new Error('done'));
    await pump.catch(() => {});
  } finally {
    restore();
    user.abort();
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    else process.env.HK2_LLMAPI_TIMEOUT_MS = saved;
  }
});

/* --------------------- 4. resolveModelRef stamp ------------------------ */

test('resolveModelRef stamps config.timeout from the env value', async () => {
  const { resolveModelRef } = await import('../lib/config/home.js');
  // Build a minimal model registry in the isolated HK2_HOME.
  const { loadModels, saveModels } = await import('../lib/config/home.js');
  const { providers, default: _d } = await loadModels();
  providers['prov-x'] = {
    api: 'openai', baseUrl: 'https://x.example', apiKey: 'k',
    models: [{ id: 'model-x' }],
  };
  await saveModels({ providers, default: 'prov-x/model-x' });

  const saved = process.env.HK2_LLMAPI_TIMEOUT_MS;
  try {
    process.env.HK2_LLMAPI_TIMEOUT_MS = '24680';
    const cfg = await resolveModelRef('prov-x/model-x');
    assert.ok(cfg, 'model ref must resolve');
    assert.equal(cfg.timeout, 24680, 'resolveModelRef must stamp the env-resolved timeout');

    delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    const cfg2 = await resolveModelRef('prov-x/model-x');
    assert.equal(cfg2.timeout, 3600000, 'without env the stamp falls back to 3600000');
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_TIMEOUT_MS;
    else process.env.HK2_LLMAPI_TIMEOUT_MS = saved;
  }
});
