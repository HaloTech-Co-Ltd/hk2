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
 * Output: { ok: boolean, issues: Issue[], report?: string, parseError?: string }
 *   - ok: true when the result has no problems the reviewer wants to raise.
 *   - issues: [] when ok. When not ok, a list of issues, each:
 *       { title: string, detail: string, suggestion: string }
 *     title: one-line summary of the problem.
 *     detail: why it's a problem (1-2 sentences, referencing the change).
 *     suggestion: the concrete fix the reviewer proposes.
 *   - report: the markdown REVIEW REPORT part of the reply (requirement
 *     re-analysis, coverage check, correctness check, conclusion). Callers
 *     stream this live via opts.onDelta and may also read it from the result.
 *   - parseError: set when the reply contained NO parseable JSON verdict.
 *     The caller must NOT report "no issues found" in that case — an
 *     unparseable reply is an unknown verdict, never a passing one.
 *
 * Any transport-level failure (LLM exception) still returns { ok: true } with
 * an `error` field so callers never block (best-effort), and the skip-on-
 * unreachable policy in src/phase_fallback.js handles the warning.
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

Structure your reply in EXACTLY two parts, in this order:

Part 1 - the review report. Begin with the line:
=== REVIEW REPORT ===
Then write the report in markdown, covering IN THIS ORDER:
1. Plan re-analysis: restate what the plan asked for and decompose it into a
   numbered checklist of concrete, verifiable points.
2. Coverage check: go through EVERY checklist point. For each point state what
   you inspected and whether the changes shown actually implement it (name the
   file/hunk when they do), or that it is missing / half-done / unverifiable.
   Never skip a point and never collapse them into a vague summary.
3. Correctness check: what you examined for bugs, broken references, syntax or
   logic flaws, and edge cases in the changes shown, and what you found.
4. Consistency check: whether each claim in the assistant's final summary is
   supported by the diff.
5. Conclusion: a short overall judgment (1-3 sentences).

Part 2 - the machine-readable verdict. Begin with the line:
=== VERDICT ===
Then output ONE strict JSON object (no markdown fences, no commentary):
{"ok": boolean, "issues": [{"title": string, "detail": string, "suggestion": string}]}

- ok: true when the result needs no changes (issues MUST then be empty).
- issues: empty when ok. Otherwise 1-6 issues, each concrete and self-contained:
  title: a one-line summary of the problem.
  detail: why it is a problem (1-2 sentences), naming the file or change.
  suggestion: the concrete fix you propose.`;

/**
 * System prompt for the MANUAL /review code command. Unlike the automatic
 * end-of-turn review (which judges against the plan), this reviews a completed
 * task from the OUTSIDE: only the original user request and the assistant's
 * claimed result are provided - NO conversation context, no execution process,
 * no tool outputs. That deliberate isolation keeps the reviewer from being
 * anchored by how the work was done, so it verifies the result on its own
 * merits (regression checking) instead of rubber-stamping the process.
 */
export const MANUAL_REVIEW_SYSTEM_PROMPT = `You are an independent reviewer performing a REGRESSION CHECK on a completed coding task.

Context: another coding assistant claims to have fully completed the user's
requirement below. You are given ONLY the original requirement, the assistant's
claimed result/summary, the list of changed files, and the working-tree diff.
You do NOT see how the work was done, and you must not assume anything beyond
what is shown. Verify the RESULT, not the process.

The requirement is claimed to be fully completed. Perform a careful, deep, and
comprehensive regression check on the work and its result to make sure the
functionality is correct and nothing is missing or left broken.

This is a review task, NOT an execution task. Do not make further edits, do not
continue the task, and do not rewrite the code wholesale.

The result is OK when:
- Every part of the requirement is actually implemented by the changes shown,
  with nothing important missing or left half-done.
- The changes are correct: no obvious bugs, broken references, syntax/type
  errors, logic flaws, or edge cases the requirement clearly implies.
- The changes are complete: no goal is stubbed without a clear note, no file is
  accidentally left inconsistent with the others.
- The changes are high quality: clear and consistent with the surrounding code,
  no duplicated or dead code, no missing error handling, no leaked secrets or
  credentials, and no unrelated files changed by accident.
- Every claim in the assistant's summary is consistent with the diff. A claim
  that the diff does not support is an issue.

Raise an issue ONLY when fixing it materially improves the result. Do not
nitpick trivial style or wording. If the result is sound, return ok=true.

Structure your reply in EXACTLY two parts, in this order:

Part 1 - the review report. Begin with the line:
=== REVIEW REPORT ===
Then write the report in markdown, covering IN THIS ORDER:
1. Requirement re-analysis: restate the original requirement in your own words
   and decompose it into a numbered checklist of concrete, verifiable points.
   Derive the checklist ONLY from the requirement text (plus goals the
   assistant's summary explicitly claims were completed).
2. Coverage check: go through EVERY checklist point. For each point state what
   you inspected and whether the changes shown actually implement it (name the
   file/hunk when they do), or that it is missing / half-done / unverifiable.
   Never skip a point and never collapse them into a vague summary.
3. Correctness check: what you examined for bugs, broken references, logic
   flaws, and edge cases the requirement clearly implies, and what you found.
4. Consistency check: state whether each claim in the assistant's summary is
   supported by the diff, naming any unsupported claim.
5. Conclusion: a short overall judgment (1-3 sentences).

Part 2 - the machine-readable verdict. Begin with the line:
=== VERDICT ===
Then output ONE strict JSON object (no markdown fences, no commentary):
{"ok": boolean, "issues": [{"title": string, "detail": string, "suggestion": string}]}

- ok: true when the result needs no changes (issues MUST then be empty).
- issues: empty when ok. Otherwise 1-6 issues, each concrete and self-contained:
  title: a one-line summary of the problem.
  detail: why it is a problem (1-2 sentences), naming the file or change.
  suggestion: the concrete fix you propose.`;

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
    'in EXACTLY two parts: first the === REVIEW REPORT === analysis, then the',
    '=== VERDICT === JSON object.',
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

/**
 * Build the user-turn content for the MANUAL `/review code` command. Mirrors
 * buildCodeReviewContent's delimiting style, but frames the material as an
 * already-completed task whose result must be regression-checked against the
 * ORIGINAL USER REQUIREMENT (not a plan). Used together with
 * MANUAL_REVIEW_SYSTEM_PROMPT. The diff section is omitted entirely when no
 * working-tree changes were detected, so the reviewer reviews the claimed
 * result text only.
 *
 * @param {{requestText?: string, changedFiles?: string[], diffText?: string, answerText?: string}} [input]
 * @returns {string}
 */
export function buildManualCodeReviewContent({ requestText = '', changedFiles = [], diffText = '', answerText = '' } = {}) {
  const sections = [
    'You are performing an independent REGRESSION CHECK on a completed task.',
    'The task requirement below is claimed to be fully completed. Perform a',
    'careful, deep, and comprehensive regression check on the work and its',
    'result to make sure the functionality is correct and nothing is missing.',
    'Reply in EXACTLY two parts: first the === REVIEW REPORT === analysis, then',
    'the === VERDICT === JSON object.',
    '',
  ];

  if (requestText && requestText.trim()) {
    sections.push('=== ORIGINAL USER REQUIREMENT (begin) ===');
    sections.push(requestText.trim());
    sections.push('=== ORIGINAL USER REQUIREMENT (end) ===');
    sections.push('');
  }

  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    sections.push('=== CHANGED FILES (begin) ===');
    sections.push(changedFiles.join('\n'));
    sections.push('=== CHANGED FILES (end) ===');
    sections.push('');
  }

  if (diffText && diffText.trim()) {
    sections.push('=== DIFF (the actual changes) (begin) ===');
    let body = diffText.trim();
    if (body.length > MAX_DIFF_CHARS) {
      body = body.slice(0, MAX_DIFF_CHARS)
        + `\n... (diff truncated to ${MAX_DIFF_CHARS} chars) ...`;
    }
    sections.push(body);
    sections.push('=== DIFF (end) ===');
    sections.push('');
  } else {
    sections.push('(no working-tree diff was detected — regression-check the requirement and the claimed result only)');
    sections.push('');
  }

  if (answerText && answerText.trim()) {
    sections.push('=== ASSISTANT CLAIMED RESULT (begin) ===');
    sections.push(answerText.trim());
    sections.push('=== ASSISTANT CLAIMED RESULT (end) ===');
  }

  return sections.join('\n');
}

/** Delimiters of the two-part review reply (see the system prompts). */
export const REPORT_MARKER = '=== REVIEW REPORT ===';
export const VERDICT_MARKER = '=== VERDICT ===';

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

/** Strip one surrounding markdown code fence, if present. */
function stripFences(s) {
  const t = s.trim();
  const m = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(t);
  return m ? m[1] : t;
}

/** Parse the verdict JSON out of a text slice; null when unparseable.
 *  Shared by code review and plan review (same two-part reply contract). */
export function parseVerdict(text) {
  if (!text) return null;
  const t = stripFences(text);
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

/**
 * Split a review reply into its report part and its verdict part using the
 * two markers. A reply without the VERDICT marker (legacy pure-JSON replies)
 * yields report:'' and the whole text as the verdict candidate.
 */
export function splitReviewReply(raw) {
  const vIdx = raw.indexOf(VERDICT_MARKER);
  if (vIdx === -1) return { report: '', verdictRaw: raw };
  let report = raw.slice(0, vIdx);
  const rIdx = report.indexOf(REPORT_MARKER);
  if (rIdx !== -1) report = report.slice(rIdx + REPORT_MARKER.length);
  return { report: report.trim(), verdictRaw: raw.slice(vIdx + VERDICT_MARKER.length) };
}

/**
 * Wrap an onDelta sink so the human sees the REVIEW REPORT as it streams but
 * NEVER the machine-readable verdict JSON that follows the VERDICT marker.
 *
 * - A leading REPORT marker line is swallowed (callers print their own header).
 * - Everything up to the VERDICT marker passes through untouched.
 * - A tail that could still be a partial VERDICT marker (the marker may be
 *   split across deltas) is held back until it diverges or completes.
 * - Once the marker completes, all further deltas are dropped.
 *
 * @param {(text: string) => void} onDelta
 * @returns {(text: string) => void}
 */
export function createVerdictFilter(onDelta) {
  const V = VERDICT_MARKER;
  const R = REPORT_MARKER;
  let pending = '';
  let started = false;
  let verdictSeen = false;
  return (text) => {
    if (verdictSeen || !text) return;
    pending += text;
    if (!started) {
      // Still possibly a prefix of the REPORT marker: wait for more deltas.
      if (R.startsWith(pending) && pending.length < R.length) return;
      if (pending.startsWith(R)) {
        pending = pending.slice(R.length).replace(/^\r?\n/, '');
      }
      started = true;
    }
    const idx = pending.indexOf(V);
    if (idx !== -1) {
      const out = pending.slice(0, idx);
      if (out) onDelta(out);
      verdictSeen = true;
      pending = '';
      return;
    }
    let hold = 0;
    for (let k = Math.min(V.length - 1, pending.length); k > 0; k--) {
      if (V.startsWith(pending.slice(pending.length - k))) { hold = k; break; }
    }
    const out = pending.slice(0, pending.length - hold);
    if (out) onDelta(out);
    pending = pending.slice(pending.length - hold);
  };
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
 * @param {{signal?: AbortSignal, timeoutMs?: number, systemPrompt?: string, onDelta?: (text: string) => void}} [opts]
 *        systemPrompt overrides SYSTEM_PROMPT (used by the manual /review code
 *        command, which reviews with fresh-eyes regression-check instructions).
 *        onDelta receives every raw body delta (createVerdictFilter wraps it to
 *        hide the verdict JSON).
 * @returns {Promise<{ok: boolean, issues: Array<{title:string, detail:string, suggestion:string}>, report?: string, parseError?: string}>}
 */
export async function reviewCode(llm, reviewText, opts = {}) {
  if (!reviewText || !reviewText.trim()) return ok();
  try {
    const messages = [
      { role: 'system', content: opts.systemPrompt || SYSTEM_PROMPT },
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
        // partial JSON string to parseVerdict, which fails, and the fallback
        // would then report parseError - the worst outcome for a review step.
        // Leaving it unset lets the adapter use the model's own configured
        // context window / provider default.
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
      // verdict. Surface it via parseError; keep ok:true so the automatic
      // end-of-turn path does not block on it.
      const bestReport = report && report.trim() ? report : (raw || '').trim();
      return { ...ok(), report: bestReport, parseError: 'the review reply contained no JSON verdict' };
    }
    // Treat missing/true/null as ok; only an explicit false means issues.
    if (parsed.ok !== false) return { ...ok(), report };
    const issues = coerceIssues(parsed.issues);
    if (issues.length === 0) {
      // The model said not-ok but produced no usable issues - treat as ok to
      // avoid a dead-end message with nothing for the user to read.
      return { ...ok(), report };
    }
    return { ok: false, issues, report };
  } catch (err) {
    // Transport-level failure (connection refused / timeout / HTTP error):
    // still degrade to { ok: true } so the turn ends normally, but surface
    // the reason via `error` so the caller can warn + skip the phase (see
    // src/phase_fallback.js).
    return { ...ok(), error: err?.message || String(err) };
  }
}

export default reviewCode;
