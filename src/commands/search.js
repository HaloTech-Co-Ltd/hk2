/**
 * code mode: BM25 code search.
 *
 * No rewrite: codeSearch directly on the raw query.
 * With rewrite: rewriteQuery first, then codeSearch on the rewritten query.
 *
 * once mode: internal getRuntime + new LLMClient
 * serve mode: caller passes already-loaded rt / llm
 */
import { resolveDefaultModel } from '../../lib/config/home.js';
import { printCodeResults } from '../format.js';
import { resolveKbName } from '../kb_name.js';

export async function searchCode(query, { enableRewrite, rt: providedRt, llm: providedLlm } = {}) {
  const { codeSearch } = await import('../../lib/retrieval/code_search.js');
  const kbName = await resolveKbName();
  const rt = providedRt || await (await import('../../lib/retrieval/kb_runtime.js')).getRuntime(kbName);

  let effective = query;
  if (enableRewrite) {
    const { rewriteQuery } = await import('../../lib/retrieval/rewrite_query.js');
    const cfg = providedLlm ? null : await resolveDefaultModel();
    const llm = providedLlm || new (await import('../../lib/llm/client.js')).LLMClient(cfg);
    const r = await rewriteQuery(llm, query);
    if (!r.fallback && r.rewrittenQuery?.trim()) {
      effective = r.rewrittenQuery;
    }
  }

  const results = codeSearch(rt, effective, { topK: 30 });
  printCodeResults(results);
}
