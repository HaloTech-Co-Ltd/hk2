/**
 * Plan Review: after the user confirms a plan, ask the LLM to review it for
 * problems (missing steps, wrong order, ambiguous goals, risky strategies,
 * unstated assumptions, requirement coverage gaps, feasibility, etc.). If the
 * reviewer finds issues, the caller surfaces them to the user one-by-one for
 * confirmation, and the confirmed plan (original plan + resolved issues)
 * becomes the final plan.
 *
 * Output contract mirrors lib/agent/code_review.js (the two-part reply):
 * Part 1 === PLAN REVIEW REPORT === - the streaming, human-readable analysis
 *   (requirement re-analysis as a numbered checklist, per-point coverage /
 *   correctness / order / feasibility checks, conclusion). This is what the
 *   user watches stream live via opts.onDelta so the review is never a silent
 *   fast blank pause (the exact complaint that redesigned code review).
 * Part 2 === VERDICT === - one strict JSON object {ok, issues:[...]}.
 *
 * Input: the finalized plan text (the string confirmPlan returned, e.g.
 *   "Summary: ...\nStep 1: <goal> -> <chosen strategy> ...").
 * Output: { ok: boolean, issues: Issue[], report?: string, parseError?: string }
 *   - ok: true when the plan has no problems the reviewer wants to raise.
 *   - issues: [] when ok. When not ok, a list of issues, each:
 *       { title: string, detail: string, suggestion: string }
 *     title: one-line summary of the problem.
 *     detail: why it's a problem (1-2 sentences).
 *     suggestion: the concrete fix the reviewer proposes (the user picks it
 *       or types their own).
 *   - report: the markdown report part of the reply (before the verdict).
 *   - parseError: set when the reply contained NO parseable JSON verdict.
 *     The caller must NOT report "no issues found" in that case - an
 *     unparseable reply is an UNKNOWN verdict, never a passing one.
 *
 * Any transport-level failure (LLM exception) still returns { ok: true } with
 * an `error` field so callers never block (best-effort), and the skip-on-
 * unreachable policy in src/phase_fallback.js handles the warning.
 */

import { REPORT_MARKER, VERDICT_MARKER, splitReviewReply, parseVerdict, createVerdictFilter } from './code_review.js';

const SYSTEM_PROMPT = `You are performing PLAN REVIEW for a coding assistant.

Context: the assistant just proposed an execution plan for the user's
requirement and the user confirmed it (step-by-step, with a chosen strategy
per step). The confirmed plan is about to be executed. Before execution
begins, YOU review it to catch real problems.

This is a review task, NOT an execution task. Do not start doing the work, do
not answer the plan's goal, and do not rewrite the plan wholesale. Judge the
plan - carefully, deeply, and comprehensively.

A plan is OK when:
- It actually covers the requirement: re-derive what the requirement needs and
  check that some step delivers every needed part - nothing important missing,
  nothing half-covered.
- The steps are complete enough to achieve the stated goal.
- The step order is sound (no step depends on the output of a later step).
- Each step's chosen strategy is concrete, actionable, and feasible with the
  tools/files involved - not vague, not wishful.
- No step silently contradicts an earlier step or the user's intent.
- Risks and unstated assumptions are surfaced.

Raise an issue ONLY when fixing it materially improves the outcome. Do not
nitpick style, formatting, or wording. If the plan is sound, return ok=true.

Structure your reply in EXACTLY two parts, in this order:

Part 1 - the review report. Begin with the line:
=== REVIEW REPORT ===
Then write the report in markdown, covering IN THIS ORDER:
1. Requirement re-analysis: restate what the plan (its summary and steps) is
   meant to accomplish, and decompose it into a numbered checklist of
   concrete, verifiable requirements/goals.
2. Coverage check: go through EVERY checklist point. For each point state
   which step(s) cover it and whether that coverage is complete, partial, or
   missing. Never skip a point and never collapse them into a vague summary.
3. Correctness check: examine the plan for ordering problems (dependencies
   running in the wrong order), contradictions between steps, and steps whose
   stated strategy cannot achieve what the step claims.
4. Feasibility check: whether each step's chosen strategy is concrete and
   actionable enough to execute as written, and what risks or unstated
   assumptions the plan carries.
5. Conclusion: a short overall judgment (1-3 sentences).

Part 2 - the machine-readable verdict. Begin with the line:
=== VERDICT ===
Then output ONE strict JSON object (no markdown fences, no commentary):
{"ok": boolean, "issues": [{"title": string, "detail": string, "suggestion": string}]}

- ok: true when the plan needs no changes (issues MUST then be empty).
- issues: empty when ok. Otherwise 1-4 issues, each concrete and self-contained:
  title: a one-line summary of the problem.
  detail: why it is a problem (1-2 sentences).
  suggestion: the concrete change you propose.`;

/**
 * Build the user-turn content that frames the plan text as the OBJECT of a
 * review. Leading with an explicit "you are performing PLAN REVIEW" task
 * declaration - and delimiting the plan - keeps the model from treating the
 * plan as a request to execute (fast phase models can otherwise drift into
 * doing the work or answering the plan's goal instead of judging it).
 */
function buildReviewUserContent(planText) {
  return [
    'You are performing PLAN REVIEW. The text between the markers below is the confirmed',
    'execution plan. Review it according to your instructions and reply in EXACTLY two',
    'parts: first the === REVIEW REPORT === analysis, then the === VERDICT === JSON object.',
    '',
    '=== PLAN UNDER REVIEW (begin) ===',
    planText.trim(),
    '=== PLAN UNDER REVIEW (end) ===',
  ].join('\n');
}

async function callLlm(llm, messages, opts, onDelta) {
  let out = '';
  for await (const evt of llm.stream(messages, opts)) {
    if (evt.type === 'delta') {
      out += evt.text;
      // Forward raw deltas so callers can stream the review report live.
      // Verdict-JSON hiding is the caller's job (createVerdictFilter).
      if (onDelta && evt.text) onDelta(evt.text);
    }
  }
  return out;
}

function ok() {
  return { ok: true, issues: [] };
}

/**
 * Coerce a raw parsed `issues` value into an array of well-formed issue objects.
 * Drops anything missing the required string fields so the caller never renders
 * a half-formed issue.
 */
function coerceIssues(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const detail = typeof item.detail === 'string' ? item.detail.trim() : '';
    const suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : '';
    if (!title) continue; // a title is the minimum to surface an issue
    out.push({ title, detail, suggestion });
  }
  return out;
}

/**
 * Review a finalized plan.
 *
 * @param {import('../llm/client.js').LLMClient} llm
 * @param {string} planText  The finalized plan string (summary + steps with the
 *        user's chosen strategies), exactly what confirmPlan returned. It is
 *        embedded verbatim inside explicit PLAN REVIEW markers in the user
 *        turn so the model knows it is the review target, not a task to run.
 * @param {{signal?: AbortSignal, timeoutMs?: number, onDelta?: (text: string) => void}} [opts]
 *        onDelta receives every raw body delta (wrap it with
 *        createVerdictFilter to hide the verdict JSON while streaming).
 * @returns {Promise<{ok: boolean, issues: Array<{title:string, detail:string, suggestion:string}>, report?: string, parseError?: string}>}
 */
export async function reviewPlan(llm, planText, opts = {}) {
  if (!planText || !planText.trim()) return ok();
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildReviewUserContent(planText) },
    ];
    const raw = await callLlm(
      llm,
      messages,
      {
        temperature: 0.1,
        // NOTE: do NOT pass maxChars here. In the OpenAI adapter maxChars maps
        // to max_tokens (maxChars/4): 2048 capped the reply at ~512 tokens,
        // truncating the review report + verdict JSON mid-stream. A truncated
        // JSON fails to parse, and the old code silently degraded that to
        // {ok:true} - a fast, silent, fake "no issues found" review. Leaving
        // maxChars unset lets the adapter use the model's own configured
        // context window / provider default (same fix as code_review.js).
        enableReasoning: false,
        timeoutMs: opts.timeoutMs ?? 120000,
        signal: opts.signal,
      },
      opts.onDelta
    );
    const { report, verdictRaw } = splitReviewReply(raw);
    let parsed = parseVerdict(verdictRaw);
    // No VERDICT-marker reply parsed: fall back to the whole text once
    // (legacy pure-JSON / fenced replies have verdictRaw === raw, so this
    // only guards a marker-then-still-unparseable case).
    if (!parsed && verdictRaw !== raw) parsed = parseVerdict(raw);
    if (!parsed) {
      // The reply contained no usable JSON verdict. NEVER let the caller
      // render this as "no issues found": an unparseable reply is an UNKNOWN
      // verdict. Surface it via parseError; keep ok:true so the plan-review
      // gate does not block the already-confirmed plan.
      const bestReport = report && report.trim() ? report : (raw || '').trim();
      return { ...ok(), report: bestReport, parseError: 'the plan review reply contained no JSON verdict' };
    }
    // Treat missing/true/null as ok; only an explicit false means issues.
    if (parsed.ok !== false) return { ...ok(), report };
    const issues = coerceIssues(parsed.issues);
    if (issues.length === 0) {
      // The model said not-ok but produced no usable issues - treat as ok to
      // avoid a dead-end prompt with nothing for the user to confirm.
      return { ...ok(), report };
    }
    return { ok: false, issues, report };
  } catch (err) {
    // Transport-level failure (connection refused / timeout / HTTP error):
    // still degrade to { ok: true } so the already-confirmed plan is used
    // unchanged, but surface the reason via `error` so the caller can warn +
    // skip the phase (see src/phase_fallback.js).
    return { ...ok(), error: err?.message || String(err) };
  }
}

export default reviewPlan;
