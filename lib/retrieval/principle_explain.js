/**
 * Principle explanation: principle topic match → collect symbols → build prompt → LLM streaming.
 *
 * Output (async generator) — SSE-style events:
 *   { type: 'topic', topics: [{topic, title}] }
 *   { type: 'symbol', symbols: [{id, name, kind, fileId, filePath, lineStart, signature}] }
 *   { type: 'delta', text }
 *   { type: 'reasoning', text }
 *   { type: 'done' }
 */

import { tokenizeText } from '../index/text_tokenizer.js';
import { matchPrinciples, buildContext } from './context_builder.js';
import { rewriteQuery } from './rewrite_query.js';

/**
 * @param {import('./kb_runtime.js').KBRuntime} rt
 * @param {import('../llm/client.js').LLMClient} llm
 * @param {string} query
 * @param {{maxChars?: number, topK?: number, signal?: AbortSignal, skipRewrite?: boolean}} [opts]
 */
export async function* explainPrinciple(rt, llm, query, opts = {}) {
  const maxChars = opts.maxChars ?? 65536;
  const topK = opts.topK ?? 12;
  const knowledge = rt.allKnowledge?.() || [];
  const filePathResolver = (fid) => rt.getFilePath(fid) || `fileId:${fid}`;

  // 0. LLM 改写：用英文function名 + 关键词走检索，原 query 仍用于 LLM user 消息
  //    skipRewrite=true hourskip LLM call，直接用原 query 走检索
  const rewrite = opts.skipRewrite
    ? { fallback: true, rewrittenQuery: query, originalQuery: query, intent: '', functionNames: [], keywords: [] }
    : await rewriteQuery(llm, query, { signal: opts.signal });
  const retrievalQuery = rewrite.fallback ? query : rewrite.rewrittenQuery;
  yield {
    type: 'rewrite',
    intent: rewrite.intent,
    functionNames: rewrite.functionNames,
    keywords: rewrite.keywords,
    rewrittenQuery: rewrite.rewrittenQuery,
    originalQuery: rewrite.originalQuery,
    fallback: rewrite.fallback,
  };

  // 1. 主题match
  const matched = matchPrinciples(knowledge, retrievalQuery);
  const topics = matched.map(m => ({ topic: m.principle.topic, title: m.principle.title }));
  yield { type: 'topic', topics };

  // 2. symbol收集
  const queryTokens = tokenizeText(retrievalQuery);
  const restrictFileIds = new Set();
  const topicKeySymbols = new Set();
  for (const m of matched) {
    for (const fp of (m.principle.keyFiles || [])) {
      const fid = rt.getFileId(fp);
      if (fid !== null) restrictFileIds.add(fid);
    }
    for (const name of (m.principle.keySymbols || [])) {
      topicKeySymbols.add(name);
    }
  }

  // 2a. topic.keySymbols（按名字parse）
  const symbols = new Map();   // id → sym
  for (const name of topicKeySymbols) {
    for (const sym of rt.getSymbolsByName(name)) {
      symbols.set(sym.id, sym);
    }
  }

  // 2b. BM25 在 keyFiles 限定范围内query
  if (queryTokens.length > 0 && restrictFileIds.size > 0) {
    // 把 restrictTo 转成 symbolId set
    const restrictToIds = new Set();
    for (const fid of restrictFileIds) {
      const syms = rt.getSymbolsInFile(fid);
      for (const s of syms) restrictToIds.add(s.id);
    }
    const bmResults = rt.bm.query(queryTokens, { topK, restrictTo: restrictToIds });
    for (const r of bmResults) {
      const sym = rt.getSymbolById(r.symbolId);
      if (sym) symbols.set(sym.id, sym);
    }
  }

  // 2c. 如果还是不够（如 topic 没match上），退化到全 KB BM25
  if (symbols.size < 5 && queryTokens.length > 0) {
    const bmResults = rt.bm.query(queryTokens, { topK });
    for (const r of bmResults) {
      const sym = rt.getSymbolById(r.symbolId);
      if (sym) symbols.set(sym.id, sym);
    }
  }

  // sort：先按 name match query tokens，再按 BM25 score（这里简化）
  const sortedSymbols = Array.from(symbols.values());
  yield {
    type: 'symbol',
    symbols: sortedSymbols.map(s => ({
      id: s.id, name: s.name, kind: s.kind,
      fileId: s.fileId, filePath: filePathResolver(s.fileId),
      lineStart: s.lineStart, signature: s.signature,
    })),
  };

  // 3. 构造 prompt
  const topic = matched[0]?.principle || null;
  const ctx = buildContext({
    topic: topic ? { title: topic.title, intro: topic.intro } : null,
    symbols: sortedSymbols,
    query, maxChars, mode: 'principle',
    filePathResolver,
  });

  // 4. LLM streaming
  const messages = [
    { role: 'system', content: ctx.system },
    { role: 'user', content: `### user问题\n${query}\n\n${ctx.user}` },
  ];
  for await (const evt of llm.stream(messages, { maxChars, signal: opts.signal })) {
    yield evt;
  }
}

export default explainPrinciple;
