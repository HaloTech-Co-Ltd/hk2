/**
 * Query rewrite: use the LLM to convert a natural-language query into a
 * form that retrieves better from BM25 (English identifiers + keywords).
 *
 * Input: user query (any language).
 * Output: { intent, functionNames[], keywords[], rewrittenQuery, originalQuery, fallback }
 *
 * Any failure (LLM exception, JSON parse, empty output) silently returns
 * a fallback object so the caller can fall back to BM25 on the raw query.
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
 * Use stream rather than complete: lets us pass enableReasoning:false to
 * skip the reasoning-content overhead on small/fast queries.
 */
async function callLlm(llm, messages, opts) {
  let out = '';
  for await (const evt of llm.stream(messages, opts)) {
    if (evt.type === 'delta') out += evt.text;
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
 * @param {import('../llm/client.js').LLMClient} llm
 * @param {string} query  Trimmed user query
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function rewriteQuery(llm, query, opts = {}) {
  if (!query || !query.trim()) return fallback(query);

  try {
    const raw = await callLlm(
      llm,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      {
        temperature: 0.1,
        maxChars: 2048,
        enableReasoning: false,
        timeoutMs: 15000,
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
  } catch {
    return fallback(query);
  }
}

export default rewriteQuery;
