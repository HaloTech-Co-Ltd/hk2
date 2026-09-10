/*-------------------------------------------------------------------------
 *
 * Phase-model fallback policy.
 *
 * Pipeline phases (rewrite-query, request-assess, plan-review, code-review)
 * can be pinned to a dedicated phase model via `/model set-phase`. When that
 * model is configured but UNREACHABLE (connection refused, timeout, HTTP
 * error), the phase functions degrade gracefully (rewriteQuery returns a
 * fallback object, assessRequest returns { clear: true }) — which used to make
 * the phase look SUCCESSFUL with no warning at all.
 *
 * This module turns that silent degradation into an explicit policy, with
 * ONE policy per phase family:
 *
 *   - runPhaseWithFallback() — for the turn-pipeline phases rewrite-query /
 *     request-assess. Driven by the HK2_ENABLE_PHASEMODEL_FALLBACK env var
 *     (default 1):
 *
 *       1 (default): print a warning, then re-run the phase on the current
 *                    session (main) model so the phase still completes.
 *       0          : print a warning and SKIP the phase entirely (result null).
 *
 *   - runPhaseWithSkipOnUnreachable() — for the REVIEW phases (the automatic
 *     plan-review / code-review). It NEVER re-runs a review on the session
 *     model: an unreachable reviewer is skipped with warnings instead.
 *     Review is therefore NOT governed by HK2_ENABLE_PHASEMODEL_FALLBACK —
 *     a dedicated review model must never be silently substituted. (The
 *     MANUAL `/review code` command resolves its model separately in
 *     src/slash/review.js.)
 *
 * Detection signal: the phase functions (lib/retrieval/rewrite_query.js) set
 * `error` on their returned object when the underlying LLM call failed at the
 * transport level. runPhaseWithFallback treats a thrown exception the same way
 * (defensive: the phase functions catch internally, but the contract of a
 * caller-supplied `run` is not guaranteed).
 */

/**
 * Parse HK2_ENABLE_PHASEMODEL_FALLBACK. Unset/empty -> default (enabled).
 * Mirrors the envFlag semantics used in src/commands/interactive.js.
 */
export function phaseModelFallbackEnabled() {
  const v = process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
  if (v === undefined || v === null || v === '') return true;
  return /^(1|yes|true|on)$/i.test(v.trim());
}

async function tryRun(run, llm) {
  try {
    const result = await run(llm);
    if (result && typeof result === 'object' && result.error) {
      return { result, error: result.error };
    }
    return { result, error: null };
  } catch (err) {
    return { result: null, error: err?.message || String(err) };
  }
}

/**
 * Run one pipeline phase under the fallback policy.
 *
 * @param {object} args
 * @param {string} args.phase  Phase name for warning messages ('rewrite-query',
 *   'request-assess', ...).
 * @param {import('../lib/llm/client.js').LLMClient|null} args.phaseLlm  The
 *   configured per-phase model, or null when the project has no override.
 * @param {import('../lib/llm/client.js').LLMClient} args.sessionLlm  The
 *   current session (main) model.
 * @param {(llm: any) => Promise<any>} args.run  The phase body. Receives the
 *   LLM to run on; must return a result object whose truthy `error` field (if
 *   present) signals a transport-level failure.
 * @param {(msg: string) => void} args.warn  Warning sink (ctx.print in the
 *   REPL, an array collector in tests).
 * @returns {Promise<{result: any, llm: any, usedFallback: boolean, skipped: boolean, error: string|null}>}
 *   - result: the phase result, or null when the phase was skipped
 *     (HK2_ENABLE_PHASEMODEL_FALLBACK=0). A non-null result whose own `error`
 *     is set means BOTH the phase model and the session-model retry failed —
 *     the caller keeps today's degrade-to-fallback behavior.
 *   - llm: the model that produced `result` (null when skipped). Callers that
 *     re-run the same phase later in the turn (e.g. the post-clarification
 *     pass-2 rewrite) should reuse this instead of re-resolving, so a phase
 *     skipped in pass-1 stays skipped and a fallback stays on the session
 *     model without duplicate warnings.
 *   - usedFallback: the phase model was configured but unreachable and the
 *     phase completed on the session model instead.
 *   - skipped: the phase was skipped entirely (fallback disabled).
 *   - error: the phase model's failure reason when a fallback/skip happened.
 */
export async function runPhaseWithFallback({ phase, phaseLlm, sessionLlm, run, warn }) {
  // No dedicated phase model configured: plain pass-through, no policy, no
  // warnings (unchanged historic behavior — the session model failing here is
  // surfaced by the main agent loop, not this policy).
  if (!phaseLlm) {
    const r = await tryRun(run, sessionLlm);
    return { result: r.result, llm: sessionLlm, usedFallback: false, skipped: false, error: r.error };
  }

  const first = await tryRun(run, phaseLlm);
  if (!first.error) {
    return { result: first.result, llm: phaseLlm, usedFallback: false, skipped: false, error: null };
  }

  // Phase model configured but unreachable.
  warn(`[warn] phase model for ${phase} is unreachable: ${first.error}`);
  if (!phaseModelFallbackEnabled()) {
    warn(`[warn] skipping the ${phase} phase (HK2_ENABLE_PHASEMODEL_FALLBACK=0)`);
    return { result: null, llm: null, usedFallback: false, skipped: true, error: first.error };
  }
  warn(`[warn] falling back to the session model for the ${phase} phase (HK2_ENABLE_PHASEMODEL_FALLBACK=1)`);
  const second = await tryRun(run, sessionLlm);
  if (second.error) {
    // Both the phase model and the session model failed. Degrade to the
    // historic behavior (caller keeps the fallback result) but never
    // silently — the user must know the phase produced nothing useful.
    warn(`[warn] session model also failed for the ${phase} phase: ${second.error}`);
  }
  return { result: second.result, llm: sessionLlm, usedFallback: true, skipped: false, error: first.error };
}

/**
 * Run one REVIEW phase (plan-review / code-review) under the "skip when the
 * model is unreachable" policy. Unlike runPhaseWithFallback this NEVER re-runs
 * the phase on the session (main) model — a review is an independent quality
 * gate, and silently substituting an unplanned model would change what the user
 * believes reviewed their plan/code. When the model that would run the review
 * (the configured phase model, or the session model when no override exists)
 * is unreachable, print warnings and SKIP the phase entirely.
 *
 * This policy deliberately ignores HK2_ENABLE_PHASEMODEL_FALLBACK: falling
 * back would contradict the point of a dedicated review model, and running a
 * dead review is exactly the silent-success failure mode this guards against.
 *
 * Same args/return contract as runPhaseWithFallback (usedFallback is always
 * false here; skipped=true means the phase must not render any result).
 */
export async function runPhaseWithSkipOnUnreachable({ phase, phaseLlm, sessionLlm, run, warn }) {
  const target = phaseLlm || sessionLlm;
  const first = await tryRun(run, target);
  if (!first.error) {
    return { result: first.result, llm: target, usedFallback: false, skipped: false, error: null };
  }

  // Unreachable. Two warnings, then skip — never fall back, never silent.
  warn(`[warn] ${phaseLlm ? 'phase model for' : 'session model for'} ${phase} is unreachable: ${first.error}`);
  warn(`[warn] skipping the ${phase} phase`);
  return { result: null, llm: null, usedFallback: false, skipped: true, error: first.error };
}

export default runPhaseWithFallback;
