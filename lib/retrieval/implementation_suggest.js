/**
 * 实现建议：原理主题match → 模板symbol + class似案例 → LLM streaming回答。
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
export async function* suggestImplementation(rt, llm, query, opts = {}) {
  const maxChars = opts.maxChars ?? 65536;
  const topK = opts.topK ?? 8;
  const knowledge = rt.allKnowledge?.() || [];
  const filePathResolver = (fid) => rt.getFilePath(fid) || `fileId:${fid}`;

  // 0. LLM 改写：skipRewrite=true hourskip LLM call，直接用原 query 走检索
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

  // 2. 收集 template symbols
  const templates = new Map();   // id → sym
  for (const m of matched) {
    for (const name of (m.principle.templateSymbols || [])) {
      for (const sym of rt.getSymbolsByName(name)) templates.set(sym.id, sym);
    }
    // 也加上 keySymbols 作为补充
    for (const name of (m.principle.keySymbols || []).slice(0, 3)) {
      for (const sym of rt.getSymbolsByName(name)) templates.set(sym.id, sym);
    }
  }

  // 3. class似实现案例（BM25 全 KB）
  const queryTokens = tokenizeText(retrievalQuery);
  const analogous = new Map();
  if (queryTokens.length > 0) {
    const bmResults = rt.bm.query(queryTokens, { topK });
    for (const r of bmResults) {
      const sym = rt.getSymbolById(r.symbolId);
      if (sym && !templates.has(sym.id)) analogous.set(sym.id, sym);
    }
  }
  // 在 topic.keyFiles 范围内再找一次（更精准）
  const restrictFileIds = new Set();
  for (const m of matched) {
    for (const fp of (m.principle.keyFiles || [])) {
      const fid = rt.getFileId(fp);
      if (fid !== null) restrictFileIds.add(fid);
    }
  }
  if (queryTokens.length > 0 && restrictFileIds.size > 0) {
    const restrictToIds = new Set();
    for (const fid of restrictFileIds) {
      for (const s of rt.getSymbolsInFile(fid)) restrictToIds.add(s.id);
    }
    const bm2 = rt.bm.query(queryTokens, { topK: topK * 2, restrictTo: restrictToIds });
    for (const r of bm2) {
      const sym = rt.getSymbolById(r.symbolId);
      if (sym) analogous.set(sym.id, sym);
    }
  }

  const allSymbols = Array.from(analogous.values());
  yield {
    type: 'symbol',
    symbols: [
      ...Array.from(templates.values()),
      ...allSymbols,
    ].map(s => ({
      id: s.id, name: s.name, kind: s.kind,
      fileId: s.fileId, filePath: filePathResolver(s.fileId),
      lineStart: s.lineStart, signature: s.signature,
      isTemplate: templates.has(s.id),
    })),
  };

  // 4. 构造 prompt
  const topic = matched[0]?.principle || null;
  const ctx = buildContext({
    topic: topic ? { title: topic.title, intro: topic.intro } : null,
    templateSymbols: Array.from(templates.values()),
    symbols: allSymbols,
    query, maxChars, mode: 'suggest',
    filePathResolver,
  });

  // 5. LLM streaming
  const messages = [
    { role: 'system', content: ctx.system },
    { role: 'user', content: `### user需求\n${query}\n\n${ctx.user}` },
  ];
  for await (const evt of llm.stream(messages, { maxChars, signal: opts.signal })) {
    yield evt;
  }
}

export default suggestImplementation;
