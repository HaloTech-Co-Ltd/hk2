/*-------------------------------------------------------------------------
 *
 * Shared LLM call-retry resolution (env: HK2_LLMAPI_NUMOFRETRIES).
 *
 * LLM API calls fail transiently all the time: the network drops mid-fetch
 * ("Anthropic request failed: fetch failed"), the gateway returns a 502/503,
 * a rate-limit 429 comes back, or the request times out. Before this module
 * existed ANY such failure aborted the whole agent task, losing all progress.
 *
 * The retry loop lives in lib/llm/client.js (LLMClient.stream / .complete),
 * wrapping the adapter streams. This module supplies the two pure pieces:
 *
 *   llmApiNumOfRetries() — max consecutive retries after a first failure
 *                          (so N retries = N+1 total attempts). Re-read on
 *                          every call, mirroring llmApiTimeoutMs().
 *   isRetryableLlmError(err) — transient-failure classification.
 *
 * Retry policy:
 *   - network-level failures ("request failed: fetch failed" etc.) -> retry
 *   - HTTP 408 / 429 / 5xx -> retry (server side / rate limit)
 *   - adapter "timeout" aborts -> retry
 *   - any other 4xx (400 bad shape, 401 auth, 403, 404 model...) -> FAIL
 *     FAST: retrying a deterministic client error just burns N backoffs and
 *     delays the inevitable error message.
 *   - user aborts (ESC / opts.signal) are NEVER retried and never absorbed
 *     by a backoff sleep.
 *
 * Backoff between attempts: exponential, 1s → 30s cap, no jitter (the CLI
 * is a single interactive process; thundering herd is not a concern).
 *-----------------------------------------------------------------------*/

/** Default max retries after the first failed attempt: 10. */
export const DEFAULT_LLM_NUM_OF_RETRIES = 10;

/** Backoff base (ms) for the first retry; doubles each attempt. */
export const RETRY_BACKOFF_BASE_MS = 1000;

/** Backoff ceiling (ms) per sleep. */
export const RETRY_BACKOFF_MAX_MS = 30000;

/**
 * Resolve the effective max LLM retries from the HK2_LLMAPI_NUMOFRETRIES
 * environment variable.
 *
 * - unset / empty / non-numeric / negative -> DEFAULT_LLM_NUM_OF_RETRIES
 * - explicit `0` -> 0 (retries disabled: exactly one attempt)
 * - any non-negative integer -> that many retries after the first failure
 *
 * The value is re-read on every call (no caching) so tests and long-lived
 * REPL sessions observe changes immediately — same contract as
 * llmApiTimeoutMs() in ./timeout.js.
 */
export function llmApiNumOfRetries() {
  const raw = process.env.HK2_LLMAPI_NUMOFRETRIES;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_LLM_NUM_OF_RETRIES;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LLM_NUM_OF_RETRIES;
  return n;
}

/**
 * Backoff delay before retry attempt n (1-based: 1 = first retry).
 * Exponential from RETRY_BACKOFF_BASE_MS, capped at RETRY_BACKOFF_MAX_MS.
 */
export function retryBackoffMs(retryNo) {
  const n = Math.max(1, retryNo | 0);
  const ms = RETRY_BACKOFF_BASE_MS * Math.pow(2, n - 1);
  return Math.min(ms, RETRY_BACKOFF_MAX_MS);
}

/** HTTP status codes that are worth retrying. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classify an adapter-thrown error as transient (retry) or fatal (fail now).
 *
 * Recognized adapter error shapes (see openai_adapter.js / anthropic_adapter.js):
 *   `OpenAI request failed: <cause>`    / `Anthropic request failed: <cause>`
 *   `OpenAI <status>: <body>`           / `Anthropic <status>: <body>`
 * plus a bare `timeout` (adapter abort timer fires before fetch resolves).
 *
 * User-initiated aborts (err.name === 'AbortError' without the adapter's
 * wrapping, or an opts.signal already aborted) are fatal — the client layer
 * checks the signal itself before sleeping, so this function only judges
 * the error text.
 */
export function isRetryableLlmError(err) {
  if (!err) return false;
  const msg = String(err.message || err);

  // Transport-level failure thrown while establishing the request or reading
  // the stream body ("fetch failed", "terminated", "timeout", "ECONNRESET",
  // "ECONNREFUSED", "socket hang up", ...). These are the classic transient
  // errors the retry mechanism exists for.
  if (/^(\w+ )?request failed:/i.test(msg)) return true;

  // Bare timeout from the adapter's abort timer (may surface as
  // "This operation was aborted" / "The operation was aborted" depending on
  // the runtime's AbortController implementation).
  if (/\btimeout\b/i.test(msg)) return true;
  if (/operation was aborted/i.test(msg)) return true;

  // HTTP status line: "Anthropic 502: ..." / "OpenAI 429: ..."
  const statusMatch = /^(?:OpenAI|Anthropic)\s+(\d{3})\b/.exec(msg);
  if (statusMatch) {
    return RETRYABLE_STATUS.has(Number(statusMatch[1]));
  }

  // 4xx client errors fall through to fatal, as do configuration errors
  // thrown by LLMClient itself ("LLM baseUrl not configured" etc.).
  return false;
}

/**
 * Sleep for `ms`, abortable via `signal`. Resolves early (rejecting with the
 * signal's reason is NOT attempted — the caller re-checks the signal after
 * the sleep) when the user aborts mid-backoff, so an ESC is never held
 * hostage by a 30s backoff.
 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
