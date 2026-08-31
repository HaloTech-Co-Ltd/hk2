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
 * Retry policy (HK2_LLM_RETRY_UNKNOWN_POST defaults ON; set 0 to opt out):
 *   - network-level failures ("request failed: fetch failed" etc.) -> retry
 *   - HTTP 408 / 429 -> always retry (refused BEFORE execution: safe)
 *   - connect-phase transport failures ("(ECONNREFUSED)", "(ETIMEDOUT/connect)"
 *     ...) -> always retry (the request never left the client: safe)
 *   - HTTP 500/502/503/504 and mid-flight transport failures (reset after send,
 *     read/write-phase timeout) -> retried by DEFAULT: for interactive CLI use
 *     a dead turn on a transient nginx 502 is far more painful than the rare
 *     duplicate request behind it. These have UNKNOWN outcome (the gateway may
 *     speak for an upstream that already ran the inference), so providers that
 *     bill per request can set HK2_LLM_RETRY_UNKNOWN_POST=0 to disable this
 *     class (no idempotency key exists, classification is the only guard).
 *   - adapter "timeout" aborts -> retry (unknown-outcome class above)
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

// Outcome-safe statuses: the server refused the request BEFORE executing it,
// so a re-POST cannot duplicate work. 408 = the server gave up waiting for
// the (incomplete) request; 429 = rate-limited/refused.
const SAFE_STATUS = new Set([408, 429]);
// Unknown-outcome statuses: a reverse proxy can return these AFTER the
// upstream already ran the inference — a re-POST may duplicate the request
// and the billing, exactly like a mid-flight connection reset.
const UNKNOWN_STATUS = new Set([500, 502, 503, 504]);
// Transport cause codes that mean the request NEVER LEFT the client — always
// safe to retry. (The adapters surface err.cause.code — and, when undici
// reports the failing syscall, err.cause.syscall — in the message as
// "(CODE)" or "(CODE/SYSCALL)"; see the causeCode check in classifyLlmError.)
const ESTABLISH_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Whether unknown-outcome failures (mid-flight transport errors and 5xx)
 * should be retried. DEFAULT ON: a reverse-proxy 502/503 on a transient
 * upstream blip used to abort the whole agent turn, which is worse for an
 * interactive CLI than the rare duplicate request behind the retry — the
 * reported "Anthropic 502: ...nginx..." never retried despite the retry
 * machinery being in place. Set HK2_LLM_RETRY_UNKNOWN_POST=0 (or no/false/off)
 * to opt out when duplicate requests / duplicate billing are a concern;
 * providers expose no idempotency key, so classification is the only guard.
 */
export function retryUnknownEnabled() {
  const v = process.env.HK2_LLM_RETRY_UNKNOWN_POST;
  if (v === undefined || v === null || String(v).trim() === '') return true;
  return !/^(0|no|false|off)$/i.test(String(v).trim());
}

/**
 * Classify an adapter-thrown error by whether the server can already have
 * EXECUTED the request:
 *
 *   'safe'    — never delivered or refused before execution; retrying
 *               cannot duplicate work (always retried)
 *   'unknown' — may have been executed (mid-flight transport failure, or a
 *               5xx the gateway returned after the upstream ran); retried
 *               only when retryUnknownEnabled()
 *   null      — deterministic (4xx other than 408/429, config errors)
 *
 * Recognized adapter error shapes (see openai_adapter.js / anthropic_adapter.js):
 *   `OpenAI request failed: <cause> (ECONNRESET)` — the adapters append the
 *   undici cause code, which separates never-left from mid-flight
 *   `OpenAI <status>: <body>`
 * plus a bare `timeout` (adapter abort timer fires before fetch resolves —
 * unknown outcome: the request was sent and we stopped waiting).
 *
 * User-initiated aborts (err.name === 'AbortError' without the adapter's
 * wrapping, or an opts.signal already aborted) are fatal — the client layer
 * checks the signal itself before sleeping, so this function only judges
 * the error text.
 */
export function classifyLlmError(err) {
  if (!err) return null;
  const msg = String(err.message || err);

  // HTTP status line first: "Anthropic 502: ..." / "OpenAI 429: ..."
  const statusMatch = /^(?:OpenAI|Anthropic)\s+(\d{3})\b/.exec(msg);
  if (statusMatch) {
    const code = Number(statusMatch[1]);
    if (SAFE_STATUS.has(code)) return 'safe';
    if (UNKNOWN_STATUS.has(code)) return 'unknown';
    return null;
  }

  // Transport-level failure thrown while establishing the request or reading
  // the stream body ("fetch failed", "terminated", "timeout", ...).
  const transport = /^(\w+ )?request failed:/i.test(msg)
    || /\btimeout\b/i.test(msg)
    || /operation was aborted/i.test(msg)
    || /\b(terminated|socket hang up|network)\b/i.test(msg);
  if (transport) {
    // The adapters append the undici cause as "(CODE)" or "(CODE/SYSCALL)":
    //   - CODE in ESTABLISH_CODES -> provably never delivered ('safe')
    //   - SYSCALL 'connect'       -> the TCP handshake itself failed, so
    //                                 nothing was ever sent: outcome-safe.
    //                                 Covers connect-phase ETIMEDOUT (the
    //                                 OS-level TCP connect timeout), plus
    //                                 EHOSTUNREACH / ENETUNREACH / ...
    //   - anything else — (ETIMEDOUT/read), (ECONNRESET), or a bare
    //     (ETIMEDOUT) with no syscall (older message shape) — the request
    //     may already have been delivered: 'unknown', opt-in only.
    const causeCode = /\(([A-Z0-9_]+)(?:\/(\w+))?\)/.exec(msg);
    if (causeCode) {
      if (ESTABLISH_CODES.has(causeCode[1])) return 'safe';
      if (causeCode[2] === 'connect') return 'safe';
    }
    return 'unknown';
  }

  // 4xx client errors fall through to fatal, as do configuration errors
  // thrown by LLMClient itself ("LLM baseUrl not configured" etc.).
  return null;
}

export function isRetryableLlmError(err) {
  const kind = classifyLlmError(err);
  if (kind === 'safe') return true;
  if (kind === 'unknown') return retryUnknownEnabled();
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
