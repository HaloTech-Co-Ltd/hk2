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

test('retries HTTP 429/503, returns on 200, does NOT retry 400', async () => {
  let seq = [429, 503, 200];
  let i = 0;
  await withFetch(async () => {
    const r = await fetchWithRetry('http://x/', {}, { attempts: 5 });
    assert.equal(r.status, 200);
    assert.equal(i, 3);
  }, async () => new Response('', { status: seq[i++] }));

  let j = 0;
  await withFetch(async () => {
    const r = await fetchWithRetry('http://x/', {}, { attempts: 5 });
    assert.equal(r.status, 400); // deterministic client error: no retry
  }, async () => { j++; return new Response('bad', { status: 400 }); });
  assert.equal(j, 1);
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
