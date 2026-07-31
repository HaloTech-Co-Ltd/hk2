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
