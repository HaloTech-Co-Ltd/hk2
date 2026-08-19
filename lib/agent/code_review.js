/**
 * Code Review: after the agent finishes executing a plan, ask an LLM to review
 * the completed work for correctness, completeness, and quality. Mirrors the
 * shape of lib/agent/plan_review.js (and lib/retrieval/rewrite_query.js): a
 * SYSTEM_PROMPT, a streaming callLlm, a JSON extractor, and a best-effort
 * fallback that returns { ok: true } on any failure so callers never block.
 *
 * Input: a review text built by buildCodeReviewContent() — the plan (what was
 *   asked for), the list of changed files, the working-tree diff (the actual
 *   changes), and the assistant's final answer. The text is embedded inside
 *   explicit CODE REVIEW markers so the model knows it is the review target,
 *   not a task to continue.
 * Output: { ok: boolean, issues: Issue[] }
 *   - ok: true when the result has no problems the reviewer wants to raise.
 *   - issues: [] when ok. When not ok, a list of issues, each:
 *       { title: string, detail: string, suggestion: string }
 *     title: one-line summary of the problem.
 *     detail: why it's a problem (1-2 sentences, referencing the change).
 *     suggestion: the concrete fix the reviewer proposes.
 *
 * Any failure (LLM exception, JSON parse, empty output, no issues field)
 * silently returns { ok: true, issues: [] } so the caller proceeds normally.
 * Review is best-effort, never blocks.
 */

const SYSTEM_PROMPT = `You are performing CODE REVIEW for a coding assistant.

Context: the assistant just finished executing a plan (a multi-step coding task)
and changed files in the codebase. The plan (what was asked to be done), the list
of changed files, the working-tree diff of the actual changes, and the assistant's
final summary are provided. YOU review the RESULT of the work — the actual
changes — not the process that produced them.

This is a review task, NOT an execution task. Do not make further edits, do not
continue the task, and do not rewrite the code wholesale. Judge the completed
result against the plan (or, when no plan is present, against the assistant's
final summary).

The result is OK when:
- The changes actually implement what the plan asked for, with nothing important
  missing or left half-done.
- The changes are correct: no obvious bugs, broken references, syntax/type errors,
  or dangling TODOs/FIXMEs the assistant introduced.
- The changes are complete: every goal is addressed; nothing is stubbed without
  a clear note; no file was accidentally left inconsistent with the others.
- The changes are high quality: clear and consistent with the surrounding code,
  no duplicated or dead code, no missing error handling, no leaked secrets or
  credentials, and no unrelated files changed by accident.
- Any claim the assistant makes in its final summary is consistent with the diff.

Raise an issue ONLY when fixing it materially improves the result. Do not nitpick
trivial style or wording. If the result is sound, return ok=true.

For each issue return:
- title: a one-line summary of the problem.
- detail: why it is a problem (1-2 sentences), naming the file or change.
- suggestion: the concrete fix you propose.

Only output strict JSON. No markdown fences, no explanation:
{"ok": boolean, "issues": [{"title": string, "detail": string, "suggestion": string}]}

- ok: true when the result needs no changes (issues MUST then be empty).
- issues: empty when ok. Otherwise 1-6 issues, each concrete and self-contained.`;

/** Maximum diff size embedded into the review prompt (chars). Keeps the review
 *  context bounded; anything larger is truncated with an explicit notice so the
 *  reviewer knows the diff is incomplete. */
const MAX_DIFF_CHARS = 48000;

/**
 * Build the user-turn content that frames the completed work as the OBJECT of a
 * code review. Leading with an explicit "you are performing CODE REVIEW" task
 * declaration - and delimiting each section - keeps the model from treating the
 * diff/answer as a task to continue.
 *
 * @param {{planText?: string, changedFiles?: string[], diffText?: string, answerText?: string}} [input]
 * @returns {string}
 */
export function buildCodeReviewContent({ planText = '', changedFiles = [], diffText = '', answerText = '' } = {}) {
  const sections = [
    'You are performing CODE REVIEW. The material below is the completed result',
    'of the plan execution. Review it according to your instructions and reply',
    'with ONLY the JSON verdict object ({"ok": boolean, "issues": [...]}).',
    '',
  ];

  if (planText && planText.trim()) {
    sections.push('=== PLAN (what was asked to be done) (begin) ===');
    sections.push(planText.trim());
    sections.push('=== PLAN (end) ===');
    sections.push('');
  }

  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    sections.push('=== CHANGED FILES (begin) ===');
    sections.push(changedFiles.join('\n'));
    sections.push('=== CHANGED FILES (end) ===');
    sections.push('');
  }

  sections.push('=== DIFF (the actual changes) (begin) ===');
  if (diffText && diffText.trim()) {
    let body = diffText.trim();
    if (body.length > MAX_DIFF_CHARS) {
      body = body.slice(0, MAX_DIFF_CHARS)
        + `\n... (diff truncated to ${MAX_DIFF_CHARS} chars) ...`;
    }
    sections.push(body);
  } else {
    sections.push('(no working-tree diff was available — review the plan and final answer only)');
  }
  sections.push('=== DIFF (end) ===');
  sections.push('');

  if (answerText && answerText.trim()) {
    sections.push('=== ASSISTANT FINAL ANSWER (begin) ===');
    sections.push(answerText.trim());
    sections.push('=== ASSISTANT FINAL ANSWER (end) ===');
  }

  return sections.join('\n');
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
 * Review the completed result of a plan execution.
 *
 * @param {import('../llm/client.js').LLMClient} llm
 * @param {string} reviewText  The review content produced by
 *        buildCodeReviewContent() (plan + changed files + diff + final answer).
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, issues: Array<{title:string, detail:string, suggestion:string}>}>}
 */
export async function reviewCode(llm, reviewText, opts = {}) {
  if (!reviewText || !reviewText.trim()) return ok();
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: reviewText },
    ];
    const raw = await callLlm(
      llm,
      messages,
      {
        temperature: 0.1,
        // NOTE: do NOT pass maxChars here. In the OpenAI adapter maxChars maps
        // to max_tokens (maxChars/4): 4096 would cap the review JSON at 1024
        // tokens, truncating multi-issue output mid-JSON. Truncation feeds a
        // partial JSON string to extractJsonObject, which fails, and the
        // fallback would then silently report "ok" - the worst outcome for a
        // review step. Leaving it unset lets the adapter use the model's own
        // configured context window / provider default.
        enableReasoning: false,
        timeoutMs: opts.timeoutMs ?? 120000,
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
      // avoid a dead-end message with nothing for the user to read.
      return ok();
    }
    return { ok: false, issues };
  } catch (err) {
    // Transport-level failure (connection refused / timeout / HTTP error):
    // still degrade to { ok: true } so the turn ends normally, but surface
    // the reason via `error` so the caller can warn + skip the phase (see
    // src/phase_fallback.js).
    return { ...ok(), error: err?.message || String(err) };
  }
}

export default reviewCode;
