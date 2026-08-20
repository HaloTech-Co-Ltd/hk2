/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 *-------------------------------------------------------------------------*/

/**
 * KB Learn Validation: before a newly-learned knowledge entry is written at
 * the end of a task, validate it against the entries that already exist in
 * the project KB. Three questions must be answered:
 *
 *   1. Is there ALREADY an entry with the same or essentially the same
 *      meaning?  → duplicate: skip the write entirely (no re-learning).
 *   2. Is there a RELATED entry that this new knowledge should UPDATE in
 *      place (same topic, fresher/complete content)?  → update: rewrite
 *      that entry instead of creating a near-identical sibling.
 *   3. Does the new knowledge CONFLICT with an existing entry (contradictory
 *      statements)?  → conflict: for Eden-vs-Eden the LLM picks a winner and
 *      explains why; for Holy the USER must decide (Holy always needs human
 *      approval). If the new entry is not written onto the existing one, the
 *      reason must be stated.
 *
 * Architecture (mirrors lib/agent/plan_review.js):
 *   - findCandidateEntries(): deterministic pre-filter (id hit, title mutual
 *     containment, keyword overlap > 0.6 — the same heuristics as
 *     crossCheckEntries in src/slash/kb.js and findHolyConflict in
 *     lib/agent/graph.js). Cheap, pure, unit-testable.
 *   - validateLearnedEntry(): one streaming LLM call that receives the new
 *     entry plus the (short) candidates and returns a verdict object. Any
 *     failure degrades to { verdict: 'new' } so the flow falls through to the
 *     normal per-space confirmation path — validation is best-effort and
 *     never blocks learning.
 *
 * Verdict schema (strict JSON):
 * {
 *   "verdict": "duplicate" | "update" | "conflict" | "new",
 *   "targetId": "id of the existing entry to update / that duplicates / that conflicts",
 *   "reason": "one or two sentences explaining the decision",
 *   "conflictWinner": "new" | "existing" | null,        // verdict=conflict only
 *   "mergedIntro": "merged intro text"                   // verdict=update only
 * }
 */

const SYSTEM_PROMPT = `You are validating a newly-learned knowledge entry against an existing project knowledge base before it is written.

The KB has two spaces: "holy" (stable design knowledge, rarely changes) and "eden" (frequently-updated knowledge). The candidate entries below were pre-filtered by cheap heuristics (id/title/keyword overlap) — your job is the SEMANTIC decision the heuristics cannot make.

Decide ONE verdict:
- "duplicate": an existing entry already says the same thing (same or essentially the same meaning). Writing the new entry again would be redundant re-learning. Set targetId to that entry.
- "update": an existing entry covers the SAME topic but is incomplete, stale, or would be improved by merging this new knowledge. The new entry should be written ONTO that entry (merged), not beside it. Set targetId and provide mergedIntro: the full merged intro (keep the existing entry's still-valid content, fold in the new knowledge, keep it concise). If the new entry is about a genuinely different aspect of the topic that the existing entry deliberately does not cover, that is "new", not "update".
- "conflict": the new entry directly CONTRADICTS an existing entry (same subject, incompatible statements — not merely a different aspect). Set targetId and conflictWinner ("new" or "existing") with a reason justifying which content is correct. Prefer "new" only when the task just observed fresh ground truth; prefer "existing" when the new extraction looks like a hallucination or oversimplification.
- "new": none of the above — a distinct piece of knowledge. targetId stays null.

Be conservative with "duplicate" and "update": wrongly skipping or merging distinct knowledge loses information. When unsure, answer "new" and explain why in reason.

Only output strict JSON, no markdown fences, no prose:
{"verdict":"duplicate|update|conflict|new","targetId":string|null,"reason":string,"conflictWinner":"new|existing"|null,"mergedIntro":string|null}`;

/** Normalize a title: lowercase + collapse whitespace. */
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Lowercased keyword set of an entry. */
function kwSet(entry) {
  return new Set((entry.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean));
}

/**
 * Deterministic candidate pre-filter. Returns entries from `holy` and `eden`
 * that are plausibly related to the proposed entry:
 *   - id hit                     → relatedness 1.0 (definite)
 *   - title mutual containment  → relatedness 0.9
 *   - keyword overlap > 0.6      → relatedness = the overlap ratio
 * (Same thresholds as crossCheckEntries / findHolyConflict so behavior is
 * consistent across the codebase.)
 *
 * @returns {Array<{entry, space, relatedness}>} sorted by relatedness desc
 */
export function findCandidateEntries(proposed, holy, eden) {
  const pTitle = normTitle(proposed.title);
  const pKws = kwSet(proposed);
  const out = [];
  for (const space of ['holy', 'eden']) {
    for (const e of space === 'holy' ? holy || [] : eden || []) {
      if (!e) continue;
      let rel = 0;
      if (e.id && proposed.id && e.id === proposed.id) rel = 1;
      if (rel === 0 && pTitle && normTitle(e.title)) {
        const a = normTitle(e.title);
        if (pTitle.includes(a) || a.includes(pTitle)) rel = 0.9;
      }
      if (rel === 0 && pKws.size > 0) {
        const eKws = kwSet(e);
        if (eKws.size > 0) {
          let ov = 0;
          for (const k of pKws) if (eKws.has(k)) ov++;
          const ratio = ov / Math.min(pKws.size, eKws.size);
          if (ratio > 0.6) rel = ratio;
        }
      }
      if (rel > 0) out.push({ entry: e, space, relatedness: rel });
    }
  }
  out.sort((a, b) => b.relatedness - a.relatedness);
  return out;
}

/** Extract the first JSON object from raw LLM output (fences tolerated). */
function extractJsonObject(raw) {
  const s = String(raw || '');
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

/** Fallback verdict: treat as brand-new knowledge (normal learn path). */
export function fallbackVerdict(reason) {
  return { verdict: 'new', targetId: null, reason: reason || 'validation unavailable', conflictWinner: null, mergedIntro: null, fallback: true };
}

/**
 * Coerce a raw parsed object into a well-formed verdict. Drops unknown
 * verdicts / mismatched field combinations to 'new' so the caller never
 * acts on a half-formed decision.
 */
export function coerceVerdict(v, candidates) {
  if (!v || typeof v !== 'object') return fallbackVerdict('unparseable verdict');
  const verdicts = ['duplicate', 'update', 'conflict', 'new'];
  let verdict = verdicts.includes(v.verdict) ? v.verdict : 'new';
  const ids = new Set((candidates || []).map(c => c.entry.id));
  let targetId = typeof v.targetId === 'string' && v.targetId ? v.targetId : null;
  // targetId must reference one of the pre-filtered candidates — a hallucinated
  // id cannot be updated/duplicated/conflicted with.
  if (verdict !== 'new' && (!targetId || !ids.has(targetId))) {
    verdict = 'new';
    targetId = null;
  }
  const reason = typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim() : '';
  let conflictWinner = v.conflictWinner === 'new' || v.conflictWinner === 'existing' ? v.conflictWinner : null;
  if (verdict === 'conflict' && !conflictWinner) conflictWinner = 'existing'; // conservative default
  let mergedIntro = typeof v.mergedIntro === 'string' && v.mergedIntro.trim() ? v.mergedIntro.trim() : null;
  if (verdict === 'update' && !mergedIntro) {
    // An update without merged content cannot be applied — degrade to new.
    verdict = 'new';
    targetId = null;
  }
  if (verdict !== 'conflict') conflictWinner = null;
  if (verdict !== 'update') mergedIntro = null;
  return { verdict, targetId, reason, conflictWinner, mergedIntro };
}

/**
 * Validate a proposed entry against existing KB content.
 *
 * @param {object} llm streaming LLM client ({ stream(messages, opts) })
 * @param {object} proposed the new entry ({ id, title, intro, keywords })
 * @param {object[]} candidates output of findCandidateEntries()
 * @param {object} opts { timeoutMs }
 * @returns {Promise<{verdict,targetId,reason,conflictWinner,mergedIntro}>}
 *   Always resolves; on any failure returns { verdict:'new' } (fallback) so
 *   the normal per-space confirmation path still runs.
 */
export async function validateLearnedEntry(llm, proposed, candidates, opts = {}) {
  if (!candidates || candidates.length === 0) {
    // Nothing related exists — the entry is genuinely new; no LLM call needed.
    return { verdict: 'new', targetId: null, reason: 'no related entry exists in the KB', conflictWinner: null, mergedIntro: null };
  }
  if (!llm) return fallbackVerdict('no LLM available for validation');
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 60000;
  const candText = candidates.slice(0, 5).map(c =>
    `## ${c.space}:${c.entry.id} — ${c.entry.title || ''} (relatedness ${c.relatedness.toFixed(2)})\n` +
    `keywords: ${(c.entry.keywords || []).join(', ') || '(none)'}\n` +
    `intro:\n${String(c.entry.intro || '').slice(0, 1200)}`
  ).join('\n\n');
  const userPrompt = `Proposed new entry (extracted from a just-finished task):
id: ${proposed.id}
title: ${proposed.title}
keywords: ${(proposed.keywords || []).join(', ') || '(none)'}
intro:
${String(proposed.intro || '').slice(0, 2000)}

Existing candidate entries (pre-filtered, most related first):
${candText}

Reply with ONLY the JSON verdict object.`;
  let raw = '';
  try {
    for await (const evt of llm.stream(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.1, maxChars: 8192, enableReasoning: false, timeoutMs },
    )) {
      if (evt.type === 'delta') raw += evt.text;
    }
  } catch {
    return fallbackVerdict('validation LLM call failed');
  }
  const parsed = extractJsonObject(raw);
  if (!parsed) return fallbackVerdict('validation output unparseable');
  return coerceVerdict(parsed, candidates);
}
