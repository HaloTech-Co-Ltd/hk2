/**
 * Plan Review: after the user confirms a plan, ask the LLM to review it for
 * problems (missing steps, wrong order, ambiguous goals, risky strategies,
 * unstated assumptions, etc.). If the reviewer finds issues, the caller
 * surfaces them to the user one-by-one for confirmation, and the confirmed
 * plan (original plan + resolved issues) becomes the final plan.
 *
 * Mirrors the shape of lib/retrieval/rewrite_query.js: a SYSTEM_PROMPT, a
 * streaming callLlm, a JSON extractor, and a best-effort fallback that
 * returns { ok: true } on any failure so callers fall through to the normal
 * confirmed-plan path.
 *
 * Input: the finalized plan text (the string confirmPlan returned, e.g.
 *   "Summary: ...\nStep 1: <goal> -> <chosen strategy> ...").
 * Output: { ok: boolean, issues: Issue[] }
 *   - ok: true when the plan has no problems the reviewer wants to raise.
 *   - issues: [] when ok. When not ok, a list of issues, each:
 *       { title: string, detail: string, suggestion: string }
 *     title: one-line summary of the problem.
 *     detail: why it's a problem (1-2 sentences).
 *     suggestion: the concrete fix the reviewer proposes (the user picks it
 *       or types their own).
 *
 * Any failure (LLM exception, JSON parse, empty output, no issues field)
 * silently returns { ok: true, issues: [] } so the caller proceeds with the
 * already-confirmed plan. Review is best-effort, never blocks.
 */

const SYSTEM_PROMPT = `You are performing PLAN REVIEW for a coding assistant.

Context: the assistant just proposed an execution plan and the user confirmed it
(step-by-step, with a chosen strategy per step). The confirmed plan is about to be
executed. Before execution begins, YOU review it to catch real problems.

This is a review task, NOT an execution task. Do not start doing the work, do not
answer the plan's goal, and do not rewrite the plan wholesale. Judge the plan.

A plan is OK when:
- The steps are complete enough to achieve the stated goal.
- The step order is sound (no step depends on the output of a later step).
- Each step's chosen strategy is concrete and actionable, not vague.
- No step silently contradicts an earlier step or the user's intent.
- Risks and unstated assumptions are surfaced.

Raise an issue ONLY when fixing it materially improves the outcome. Do not nitpick
style, formatting, or wording. If the plan is sound, return ok=true.

For each issue return:
- title: a one-line summary of the problem.
- detail: why it is a problem (1-2 sentences).
- suggestion: the concrete change you propose (the user can accept it, dismiss it,
  or type their own).

Only output strict JSON. No markdown fences, no explanation:
{"ok": boolean, "issues": [{"title": string, "detail": string, "suggestion": string}]}

- ok: true when the plan needs no changes (issues MUST then be empty).
- issues: empty when ok. Otherwise 1-4 issues, each concrete and self-contained.`;

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
    'execution plan. Review it according to your instructions and reply with ONLY the JSON',
    'verdict object ({"ok": boolean, "issues": [...]}).',
    '',
    '=== PLAN UNDER REVIEW (begin) ===',
    planText.trim(),
    '=== PLAN UNDER REVIEW (end) ===',
  ].join('\n');
}

async function callLlm(llm, messages, opts) {
  let out = '';
  for await (const evt of llm.stream(messages, opts)) {
    if (evt.type === 'delta') out += evt.text;
  }
  return out;
}

function extractJsonObject(raw) {
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
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
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, issues: Array<{title:string, detail:string, suggestion:string}>}>}
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
        maxChars: 2048,
        enableReasoning: false,
        timeoutMs: opts.timeoutMs ?? 20000,
        signal: opts.signal,
      }
    );
    const parsed = extractJsonObject(raw);
    if (!parsed) return ok();
    // Treat missing/true/null as ok; only an explicit false means issues.
    if (parsed.ok !== false) return ok();
    const issues = coerceIssues(parsed.issues);
    if (issues.length === 0) {
      // The model said not-ok but produced no usable issues - treat as ok to
      // avoid a dead-end prompt with nothing for the user to confirm.
      return ok();
    }
    return { ok: false, issues };
  } catch (err) {
    // Transport-level failure (connection refused / timeout / HTTP error):
    // still degrade to { ok: true } so the already-confirmed plan is used
    // unchanged, but surface the reason via `error` so the caller can warn +
    // skip the phase (see src/phase_fallback.js).
    return { ...ok(), error: err?.message || String(err) };
  }
}

export default reviewPlan;
