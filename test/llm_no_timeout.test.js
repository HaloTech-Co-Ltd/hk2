/*-------------------------------------------------------------------------
 *
 * No-timeout (timeoutMs === 0) end-to-end verification.
 *
 * plan-review / code-review hardcode timeoutMs: 0 — the review MUST wait
 * for the LLM to finish naturally (a mid-reply abort loses the verdict
 * JSON; see lib/agent/plan_review.js / lib/agent/code_review.js). That
 * contract spans three layers, each previously untested at this level:
 *
 *   1. adapters: streamOpenAI / streamAnthropic / completeOpenAI must arm
 *      NO abort timer when timeoutMs === 0 (the pre-fix `timeoutMs || 600000`
 *      coerced 0 into a 600s cap), and a user abort signal must still
 *      cancel the in-flight request.
 *   2. client: LLMClient.stream must forward an explicit 0 via ?? (not ||)
 *      so this.config.timeout cannot silently re-cap it at the default.
 *   3. default path unchanged: without opts.timeoutMs the configured
 *      timeout is still armed and still fires (regression guard for the
 *      ?? semantics).
 *
 * "No timer armed" is observed by spying on globalThis.setTimeout while the
 * mocked fetch's body reader hangs forever. A wrongly-armed timer is caught
 * at CALL time (a 600000ms regression timer is recorded even though it
 * never fires during the test), and the hanging stream surviving the
 * observation window proves nothing cut it short.
 *
 * Run:  node --test test/llm_no_timeout.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import { streamOpenAI, completeOpenAI } from '../lib/llm/openai_adapter.js';
import { streamAnthropic } from '../lib/llm/anthropic_adapter.js';
import { LLMClient } from '../lib/llm/client.js';

// The REAL timers, captured before any test spies on globalThis.setTimeout.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

async function withTimeout(promise, ms, msg) {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_r, rej) => { t = realSetTimeout(() => rej(new Error(`timeout: ${msg}`)), ms); }),
    ]);
  } finally {
    if (t) realClearTimeout(t);
  }
}

/**
 * A fetch Response whose body reader NEVER resolves on its own — it only
 * rejects when the request's abort signal fires, mirroring real fetch
 * semantics where an aborted request's stream rejects.
 */
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

/**
 * Install a setTimeout spy + a hanging-fetch mock (never-ending SSE body).
 * `started` resolves with the request's abort signal once fetch fires.
 */
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

test('streamOpenAI: timeoutMs === 0 arms NO abort timer; user abort still cancels', async () => {
  const { timers, started, restore } = instrumentStreamingFetch();
  const user = new AbortController();
  let drained = false;
  const pump = (async () => {
    for await (const _evt of streamOpenAI({
      baseUrl: 'https://x.example', apiKey: 'k', model: 'm', messages: MSGS,
      timeoutMs: 0, signal: user.signal,
    })) { /* drain */ }
    drained = true;
  })();
  try {
    await withTimeout(started, 2000, 'fetch never fired');
    // Observation window: a wrongly-armed timer (any duration, including a
    // 600000ms `|| 600000` regression) is recorded at call time; nothing
    // may fire during the window either.
    await sleep(80);
    assert.equal(timers.length, 0, `no abort timer may be armed when timeoutMs === 0 (saw: ${JSON.stringify(timers)})`);
    assert.equal(drained, false, 'the stream must still be waiting for the LLM (nothing cut it short)');
    // The user abort must still cancel the in-flight request.
    user.abort(new Error('user cancelled'));
    await withTimeout(pump, 2000, 'user abort did not cancel the stream');
    assert.equal(drained, true, 'stream ended after the user abort propagated');
  } finally {
    restore();
    user.abort(); // cleanup on failure paths too
  }
});

test('streamAnthropic: timeoutMs === 0 arms NO abort timer; user abort still cancels', async () => {
  const { timers, started, restore } = instrumentStreamingFetch();
  const user = new AbortController();
  let drained = false;
  const pump = (async () => {
    for await (const _evt of streamAnthropic({
      baseUrl: 'https://x.example', apiKey: 'k', model: 'm', messages: MSGS,
      timeoutMs: 0, signal: user.signal,
    })) { /* drain */ }
    drained = true;
  })();
  try {
    await withTimeout(started, 2000, 'fetch never fired');
    await sleep(80);
    assert.equal(timers.length, 0, `no abort timer may be armed when timeoutMs === 0 (saw: ${JSON.stringify(timers)})`);
    assert.equal(drained, false, 'the stream must still be waiting for the LLM (nothing cut it short)');
    user.abort(new Error('user cancelled'));
    await withTimeout(pump, 2000, 'user abort did not cancel the stream');
    assert.equal(drained, true, 'stream ended after the user abort propagated');
  } finally {
    restore();
    user.abort();
  }
});

test('completeOpenAI: timeoutMs === 0 arms NO abort timer (waits indefinitely)', async () => {
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  globalThis.setTimeout = (fn, delay, ...rest) => {
    timers.push(delay);
    return originalSetTimeout(fn, delay, ...rest);
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: () => new Promise(() => {}), // never resolves
  });
  try {
    const pending = completeOpenAI({
      baseUrl: 'https://x.example', apiKey: 'k', model: 'm',
      messages: MSGS, timeoutMs: 0,
    });
    const outcome = await Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      sleep(80).then(() => 'pending'),
    ]);
    assert.equal(outcome, 'pending', 'completeOpenAI must keep waiting when timeoutMs === 0');
    assert.equal(timers.length, 0, `no abort timer may be armed when timeoutMs === 0 (saw: ${JSON.stringify(timers)})`);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  }
});

test('LLMClient.stream forwards an explicit timeoutMs: 0 via ?? — config.timeout must NOT re-cap it', async () => {
  const client = new LLMClient({
    style: 'openai', baseUrl: 'https://x.example', apiKey: 'k', model: 'm',
    timeout: 12345,
  });
  const { timers, started, restore } = instrumentStreamingFetch();
  const user = new AbortController();
  const pump = (async () => {
    for await (const _evt of client.stream(MSGS, { timeoutMs: 0, signal: user.signal })) { /* drain */ }
  })();
  try {
    await withTimeout(started, 2000, 'fetch never fired');
    await sleep(60);
    // If client.js used || instead of ??, opts.timeoutMs = 0 would fall
    // through to config.timeout = 12345 and the adapter would arm a 12345ms
    // timer right here — silently reintroducing a cap the review phases
    // explicitly opted out of.
    assert.equal(timers.length, 0, `LLMClient must pass timeoutMs:0 through ?? (a || would arm config.timeout: ${JSON.stringify(timers)})`);
    user.abort(new Error('user cancelled'));
    await withTimeout(pump, 2000, 'user abort did not cancel the stream');
  } finally {
    restore();
    user.abort();
  }
});

test('LLMClient.stream default path unchanged: config.timeout still arms the abort timer', async () => {
  const client = new LLMClient({
    style: 'openai', baseUrl: 'https://x.example', apiKey: 'k', model: 'm',
    timeout: 50,
  });
  const { timers, started, restore } = instrumentStreamingFetch();
  const pump = (async () => {
    for await (const _evt of client.stream(MSGS)) { /* drain */ }
  })();
  try {
    await withTimeout(started, 2000, 'fetch never fired');
    // No user abort here: the armed 50ms timeout timer must fire BY ITSELF,
    // abort the hanging request, and end the stream — proving the default
    // timeout path is still live (?? only forwards EXPLICIT values).
    await withTimeout(pump, 2000, 'the config.timeout timer did not abort the stream');
    assert.ok(timers.includes(50), `expected the adapter to arm config.timeout=50 (saw: ${JSON.stringify(timers)})`);
  } finally {
    restore();
  }
});
