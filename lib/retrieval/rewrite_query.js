/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新、技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software or
 * in dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in dangerous
 * applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Query rewrite: use the LLM to convert a natural-language query into a
 * form that retrieves better from BM25 (English identifiers + keywords).
 *
 * Input: user query (any language).
 * Output: { intent, functionNames[], keywords[], rewrittenQuery, originalQuery, fallback }
 *
 * Any failure (LLM exception, JSON parse, empty output) returns a fallback
 * object so the caller can fall back to BM25 on the raw query. Transport
 * failures (connection refused, timeout, HTTP error) additionally set
 * `error` on the returned object so callers can tell "model unreachable"
 * apart from "model answered garbage" and react (warn + fallback to the
 * session model, or skip the phase — see src/phase_fallback.js).
 */

const SYSTEM_PROMPT = `You are a source-code search query rewriter.

The user is searching the KB of a software project. They will type a query in
natural language (any language, often mixed with English identifiers). Your
job is to:

1. Identify the user intent in one short sentence.
2. Suggest the most likely identifier names (functionNames) the user is
   looking for, using the project's naming conventions. At most 5. If you
   are not sure, return an empty array.
3. Extract keywords (English technical terms) that BM25 can match. At most 8.

Only output strict JSON. No markdown fences, no explanation:
{"intent": string, "functionNames": string[], "keywords": string[]}`;

/**
 * Request clarity assessment: before rewriting, ask the LLM whether the
 * user's request is clear enough to search the KB effectively. If not, the
 * LLM returns the unclear aspects plus a few candidate interpretations the
 * user can pick from.
 *
 * Output: { clear: boolean, unclear: string[], interpretations: string[] }
 * Any failure returns { clear: true } so the caller proceeds with
 * the normal rewrite path; transport failures additionally set `error` on
 * the returned object so callers can detect an unreachable model (see
 * src/phase_fallback.js) instead of treating the phase as successful.
 */
const ASSESS_PROMPT = `You are assessing a user's request to a coding assistant.

Decide whether the request is clear enough to act on. A request is clear if it
states both WHAT the user wants and enough context to disambiguate it. A request
is unclear if it is vague, ambiguous, missing a target, or could mean several
materially different things.

You MAY be given retrieved knowledge-base context (matching symbols, knowledge
entries, call chains) for this request, after the request itself. Use that
context to judge whether the project already disambiguates the request: if the
retrieved symbols/knowledge point to a single coherent target, the request is
likely clear even if phrased tersely; if the context is scattered or empty, the
request is more likely unclear.

You MAY also be given the current session context: the in-flight task (the
user's earlier request this task belongs to), the active plan progress, and the
most recent conversation turns. Use it to resolve follow-up requests that are
ambiguous in isolation but unambiguous given the conversation — e.g. "continue",
"fix it", "use the second option", "and the same for the parser" are CLEAR when
the session context shows exactly what "it" refers to. Only mark such a request
unclear when the session context does not actually pin down the reference. When
the session context identifies the task but the current request still adds a
materially new, unresolvable choice (a different target, a conflicting goal),
the request remains unclear.

Return strict JSON only, no markdown fences, no prose:
{"clear": boolean, "unclear": string[], "interpretations": string[]}

- clear: true when the request is actionable as-is.
- unclear: short list (1-4) of the specific aspects that are ambiguous or
  missing. Empty when clear.
- interpretations: 1-4 plausible distinct readings of the request, each a
  short phrase. Empty when clear. These are presented to the user as a
  numbered menu, so make each one concrete and self-contained.`;

/**
 * Use stream rather than complete: lets us pass enableReasoning:false to
 * skip the reasoning-content overhead on small/fast queries.
 */
async function callLlm(llm, messages, opts) {
  let out = '';
  for await (const evt of llm.stream(messages, opts)) {
    if (evt.type === 'delta') out += evt.text;
    else if (evt.type === 'retry') {
      // Transient failure — the client restarts the call from scratch, so the
      // failed attempt's partial text is void (see lib/llm/retries.js).
      out = '';
    }
  }
  return out;
}

function fallback(query, intent = '') {
  return {
    intent,
    functionNames: [],
    keywords: [],
    rewrittenQuery: query,
    originalQuery: query,
    fallback: true,
  };
}

function coerceStringArray(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
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

/**
 * Assess whether a user request is clear. Returns { clear, unclear[],
 * interpretations[] }. On any error returns { clear: true } so callers fall
 * through to the normal rewrite path.
 *
 * @param {import('../llm/client.js').LLMClient} llm
 * @param {string} query  Trimmed user query
 * @param {{signal?: AbortSignal, timeoutMs?: number, context?: string, sessionContext?: string}} [opts]
 *        opts.context - a short KB-context digest (retrieved symbols /
 *        knowledge summary) gathered by the caller AFTER an initial
 *        rewrite+retrieve pass. When present it is appended as an extra
 *        user message so the LLM can judge clarity with project grounding
 *        instead of on the raw request alone.
 *        opts.sessionContext - a short digest of the current session's task
 *        context (in-flight task request, active plan progress, recent
 *        conversation turns) built by the caller. When present it is appended
 *        as an extra user message so follow-ups that are ambiguous in
 *        isolation ("continue", "fix it", ...) can be judged clear when the
 *        conversation already pins down what they refer to.
 */
export async function assessRequest(llm, query, opts = {}) {
  if (!query || !query.trim()) return { clear: true, unclear: [], interpretations: [] };
  try {
    const messages = [
      { role: 'system', content: ASSESS_PROMPT },
      { role: 'user', content: query },
    ];
    if (opts.sessionContext && opts.sessionContext.trim()) {
      messages.push({
        role: 'user',
        content: `Current session context (earlier task and conversation this request may refer to):\n${opts.sessionContext.trim()}`,
      });
    }
    if (opts.context && opts.context.trim()) {
      messages.push({
        role: 'user',
        content: `Retrieved knowledge-base context for this request:\n${opts.context.trim()}`,
      });
    }
    const raw = await callLlm(
      llm,
      messages,
      {
        temperature: 0.1,
        maxChars: 2048,
        enableReasoning: false,
        timeoutMs: opts.timeoutMs ?? 15000,
        signal: opts.signal,
      }
    );
    const parsed = extractJsonObject(raw);
    if (!parsed) return { clear: true, unclear: [], interpretations: [] };
    const clear = parsed.clear !== false; // treat missing/true/null as clear
    if (clear) return { clear: true, unclear: [], interpretations: [] };
    const unclear = coerceStringArray(parsed.unclear);
    const interpretations = coerceStringArray(parsed.interpretations);
    if (interpretations.length === 0) {
      // Nothing to offer the user; treat as clear to avoid a dead-end prompt.
      return { clear: true, unclear: [], interpretations: [] };
    }
    return { clear: false, unclear, interpretations };
  } catch (err) {
    // Transport-level failure (connection refused / timeout / HTTP error):
    // still degrade to { clear: true } so the turn proceeds, but surface the
    // reason via `error` so the caller can warn + apply phase-model fallback.
    return { clear: true, unclear: [], interpretations: [], error: err?.message || String(err) };
  }
}

/**
 * @param {import('../llm/client.js').LLMClient} llm
 * @param {string} query  Trimmed user query
 * @param {{signal?: AbortSignal, timeoutMs?: number, clarification?: string}} [opts]
 *        opts.clarification - a user-confirmed interpretation to steer the
 *        rewrite; appended as an extra user message when present.
 */
export async function rewriteQuery(llm, query, opts = {}) {
  if (!query || !query.trim()) return fallback(query);

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: query },
    ];
    if (opts.clarification && opts.clarification.trim()) {
      messages.push({
        role: 'user',
        content: `Clarification from the user (use this to disambiguate the request): ${opts.clarification.trim()}`,
      });
    }

    const raw = await callLlm(
      llm,
      messages,
      {
        temperature: 0.1,
        maxChars: 2048,
        enableReasoning: false,
        timeoutMs: opts.timeoutMs ?? 15000,
        signal: opts.signal,
      }
    );

    const parsed = extractJsonObject(raw);
    if (!parsed) return fallback(query);

    const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
    const functionNames = coerceStringArray(parsed.functionNames);
    const keywords = coerceStringArray(parsed.keywords);

    const rewrittenQuery = [...functionNames, ...keywords].join(' ').trim();
    if (!rewrittenQuery) return fallback(query, intent);

    return {
      intent,
      functionNames,
      keywords,
      rewrittenQuery,
      originalQuery: query,
      fallback: false,
    };
  } catch (err) {
    // Transport-level failure (connection refused / timeout / HTTP error):
    // still degrade to the fallback object so retrieval can use the raw
    // query, but surface the reason via `error` so the caller can warn +
    // apply phase-model fallback (see src/phase_fallback.js).
    return { ...fallback(query), error: err?.message || String(err) };
  }
}

export default rewriteQuery;
