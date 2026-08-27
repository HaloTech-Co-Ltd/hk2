/*-------------------------------------------------------------------------
 *
 * Unit tests for the transient-error retry fetch (lib/llm/retry_fetch.js).
 *
 * Run:  node --test test/retry_fetch.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import { fetchWithRetry } from '../lib/llm/retry_fetch.js';

// Patch global fetch per test.
function withFetch(fn, impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

test('succeeds first try — no retry, single fetch call', async () => {
  let calls = 0;
  await withFetch(async () => {
    const r = await fetchWithRetry('http://x/', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(calls, 0 + 1);
  }, async () => { calls++; return new Response('ok', { status: 200 }); });
});

test('unknown-outcome throw (ECONNRESET) is NOT retried by default — duplicate POSTs are opt-in', async () => {
  let calls = 0;
  await withFetch(async () => {
    await assert.rejects(() => fetchWithRetry('http://x/', {}, { attempts: 3 }), /ECONNRESET/);
    assert.equal(calls, 1, 'no second POST unless HK2_LLM_RETRY_UNKNOWN_POST=1');
  }, async () => {
    calls++;
    throw new TypeError('fetch failed: read ECONNRESET');
  });
});

test('ECONNRESET retries (and succeeds) when HK2_LLM_RETRY_UNKNOWN_POST=1; onRetry reports the total', async () => {
  const prev = process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  let calls = 0;
  const retries = [];
  try {
    await withFetch(async () => {
      const r = await fetchWithRetry('http://x/', {}, { attempts: 3, onRetry: (i, d, e, total) => retries.push([i, d, total]) });
      assert.equal(r.status, 200);
      assert.equal(calls, 2);
      // 1st retry, jittered backoff in [base/2, base]; total reported so the
      // UI can say 'attempt 2/3'.
      assert.equal(retries.length, 1);
      assert.equal(retries[0][0], 1);
      assert.equal(retries[0][2], 3);
      assert.ok(retries[0][1] >= 250 && retries[0][1] <= 500, `delay ${retries[0][1]} in [250,500]`);
    }, async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed: read ECONNRESET');
      return new Response('ok', { status: 200 });
    });
  } finally {
    if (prev === undefined) delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
    else process.env.HK2_LLM_RETRY_UNKNOWN_POST = prev;
  }
});

test('establishment failure (ECONNREFUSED) is always safe to retry', async () => {
  let calls = 0;
  await withFetch(async () => {
    const r = await fetchWithRetry('http://x/', {}, { attempts: 3 });
    assert.equal(r.status, 200);
    assert.equal(calls, 2);
  }, async () => {
    calls++;
    if (calls === 1) {
      const e = new TypeError('fetch failed');
      e.cause = { code: 'ECONNREFUSED' };
      throw e;
    }
    return new Response('ok', { status: 200 });
  });
});

test('deterministic fetch errors (invalid URL) fail on attempt 1 — no retry penalty', async () => {
  let calls = 0;
  await withFetch(async () => {
    await assert.rejects(() => fetchWithRetry('http://x/', {}, { attempts: 3 }), /Failed to parse URL/);
    assert.equal(calls, 1, 'no retries for a deterministic error');
  }, async () => {
    calls++;
    throw new TypeError('Failed to parse URL from http://x/');
  });
});

test('429 Retry-After header overrides the backoff delay', async () => {
  const seen = [];
  let calls = 0;
  await withFetch(async () => {
    const r = await fetchWithRetry('http://x/', {}, { attempts: 3, onRetry: (i, d) => seen.push([i, d]) });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, [[1, 30]], 'Retry-After: 30ms used instead of ~500ms');
  }, async () => {
    calls++;
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.03' } });
    return new Response('ok', { status: 200 });
  });
});

test('abort during the backoff sleep rejects immediately (no further attempts)', async () => {
  let calls = 0;
  const ctrl = new AbortController();
  const prev = process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    await withFetch(async () => {
      const p = fetchWithRetry('http://x/', { signal: ctrl.signal }, { attempts: 3 });
      // abort while sleeping before attempt 2
      setTimeout(() => ctrl.abort(new Error('user interrupt')), 20);
      await assert.rejects(() => p, /user interrupt/);
      assert.equal(calls, 1, 'no second fetch after the abort');
    }, async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed: read ECONNRESET');
      return new Response('ok', { status: 200 });
    });
  } finally {
    if (prev === undefined) delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
    else process.env.HK2_LLM_RETRY_UNKNOWN_POST = prev;
  }
});

test('exhausts attempts → throws the last error', async () => {
  let calls = 0;
  await withFetch(async () => {
    await assert.rejects(() => fetchWithRetry('http://x/', {}, { attempts: 3 }), /fetch failed/);
    assert.equal(calls, 3);
  }, async () => {
    calls++;
    const e = new TypeError('fetch failed');
    e.cause = { code: 'ECONNREFUSED' }; // establishment failure: retried
    throw e;
  });
});

test('429 is outcome-safe and retries; 502/503/504 are unknown-outcome (opt-in); 400 never retries', async () => {
  // 429 → refused before execution → retried to success by default.
  let i = 0;
  const seq429 = [429, 200];
  await withFetch(async () => {
    const r = await fetchWithRetry('http://x/', {}, { attempts: 5 });
    assert.equal(r.status, 200);
    assert.equal(i, 2);
  }, async () => new Response('', { status: seq429[i++] }));

  // 503 → the gateway may speak for an upstream that already RAN the POST:
  // returned as-is by default (no duplicate request), retried when opted in.
  let j = 0;
  await withFetch(async () => {
    const r = await fetchWithRetry('http://x/', {}, { attempts: 5 });
    assert.equal(r.status, 503, 'unknown-outcome 5xx is NOT retried by default');
  }, async () => { j++; return new Response('upstream died late', { status: 503 }); });
  assert.equal(j, 1);

  const prev = process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    let k = 0;
    const seq = [503, 504, 200];
    await withFetch(async () => {
      const r = await fetchWithRetry('http://x/', {}, { attempts: 5 });
      assert.equal(r.status, 200);
      assert.equal(k, 3);
    }, async () => new Response('', { status: seq[k++] }));
  } finally {
    if (prev === undefined) delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
    else process.env.HK2_LLM_RETRY_UNKNOWN_POST = prev;
  }

  // 400: deterministic client error — never retried.
  let m = 0;
  await withFetch(async () => {
    const r = await fetchWithRetry('http://x/', {}, { attempts: 5 });
    assert.equal(r.status, 400);
  }, async () => { m++; return new Response('bad', { status: 400 }); });
  assert.equal(m, 1);
});

test('aborted signal is never retried (user interrupt)', async () => {
  let calls = 0;
  const ctrl = new AbortController();
  ctrl.abort(new Error('user'));
  await withFetch(async () => {
    await assert.rejects(() => fetchWithRetry('http://x/', { signal: ctrl.signal }, { attempts: 3 }));
    assert.equal(calls, 1);
  }, async () => { calls++; throw new TypeError('fetch failed'); });
});


/* ----- end-to-end: the attempt TOTAL survives adapter → client ---------- */

test('e2e: LLMClient.stream onRetry receives (attempt, delay, err, attempts)', async () => {
  const { LLMClient } = await import('../lib/llm/client.js');
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
    // Minimal SSE the OpenAI adapter can consume to a clean finish.
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const client = new LLMClient({
      style: 'openai', baseUrl: 'http://e2e.example', apiKey: 'sk', model: 'm',
      maxChars: 4096, temperature: 0.2, enableReasoning: false,
    });
    const seen = [];
    for await (const _evt of client.stream([{ role: 'user', content: 'hi' }], {
      onRetry: (attempt, delayMs, err, attempts) => seen.push([attempt, delayMs, err?.message, attempts]),
    })) { void _evt; }
    assert.equal(calls, 2, 'one 429 retry');
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 1, 'retry index');
    assert.equal(seen[0][2], 'HTTP 429', 'cause surfaced');
    assert.equal(seen[0][3], 3, 'TOTAL attempts forwarded end-to-end (UI shows 2/3)');
  } finally {
    globalThis.fetch = orig;
  }
});

test('e2e: runLoop forwards the full onRetry argument list to callbacks', async () => {
  const { runLoop } = await import('../lib/agent/loop.js');
  const captured = [];
  const llm = {
    async *stream(_messages, opts = {}) {
      // Simulate fetchWithRetry's callback contract.
      opts.onRetry?.(1, 10, new Error('HTTP 429'), 3);
      yield { type: 'finish', reason: 'stop' };
      yield { type: 'done' };
    },
  };
  await runLoop({
    llm,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    callbacks: {
      onRetry: (attempt, delayMs, err, attempts) => captured.push([attempt, delayMs, err?.message, attempts]),
    },
  });
  assert.deepEqual(captured, [[1, 10, 'HTTP 429', 3]],
    'the loop forwards ALL FOUR arguments — losing the total rendered attempt 2/undefined');
});
