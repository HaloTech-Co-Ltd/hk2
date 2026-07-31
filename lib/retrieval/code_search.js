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
 * Code search: natural language → relevant files and functions.
 *
 * Strategy:
 *   1. Tokenize query + filter stop-words + normalize stems (text_tokenizer)
 *   2. BM25 retrieve top 200 candidates
 *   3. Rerank:
 *      - name fully contains all query tokens → highest priority
 *      - name contains query-token subset → next
 *      - matched only in signature/body → base score
 *      - function / typedef preferred over macro / global_var (macros are noisy)
 *      - prefer English (non _details.h internal macros)
 *   4. Callgraph 1-hop expansion (optional, score decays)
 */

import { tokenizeText, expandQueryVariants } from '../index/text_tokenizer.js';

const KIND_WEIGHT = {
  function: 1.0,
  typedef: 0.85,
  typedef_funcptr: 0.85,
  struct: 0.85,
  enum: 0.85,
  global_var: 0.6,
  macro_func: 0.55,
  macro_const: 0.45,
  grammar_rule: 0.7,
  lex_rule: 0.7,
};

/**
 * @param {import('./kb_runtime.js').KBRuntime} rt
 * @param {string} query
 * @param {{topK?: number, expandGraph?: boolean}} [opts]
 */
export function codeSearch(rt, query, opts = {}) {
  const topK = opts.topK ?? 30;
  const expandGraph = opts.expandGraph ?? true;

  const tokens = tokenizeText(query, { expandQuery: true });
  if (tokens.length === 0) return [];

  // 评minute只用 ASCII（EN）token：CJK bigram 在英文源码里 0 命中，混入会稀释 nameFullCover
  const baseTokens = Array.from(new Set(tokens.filter(t => !/[一-鿿㐀-䶿]/.test(t))));
  // 对每个 EN token generate形态变体，缓解 query 与 index 词干不一致问题
  const queryTokens = baseTokens.length > 0 ? baseTokens : Array.from(new Set(tokens));
  const bmTokens = [];
  for (const t of queryTokens) {
    bmTokens.push(t, ...expandQueryVariants(t));
  }
  const effectiveTokens = Array.from(new Set(bmTokens));
  const qLen = queryTokens.length;

  // 拿 top 200 候选（变体 token 在 BM25 里命中index中任意形态的 doc）
  const raw = rt.bm.query(effectiveTokens, { topK: Math.max(200, topK * 5) });
  if (raw.length === 0) return [];

  const scored = [];
  for (const r of raw) {
    const sym = rt.getSymbolById(r.symbolId);
    if (!sym) continue;

    // name + signature token set（重复加权后 BM25 已考虑，这里只用于"override"statistics）
    const nameTokens = new Set(tokenizeText(sym.name || ''));
    const sigTokens = new Set(tokenizeText(sym.signature || ''));

    // compute被 query 命中的 *distinct* name/sig token 数（避免双向变体导致重复计数）
    const matchedNameTokens = new Set();
    const matchedSigTokens = new Set();
    for (const t of queryTokens) {
      const variants = expandQueryVariants(t);
      for (const v of variants) {
        if (nameTokens.has(v)) matchedNameTokens.add(v);
        else if (sigTokens.has(v)) matchedSigTokens.add(v);
      }
    }
    const inName = matchedNameTokens.size;
    const inSig = matchedSigTokens.size;
    const totalMatched = inName + inSig + (r.score > 0 && inName + inSig === 0 ? 1 : 0);
    const ratio = totalMatched / qLen;

    // name"全包含 query" 强奖励（要求 name 不能明显长于 query，避免长名误命中）
    const nameSize = nameTokens.size;
    const nameFullCover = inName === qLen && qLen > 0 && nameSize <= qLen + 1 ? 1 : 0;
    // nameoverride ≥ 一半
    const nameHighCover = inName >= Math.ceil(qLen / 2) && inName > 0 && nameSize <= qLen + 2 ? 0.6 : 0;
    // name token 全部被 query override且 name 长度合理：canonical function信号
    // 要求 name 至少 2 token，且 nameSize 不超过 qLen + 2（否则属于"长名碰巧包含 query"）
    const nameFullyUsed =
      inName > 0 &&
      nameSize >= 2 &&
      inName === nameSize &&
      nameSize <= Math.max(3, qLen) ? 1 : 0;
    // name 中"未被 query override"的多余 token 数（如 ginHeapTupleInsert 的 gin）
    const extraNameTokens = Math.max(0, nameSize - inName);

    // kind weight
    const kindW = KIND_WEIGHT[sym.kind] ?? 0.7;

    // nameexact短语match（如 query "heap insert" name "heap_insert"）
    const normalizedName = (sym.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const normalizedQuery = queryTokens.join('');
    const phraseBoost = normalizedName === normalizedQuery ? 50 : 0;
    // 仅当 name 较短（≤ query 长度 +2）hour才给 substr 加minute，避免长名"包含"短 query
    const phraseSubstr =
      normalizedName.includes(normalizedQuery) &&
      normalizedQuery.length >= 4 &&
      normalizedName.length <= normalizedQuery.length + 4 ? 20 : 0;

    // 综合minute：用 sqrt(BM25) 让 BM25 差距更显著（长query下 BM25 是强信号）
    const baseScore = Math.sqrt(r.score);
    // 短query（≤5 token）信任 name 信号；长query BM25 主导（name 全包含奖励意义不大）
    const useNameBonuses = qLen <= 5;
    const finalScore =
      baseScore * kindW +
      (useNameBonuses ? nameFullCover * 5 : 0) +
      (useNameBonuses ? nameFullyUsed * 3 : 0) +
      (useNameBonuses ? nameHighCover * 1.5 : 0) +
      inName * 1.2 +
      inSig * 0.4 +
      ratio * 1.5 +
      phraseBoost +
      phraseSubstr -
      extraNameTokens * 0.6;

    scored.push({
      sym,
      score: finalScore,
      bm25: r.score,
      inName, inSig, totalMatched,
      ratio, nameFullCover, nameFullyUsed, extraNameTokens, kindW,
    });
  }

  // compute kind sortweight（function优先于 typedef/struct，macro/global_var 靠后）
  const kindRank = (kind) => {
    if (kind === 'function') return 3;
    if (kind === 'typedef' || kind === 'typedef_funcptr' || kind === 'struct' || kind === 'enum') return 2;
    if (kind === 'grammar_rule' || kind === 'lex_rule') return 2;
    if (kind === 'global_var') return 1;
    return 0;  // macro_*
  };

  scored.sort((a, b) => {
    // 主sort：kind rank + namematch质量
    // 长query下也保留 kind 优先级（避免 typedef 短名压制function）
    const aKind = kindRank(a.sym.kind);
    const bKind = kindRank(b.sym.kind);
    if (bKind !== aKind) return bKind - aKind;
    // 短query下，name全match作为次级sort键
    if (qLen <= 5) {
      const aName = (a.nameFullyUsed || 0) * 2 + (a.nameFullCover || 0);
      const bName = (b.nameFullyUsed || 0) * 2 + (b.nameFullCover || 0);
      if (bName !== aName) return bName - aName;
    }
    return b.score - a.score;
  });

  // callgraph扩展（仅当候选较少hour）
  let results = scored.slice(0, topK);
  if (expandGraph && results.length < topK) {
    const seen = new Set(results.map(s => s.sym.id));
    const neighbors = [];
    for (const s of scored.slice(0, 10)) {
      const edges = (rt.callgraph.byId || {})[s.sym.id] || [];
      for (const id of edges) {
        if (seen.has(id)) continue;
        const nsym = rt.getSymbolById(id);
        if (!nsym) continue;
        seen.add(id);
        neighbors.push({ sym: nsym, score: s.score * 0.2, via: s.sym.id, inName: 0, inSig: 0, totalMatched: 0, ratio: 0, nameFullCover: 0, nameFullyUsed: 0, kindW: KIND_WEIGHT[nsym.kind] ?? 0.7 });
      }
    }
    neighbors.sort((a, b) => b.score - a.score);
    for (const n of neighbors.slice(0, topK - results.length)) results.push(n);
  }

  return results.map(r => ({
    id: r.sym.id,
    name: r.sym.name,
    kind: r.sym.kind,
    fileId: r.sym.fileId,
    filePath: rt.getFilePath(r.sym.fileId),
    lineStart: r.sym.lineStart,
    lineEnd: r.sym.lineEnd,
    signature: r.sym.signature,
    score: Number(r.score.toFixed(3)),
    bm25: Number((r.bm25 || 0).toFixed(2)),
    matched: r.totalMatched,
    via: r.via,
    snippet: snippetFor(r.sym),
  }));
}

function snippetFor(sym) {
  if (!sym.body) return sym.signature || '';
  const lines = sym.body.split('\n').slice(0, 4);
  return lines.join('\n').trim();
}

export default codeSearch;
