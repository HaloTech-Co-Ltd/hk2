/*-------------------------------------------------------------------------
 *
 * LLM call-retry mechanism tests (env: HK2_LLMAPI_NUMOFRETRIES).
 *
 * The retry loop lives in lib/llm/client.js (LLMClient.stream / .complete);
 * policy pieces live in lib/llm/retries.js (llmApiNumOfRetries /
 * isRetryableLlmError / retryBackoffMs / abortableSleep).
 *
 * Covered behaviors:
 *   - env parsing: unset / invalid → 10, explicit 0 → 0, N → N
 *   - a transient failure (fetch-level "request failed") is retried and the
 *     second attempt's stream flows through normally, with a
 *     {type:'retry'} event emitted in between
 *   - exhausting the retry budget throws "LLM request failed after N
 *     attempts" (N = retries + 1 total attempts)
 *   - deterministic client errors (HTTP 400/401/404) fail FAST: exactly one
 *     fetch, no retry event
 *   - HTTP 429 / 5xx ARE retryable
 *   - partial output from a failed attempt is void: deltas yielded before
 *     the failure do not appear in the successful attempt's output
 *   - user abort during the backoff sleep is honored immediately (the
 *     abortable sleep wakes early and the stream throws 'aborted')
 *   - complete() (openai non-streaming path) retries too
 *   - error classification unit checks
 *
 * Backoff is neutralized by replacing globalThis.setTimeout with an
 * immediately-firing version while a retry sleep is pending, so tests stay
 * fast regardless of the exponential schedule.
 *
 * Run:  node --test test/llm_retry.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test, mock } from 'node:test';
import assert from 'node:assert';
import { LLMClient } from '../lib/llm/client.js';
import {
  llmApiNumOfRetries,
  isRetryableLlmError,
  retryBackoffMs,
  DEFAULT_LLM_NUM_OF_RETRIES,
} from '../lib/llm/retries.js';

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

/** Make all backoff sleeps fire ~immediately (keeps tests fast). */
function fastTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...rest) => originalSetTimeout(fn, 0, ...rest);
  return () => { globalThis.setTimeout = originalSetTimeout; };
}

/** Build a minimal streaming Response for one OpenAI SSE text chunk. */
function openAiStreamResponse(text) {
  const chunk = `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, index: 0, finish_reason: null }],
  })}\n\ndata: ${JSON.stringify({
    choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  })}\n\ndata: [DONE]\n\n`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, text: async () => '', body };
}

/** HTTP error Response. */
function httpErrorResponse(status) {
  return { ok: false, status, text: async () => `{"error":"${status}"}` };
}

/**
 * Install a scripted fetch: each call consumes the next script entry
 * ('fail' → rejected fetch; number → HTTP error; string → success stream).
 * Returns the restore function and a call counter.
 */
function scriptedFetch(script) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    const step = script[Math.min(calls, script.length - 1)];
    calls++;
    if (step === 'fail') throw new TypeError('fetch failed');
    if (typeof step === 'number') return httpErrorResponse(step);
    return openAiStreamResponse(step);
  };
  return {
    restore: () => { globalThis.fetch = original; },
    calls: () => calls,
  };
}

const MSGS = [{ role: 'user', content: 'hi' }];

function makeClient() {
  return new LLMClient({ style: 'openai', baseUrl: 'https://x.example', apiKey: 'k', model: 'm' });
}

async function collect(gen) {
  const out = [];
  for await (const evt of gen) out.push(evt);
  return out;
}

const text = (evts) => evts.filter(e => e.type === 'delta').map(e => e.text).join('');

// ---------- env parsing ----------

test('llmApiNumOfRetries: default 10, explicit 0, positive N, invalid → default', () => {
  const saved = process.env.HK2_LLMAPI_NUMOFRETRIES;
  try {
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
    assert.equal(llmApiNumOfRetries(), DEFAULT_LLM_NUM_OF_RETRIES);
    assert.equal(DEFAULT_LLM_NUM_OF_RETRIES, 10);
    process.env.HK2_LLMAPI_NUMOFRETRIES = '0';
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
    assert.equal(llmApiNumOfRetries(), 0);
    process.env.HK2_LLMAPI_NUMOFRETRIES = '3';
  // These loop-mechanics tests drive unknown-outcome failures; the opt-in
  // makes the retry loop reachable for them (the default-off policy itself
  // is pinned in the classification test above).
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
    assert.equal(llmApiNumOfRetries(), 3);
    process.env.HK2_LLMAPI_NUMOFRETRIES = '-2';
    assert.equal(llmApiNumOfRetries(), DEFAULT_LLM_NUM_OF_RETRIES);
    process.env.HK2_LLMAPI_NUMOFRETRIES = 'abc';
    assert.equal(llmApiNumOfRetries(), DEFAULT_LLM_NUM_OF_RETRIES);
    process.env.HK2_LLMAPI_NUMOFRETRIES = '';
    assert.equal(llmApiNumOfRetries(), DEFAULT_LLM_NUM_OF_RETRIES);
  } finally {
    if (saved === undefined) delete process.env.HK2_LLMAPI_NUMOFRETRIES;
    else process.env.HK2_LLMAPI_NUMOFRETRIES = saved;
  }
});

// ---------- error classification ----------

test('isRetryableLlmError: outcome-safe always; unknown-outcome opt-in; client errors never', () => {
  // Outcome-safe: the request never left, or was refused before execution.
  assert.equal(isRetryableLlmError(new Error('Anthropic request failed: fetch failed (ECONNREFUSED)')), true);
  assert.equal(isRetryableLlmError(new Error('OpenAI request failed: getaddrinfo ENOTFOUND (ENOTFOUND)')), true);
  // Connect-phase failures: the TCP handshake never completed, so the
  // request never left the client — outcome-safe even with the unknown-post
  // opt-in off (OS-level connect timeout / host-unreachable).
  assert.equal(isRetryableLlmError(new Error('Anthropic request failed: fetch failed (ETIMEDOUT/connect)')), true);
  assert.equal(isRetryableLlmError(new Error('OpenAI request failed: fetch failed (EHOSTUNREACH/connect)')), true);
  assert.equal(isRetryableLlmError(new Error('OpenAI 429: rate limited')), true);
  assert.equal(isRetryableLlmError(new Error('OpenAI 408: request timeout')), true);
  // Unknown outcome: mid-flight transport failures and 5xx (the gateway may
  // speak for an upstream that already RAN the request). NOT retried by
  // default — duplicate requests / duplicate billing are worse than a
  // failed turn (merged semantics from the TUI branch review rounds).
  const prev = process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  try {
    assert.equal(isRetryableLlmError(new Error('Anthropic request failed: fetch failed')), false, 'bare fetch failed = unknown');
    assert.equal(isRetryableLlmError(new Error('Anthropic request failed: fetch failed (ETIMEDOUT)')), false, 'legacy bare ETIMEDOUT (no syscall) = unknown');
    assert.equal(isRetryableLlmError(new Error('OpenAI request failed: fetch failed (ETIMEDOUT/read)')), false, 'read-phase ETIMEDOUT = unknown');
    assert.equal(isRetryableLlmError(new Error('OpenAI request failed: read ECONNRESET (ECONNRESET)')), false, 'mid-flight reset = unknown');
    assert.equal(isRetryableLlmError(new Error('Anthropic request failed: timeout')), false, 'timeout after send = unknown');
    assert.equal(isRetryableLlmError(new Error('Anthropic 503: overloaded')), false, '5xx = unknown');
    assert.equal(isRetryableLlmError(new Error('OpenAI 502: bad gateway')), false, '5xx = unknown');
    assert.equal(isRetryableLlmError(new Error('OpenAI 500: internal')), false, '5xx = unknown');
  } finally {
    if (prev !== undefined) process.env.HK2_LLM_RETRY_UNKNOWN_POST = prev;
  }
  // ...and opted in explicitly.
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    assert.equal(isRetryableLlmError(new Error('Anthropic request failed: fetch failed')), true);
    assert.equal(isRetryableLlmError(new Error('Anthropic 503: overloaded')), true);
  } finally {
    if (prev === undefined) delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
    else process.env.HK2_LLM_RETRY_UNKNOWN_POST = prev;
  }
  // deterministic client errors: retrying cannot help
  assert.equal(isRetryableLlmError(new Error('Anthropic 400: tool_use ids...')), false);
  assert.equal(isRetryableLlmError(new Error('OpenAI 401: invalid key')), false);
  assert.equal(isRetryableLlmError(new Error('OpenAI 404: unknown model')), false);
  assert.equal(isRetryableLlmError(new Error('LLM baseUrl not configured')), false);
  assert.equal(isRetryableLlmError(null), false);
});

test('retryBackoffMs: exponential 1s→30s cap', () => {
  assert.equal(retryBackoffMs(1), 1000);
  assert.equal(retryBackoffMs(2), 2000);
  assert.equal(retryBackoffMs(3), 4000);
  assert.equal(retryBackoffMs(5), 16000);
  assert.equal(retryBackoffMs(6), 30000);
  assert.equal(retryBackoffMs(20), 30000);
});

// ---------- stream retry loop ----------

test('stream: transient fetch failure is retried; retry event emitted; attempt-2 output is the answer', async () => {
  const restoreT = fastTimers();
  const sf = scriptedFetch(['fail', 'attempt-two']);
  process.env.HK2_LLMAPI_NUMOFRETRIES = '3';
  // These loop-mechanics tests drive unknown-outcome failures; the opt-in
  // makes the retry loop reachable for them (the default-off policy itself
  // is pinned in the classification test above).
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    const evts = await collect(makeClient().stream(MSGS, { timeoutMs: 0 }));
    const retries = evts.filter(e => e.type === 'retry');
    assert.equal(retries.length, 1, 'exactly one retry event');
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].maxRetries, 3);
    assert.equal(text(evts), 'attempt-two', 'only the retried attempt\'s text survives');
    assert.equal(sf.calls(), 2, 'fetch fired twice');
  } finally {
    sf.restore();
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

test('stream: partial output from the failed attempt is void (no glued text)', async () => {
  // A stream that emits SOME text then dies mid-body must not leave that
  // text glued in front of the retried attempt's output.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      // half a stream, then the connection breaks
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'BROKEN-' }, index: 0 }] })}\n\n`));
          c.error(new Error('terminated'));
        },
      });
      return { ok: true, status: 200, text: async () => '', body };
    }
    return openAiStreamResponse('RETRY-OK');
  };
  const restoreT = fastTimers();
  process.env.HK2_LLMAPI_NUMOFRETRIES = '2';
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    const evts = await collect(makeClient().stream(MSGS, { timeoutMs: 0 }));
    assert.equal(text(evts), 'RETRY-OK', 'the broken attempt\'s "BROKEN-" must be discarded');
    assert.ok(evts.some(e => e.type === 'retry'), 'retry event present');
  } finally {
    globalThis.fetch = original;
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

test('stream: exhausting the budget throws after retries+1 attempts', async () => {
  const restoreT = fastTimers();
  const sf = scriptedFetch(['fail']);
  process.env.HK2_LLMAPI_NUMOFRETRIES = '2';
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    await assert.rejects(
      collect(makeClient().stream(MSGS, { timeoutMs: 0 })),
      /LLM request failed after 3 attempts: .*fetch failed/,
    );
    assert.equal(sf.calls(), 3, '1 first attempt + 2 retries = 3 fetches');
  } finally {
    sf.restore();
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

test('stream: HTTP 4xx fails fast — one fetch, no retry events', async () => {
  const restoreT = fastTimers();
  const sf = scriptedFetch([400]);
  process.env.HK2_LLMAPI_NUMOFRETRIES = '5';
  try {
    await assert.rejects(
      collect(makeClient().stream(MSGS, { timeoutMs: 0 })),
      /OpenAI 400/,
    );
    assert.equal(sf.calls(), 1, 'client errors must not be retried');
  } finally {
    sf.restore();
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

test('stream: HTTP 429 and 5xx are retried', async () => {
  const restoreT = fastTimers();
  const sf = scriptedFetch([429, 503, 'third-time-works']);
  process.env.HK2_LLMAPI_NUMOFRETRIES = '5';
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1'; // 503 = unknown-outcome class
  try {
    const evts = await collect(makeClient().stream(MSGS, { timeoutMs: 0 }));
    assert.equal(text(evts), 'third-time-works');
    assert.equal(evts.filter(e => e.type === 'retry').length, 2);
    assert.equal(sf.calls(), 3);
  } finally {
    sf.restore();
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

test('stream: HK2_LLMAPI_NUMOFRETRIES=0 disables retries (single attempt)', async () => {
  const restoreT = fastTimers();
  const sf = scriptedFetch(['fail']);
  process.env.HK2_LLMAPI_NUMOFRETRIES = '0';
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    await assert.rejects(
      collect(makeClient().stream(MSGS, { timeoutMs: 0 })),
      /request failed: fetch failed/,
    );
    assert.equal(sf.calls(), 1);
  } finally {
    sf.restore();
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

test('stream: user abort during the backoff sleep is honored immediately', async () => {
  const sf = scriptedFetch(['fail', 'never-reached']);
  process.env.HK2_LLMAPI_NUMOFRETRIES = '5';
  // REAL timers here: the backoff sleep is 1000ms; abort after 50ms and the
  // sleep must wake early instead of holding the abort hostage.
  const client = makeClient();
  const user = new AbortController();
  const t0 = Date.now();
  const pumping = collect(client.stream(MSGS, { timeoutMs: 0, signal: user.signal }));
  // Abort shortly after the first failure surfaces as a retry event.
  realSetTimeout(() => user.abort(new Error('user cancelled')), 60);
  try {
    await assert.rejects(pumping, (err) => {
      // Must reject (not hang to the full 1s backoff), as a user abort.
      assert.ok(err, 'rejects');
      return true;
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 900, `abort must not wait out the full backoff (took ${elapsed}ms)`);
    assert.equal(sf.calls(), 1, 'no second fetch after abort');
  } finally {
    sf.restore();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
    user.abort();
  }
});

// ---------- complete() retry loop ----------

test('complete: openai non-streaming path retries transient failures', async () => {
  const restoreT = fastTimers();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return httpErrorResponse(502);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
    };
  };
  process.env.HK2_LLMAPI_NUMOFRETRIES = '3';
  // These loop-mechanics tests drive unknown-outcome failures; the opt-in
  // makes the retry loop reachable for them (the default-off policy itself
  // is pinned in the classification test above).
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    const out = await makeClient().complete(MSGS, { timeoutMs: 0 });
    assert.equal(out, 'recovered');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

/** Build a minimal streaming Response for one Anthropic SSE text chunk. */
function anthropicStreamResponse(text) {
  const sse = [
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    `event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`,
    'event: content_block_stop\ndata: {"index":0}\n\n',
    'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {}\n\n',
  ].join('');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  return { ok: true, status: 200, text: async () => '', body };
}

/** Anthropic-style client (complete() drains this.stream on this style). */
function makeAnthropicClient() {
  return new LLMClient({ style: 'anthropic', baseUrl: 'https://x.example', apiKey: 'k', model: 'm' });
}

test('complete: anthropic path resets accumulated text on mid-stream failure + retry', async () => {
  // The anthropic branch of complete() drains this.stream() — it is itself a
  // retry-event consumer. A mid-stream failure after partial deltas must NOT
  // glue the failed attempt's partial text in front of the retried attempt's
  // full text (the same glued-output bug fixed across every other consumer).
  const restoreT = fastTimers();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      // Half a stream (some text delivered), then the connection breaks.
      // NOTE: the first SSE chunk must be enqueued in start() and the break
      // raised from pull() — a synchronous enqueue()+error() drops the
      // queued chunk before the reader ever sees it (verified: Node follows
      // the Streams spec here), which would silently defang this test: no
      // partial delta ever reaches the adapter, so nothing could be glued.
      const sse = [
        'event: message_start\ndata: {"message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"BROKEN-"}}\n\n',
      ].join('');
      const body = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(sse)); },
        pull(c) { c.error(new Error('terminated')); },
      });
      return { ok: true, status: 200, text: async () => '', body };
    }
    return anthropicStreamResponse('RETRY-OK');
  };
  process.env.HK2_LLMAPI_NUMOFRETRIES = '3';
  // These loop-mechanics tests drive unknown-outcome failures; the opt-in
  // makes the retry loop reachable for them (the default-off policy itself
  // is pinned in the classification test above).
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    const out = await makeAnthropicClient().complete(MSGS, { timeoutMs: 0 });
    assert.equal(out, 'RETRY-OK', 'the broken attempt\u2019s "BROKEN-" must be discarded, not glued in front');
    assert.equal(calls, 2, 'fetch fired twice (1 failed + 1 retried)');
  } finally {
    globalThis.fetch = original;
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

test('complete: 401 is not retried', async () => {
  const restoreT = fastTimers();
  const sf = scriptedFetch([401]);
  process.env.HK2_LLMAPI_NUMOFRETRIES = '3';
  // These loop-mechanics tests drive unknown-outcome failures; the opt-in
  // makes the retry loop reachable for them (the default-off policy itself
  // is pinned in the classification test above).
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1';
  try {
    await assert.rejects(
      makeClient().complete(MSGS, { timeoutMs: 0 }),
      /OpenAI 401/,
    );
    assert.equal(sf.calls(), 1);
  } finally {
    sf.restore();
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  }
});

// ---------- adapter abort-listener hygiene (retries reuse one signal) ----------

test('adapters: retried calls reusing one signal do not accumulate abort listeners', async () => {
  const restoreT = fastTimers();
  const sf = scriptedFetch(['fail', 'fail', 'ok-after-two-failures']);
  process.env.HK2_LLMAPI_NUMOFRETRIES = '5';
  process.env.HK2_LLM_RETRY_UNKNOWN_POST = '1'; // 'fetch failed' = unknown class
  const user = new AbortController();
  let maxListeners = 0;
  const origAdd = user.signal.addEventListener.bind(user.signal);
  mock.method(user.signal, 'addEventListener', function (...args) {
    origAdd(...args);
    // count current listener slots roughly via getMaxListeners internal —
    // simpler: count via events API not exposed; use listenerCount fallback
  });
  try {
    // Use the event emitter listener count if available
    const { EventEmitter } = await import('node:events');
    const count = () => EventEmitter.listenerCount(user.signal, 'abort');
    const evts = await collect(makeClient().stream(MSGS, { timeoutMs: 0, signal: user.signal }));
    assert.equal(text(evts), 'ok-after-two-failures');
    assert.equal(sf.calls(), 3);
    // After the call completes every adapter listener must be detached.
    assert.equal(count(), 0, 'abort listeners must be cleaned up after settle');
    maxListeners = count();
  } finally {
    sf.restore();
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
    user.abort();
    mock.restoreAll();
  }
  assert.ok(maxListeners === 0);
});

// ---------- connect-phase ETIMEDOUT regression (Anthropic adapter) ----------

/**
 * Reproduces the reported issue: "Error: Anthropic request failed: fetch
 * failed (ETIMEDOUT)" aborted the call without ANY retry. A connect-phase
 * ETIMEDOUT means the TCP handshake itself timed out — the request never
 * left the client — so it is outcome-safe and MUST be retried with the
 * default policy (HK2_LLM_RETRY_UNKNOWN_POST unset).
 */
test('stream: anthropic connect ETIMEDOUT is retried under the DEFAULT policy', async () => {
  const restoreT = fastTimers();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      // Shape produced by undici when the OS-level TCP connect times out.
      const e = new TypeError('fetch failed');
      e.cause = { name: 'Error', code: 'ETIMEDOUT', errno: -60, syscall: 'connect' };
      throw e;
    }
    return anthropicStreamResponse('recovered-after-connect-timeout');
  };
  // Default policy: unknown-outcome NOT retried. The connect-phase
  // classification must be 'safe', not 'unknown' — this is the regression.
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  process.env.HK2_LLMAPI_NUMOFRETRIES = '3';
  try {
    const out = await makeAnthropicClient().complete(MSGS, { timeoutMs: 0 });
    assert.equal(out, 'recovered-after-connect-timeout');
    assert.equal(calls, 2, 'exactly one retry after the connect timeout');
  } finally {
    globalThis.fetch = original;
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  }
});

// ---------- completeOpenAI transport-error wrapping ----------

/**
 * completeOpenAI used to let fetch transport failures escape UNWRAPPED (a
 * bare TypeError('fetch failed')), which classifyLlmError cannot recognize
 * as a transport failure — so the openai non-streaming path never retried
 * ANY network error. The catch now wraps them like streamOpenAI does.
 */
test('complete: openai transport failures are wrapped + retried under the DEFAULT policy', async () => {
  const restoreT = fastTimers();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      const e = new TypeError('fetch failed');
      e.cause = { code: 'ETIMEDOUT', syscall: 'connect' };
      throw e;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'wrapped-and-retried' } }] }),
    };
  };
  delete process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  process.env.HK2_LLMAPI_NUMOFRETRIES = '3';
  try {
    const out = await makeClient().complete(MSGS, { timeoutMs: 0 });
    assert.equal(out, 'wrapped-and-retried');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    restoreT();
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  }
});
