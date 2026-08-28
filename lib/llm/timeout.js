/*-------------------------------------------------------------------------
 *
 * Shared LLM request-timeout resolution (env: HK2_LLMAPI_TIMEOUT_MS).
 *
 * Before this module existed the 3600000ms (3600s) default was hardcoded
 * in SIX places that had to be kept in sync manually:
 *
 *   lib/llm/client.js          (LLMClient.stream / .complete fallback chain)
 *   lib/llm/openai_adapter.js  (streamOpenAI / completeOpenAI abort timer)
 *   lib/llm/anthropic_adapter.js (streamAnthropic abort timer)
 *   lib/config/home.js         (resolveModelRef stamps config.timeout)
 *
 * Resolution precedence (unchanged from the pre-env era):
 *
 *   per-call opts.timeoutMs  >  per-model config.timeout  >  env default
 *
 * `0` means NO timeout: no abort timer is armed at all. plan-review /
 * code-review pass timeoutMs: 0 explicitly and rely on this — a review cut
 * off mid-reply loses its verdict JSON. See test/llm_no_timeout.test.js.
 *
 * The env var only feeds the DEFAULT (the last link of the chain above):
 * setting HK2_LLMAPI_TIMEOUT_MS=0 therefore does NOT disable timeouts for
 * calls that resolved a concrete value earlier in the chain; it only
 * changes the fallback used when nothing else provided one.
 *
 * A sibling variable HK2_LLMAPI_TIMEOUT_MS_SIMPLE (default 300000ms = 300s,
 * see llmApiTimeoutMsSimple below) budgets the lightweight single-shot
 * phases instead — query rewrite and request-clarity assessment
 * (lib/retrieval/rewrite_query.js), which previously hardcoded 15000ms.
 *-----------------------------------------------------------------------*/

/** Default LLM request timeout: 3600000ms = 3600s. */
export const DEFAULT_LLM_TIMEOUT_MS = 3600000;

/**
 * Default timeout for the "simple" single-shot LLM phases (query rewrite /
 * request clarity assessment): 300000ms = 300s.
 */
export const DEFAULT_LLM_TIMEOUT_MS_SIMPLE = 300000;

/**
 * Resolve the effective default LLM request timeout from the
 * HK2_LLMAPI_TIMEOUT_MS environment variable.
 *
 * - unset / empty / non-numeric / negative -> DEFAULT_LLM_TIMEOUT_MS
 * - explicit `0` -> 0 (means "no timeout"; adapters arm no abort timer)
 * - any positive integer -> that many milliseconds
 *
 * The value is re-read on every call (no caching) so tests and long-lived
 * REPL sessions observe changes immediately.
 */
export function llmApiTimeoutMs() {
  const raw = process.env.HK2_LLMAPI_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_LLM_TIMEOUT_MS;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LLM_TIMEOUT_MS;
  return n;
}

/**
 * Resolve the effective timeout for the "simple" single-shot LLM phases
 * (query rewrite / request clarity assessment) from the
 * HK2_LLMAPI_TIMEOUT_MS_SIMPLE environment variable.
 *
 * Same parsing convention as llmApiTimeoutMs():
 *
 * - unset / empty / non-numeric / negative -> DEFAULT_LLM_TIMEOUT_MS_SIMPLE
 * - explicit `0` -> 0 (means "no timeout"; adapters arm no abort timer)
 * - any positive integer -> that many milliseconds
 *
 * Re-read on every call (no caching), so runtime changes are observed
 * immediately. Callers that want to override per-call still pass
 * opts.timeoutMs, which beats this default (same precedence chain as
 * llmApiTimeoutMs).
 */
export function llmApiTimeoutMsSimple() {
  const raw = process.env.HK2_LLMAPI_TIMEOUT_MS_SIMPLE;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_LLM_TIMEOUT_MS_SIMPLE;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LLM_TIMEOUT_MS_SIMPLE;
  return n;
}
