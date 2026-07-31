/**
 * principle / impl mode: explain or implementation suggestion, streaming.
 *
 * Defaults: only LLM delta events are printed; --verbose also prints
 * [matched topics] / [referenced symbols]. rewrite / reasoning events
 * are not printed.
 *
 * principle mode checks saved answers first (force skips).
 *
 * once mode: internal getRuntime + new LLMClient
 * serve mode: caller passes rt / llm
 */
import { resolveDefaultModel } from '../../lib/config/home.js';
import { printTopics, printSymbols, printCachedAnswer } from '../format.js';
import { ProgressIndicator } from '../progress.js';
import { resolveKbName } from '../kb_name.js';

export async function explain(query, { mode, enableRewrite, force, verbose, rt: providedRt, llm: providedLlm }) {
  const { explainPrinciple } = await import('../../lib/retrieval/principle_explain.js');
  const { suggestImplementation } = await import('../../lib/retrieval/implementation_suggest.js');
  const { rewriteQuery } = await import('../../lib/retrieval/rewrite_query.js');

  const cfg = await resolveDefaultModel();
  const kbName = await resolveKbName();
  const rt = providedRt || await (await import('../../lib/retrieval/kb_runtime.js')).getRuntime(kbName);
  const llm = providedLlm || (cfg ? new (await import('../../lib/llm/client.js')).LLMClient(cfg) : null);
  if (!llm) throw new Error('No default model configured. Use /model add + /model set-default, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.');

  // principle mode: check saved answers first (unless --force)
  if (mode === 'principle' && !force) {
    let rewriteInfo = null;
    if (enableRewrite) {
      const r = await rewriteQuery(llm, query);
      if (!r.fallback && (r.functionNames?.length || r.keywords?.length)) {
        rewriteInfo = { functionNames: r.functionNames, keywords: r.keywords };
      }
    }
    const { matchSavedAnswer } = await import('../../lib/store/saved_answer_store.js');
    const m = await matchSavedAnswer(kbName, query, {
      mode: 'principle',
      functionNames: rewriteInfo?.functionNames,
      keywords: rewriteInfo?.keywords,
    });
    if (m) {
      printCachedAnswer(m);
      return { cached: true };
    }
  }

  const acc = { rewrite: null, topics: [], symbols: [], text: '' };
  const gen = mode === 'principle'
    ? explainPrinciple(rt, llm, query, { maxChars: cfg.maxChars, skipRewrite: !enableRewrite })
    : suggestImplementation(rt, llm, query, { maxChars: cfg.maxChars, skipRewrite: !enableRewrite });

  const progress = new ProgressIndicator();
  progress.start(enableRewrite ? 'rewriting query' : 'waiting for model');

  for await (const evt of gen) {
    if (evt.type === 'rewrite') {
      acc.rewrite = {
        intent: evt.intent,
        functionNames: evt.functionNames,
        keywords: evt.keywords,
        rewrittenQuery: evt.rewrittenQuery,
        originalQuery: evt.originalQuery,
        fallback: evt.fallback,
      };
      progress.nextPhase('retrieving');
      continue;
    }
    if (evt.type === 'reasoning') continue;
    if (evt.type === 'topic') {
      acc.topics = evt.topics || [];
      if (verbose) printTopics(evt.topics);
    }
    if (evt.type === 'symbol') {
      acc.symbols = evt.symbols || [];
      if (verbose) printSymbols(evt.symbols);
    }
    if (evt.type === 'delta') {
      progress.tick(evt.text);
      process.stdout.write(evt.text || '');
      acc.text += evt.text || '';
    }
  }
  process.stdout.write('\n');
  progress.done();

  return {
    cached: false,
    query,
    rewrite: acc.rewrite,
    topics: acc.topics,
    symbols: acc.symbols,
    answer: acc.text,
  };
}
