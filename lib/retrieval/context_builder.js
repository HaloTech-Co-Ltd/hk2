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
 * Context builder: combine topic intro + symbols into an LLM prompt,
 * bounded by a character budget.
 *
 * Output: { system, user }
 */

import { tokenizeText } from '../index/text_tokenizer.js';

/**
 * @param {object} params
 * @param {{topic?: string, title?: string, intro?: string}} [params.topic]
 * @param {Array} params.symbols  Symbols to include
 * @param {string} params.query
 * @param {number} [params.maxChars]
 * @param {string} [params.mode]  'principle' | 'suggest'
 * @param {Array} [params.templateSymbols]
 * @param {string} [params.filePathResolver]  optional
 */
export function buildContext(params) {
  const { topic, symbols = [], templateSymbols = [], query, maxChars = 65536, mode = 'principle', filePathResolver } = params;
  const parts = [];
  let used = 0;

  // 1. topic intro
  if (topic && topic.intro) {
    const header = `## Topic: ${topic.title || topic.topic}\n\n${topic.intro}\n`;
    parts.push({ role: 'header', text: header });
    used += header.length;
  }

  // 2. template symbols (suggest mode)
  if (templateSymbols && templateSymbols.length > 0) {
    const header = `\n## Reference templates (existing project implementations)\n`;
    parts.push({ role: 'header', text: header });
    used += header.length;
    for (const sym of templateSymbols) {
      const text = formatSymbol(sym, filePathResolver, true);
      if (used + text.length > maxChars * 0.3) break;
      parts.push({ role: 'symbol', text });
      used += text.length;
    }
  }

  // 3. BM25-ranked symbols (remaining budget)
  const sortedSyms = [...symbols];
  parts.push({ role: 'header', text: `\n## Related symbols (ranked by relevance)\n` });
  for (const sym of sortedSyms) {
    const text = formatSymbol(sym, filePathResolver, false);
    if (used + text.length > maxChars) {
      const remain = maxChars - used;
      if (remain > 200) {
        parts.push({ role: 'symbol', text: text.slice(0, remain) + '\n... (truncated)\n' });
        used = maxChars;
      }
      break;
    }
    parts.push({ role: 'symbol', text });
    used += text.length;
  }

  const user = parts.map(p => p.text).join('\n');
  const system = buildSystemPrompt(mode);
  return { system, user, usedChars: used };
}

function formatSymbol(sym, filePathResolver, isTemplate) {
  const path = filePathResolver ? filePathResolver(sym.fileId) : `fileId:${sym.fileId}`;
  const lines = [];
  const lang = inferLang(path);
  lines.push(`### ${sym.name} [${sym.kind}]  ${path}:${sym.lineStart}`);
  lines.push('```' + lang);
  // Template: full body (truncated to 1500 chars)
  // Non-template: signature + first 800 chars of body
  const limit = isTemplate ? 1500 : 800;
  let body = sym.body || sym.signature || '';
  if (body.length > limit) body = body.slice(0, limit) + '\n/* ... truncated ... */';
  lines.push(body);
  lines.push('```');
  return lines.join('\n');
}

function inferLang(filePath) {
  if (!filePath) return '';
  const m = /\.([A-Za-z0-9]+)$/i.exec(filePath);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  if (['c', 'h'].includes(ext)) return 'c';
  if (['cpp', 'cc', 'hpp', 'cxx'].includes(ext)) return 'cpp';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (['jsx'].includes(ext)) return 'jsx';
  if (['ts'].includes(ext)) return 'typescript';
  if (['tsx'].includes(ext)) return 'tsx';
  if (ext === 'py') return 'python';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rust';
  if (ext === 'java') return 'java';
  if (ext === 'kt') return 'kotlin';
  if (ext === 'scala') return 'scala';
  if (ext === 'rb') return 'ruby';
  if (ext === 'php') return 'php';
  if (ext === 'swift') return 'swift';
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'bash';
  return '';
}

function buildSystemPrompt(mode) {
  if (mode === 'principle') {
    return `You are a senior software engineer helping a colleague understand how a part of the project works. Using the provided code symbols (with file paths and line numbers), give a focused, accurate explanation of the user's question.

Style:
- Talk like a senior engineer at a whiteboard: direct, technical, no filler.
- Anchor every claim to a concrete identifier / field / call site, cited as [relative/path.ext:line]. Write "X calls Y at [src/foo.c:1234]", not "this step writes".
- Use prose for the narrative; reserve lists for genuine enumerations or sequences. Don't bullet-point what should be a paragraph.
- If the provided context is insufficient, say so explicitly: "I need to look at X's implementation". Don't invent.
- Be concise. Don't restate the question before answering. No closing summary block.`;
  }
  if (mode === 'suggest') {
    return `You are a senior software engineer doing a design review. Given the provided "template symbols" (existing similar implementations in the project) and "related symbols", propose a concrete, actionable implementation plan.

Style:
- Open with one or two paragraphs giving the core approach and why; then expand on key steps. Number steps in order, bullet when parallel, prose otherwise — don't force structure.
- Code skeletons should use existing project APIs. Cite each non-trivial call as [file:line].
- Don't copy template code verbatim; adapt to the requirement. If you reuse a chunk, say why.
- List only real gotchas: lock ordering, error-recovery paths, concurrency races. Skip platitudes like "consider performance".
- Be concrete about test strategy: name the framework and the file.
- Be concise. Don't restate the requirement. No closing summary block.`;
  }
  return 'You are a software engineering assistant. Answer the user question based on the provided code context.';
}

/**
 * Match the most relevant principles for the query.
 * @param {Array} principles  principle list
 * @param {string} query
 * @returns {Array} top 2 matched principles with score
 */
export function matchPrinciples(principles, query) {
  if (!principles || principles.length === 0) return [];
  const queryTokens = new Set(tokenizeText(query));
  if (queryTokens.size === 0) return [];
  const scored = [];
  for (const p of principles) {
    // P2-1: the intro BODY now participates in matching (truncated to keep
    // tokenization cheap). Facts written into an entry's intro (e.g. a
    // user-saved environment-facts entry) are therefore retrievable even
    // when the title/keywords don't mention them — previously such entries
    // had ZERO token overlap with the query and never matched.
    const headTokens = new Set([
      ...tokenizeText(p.topic || ''),
      ...tokenizeText(p.title || ''),
      ...(p.keywords || []).flatMap(kw => tokenizeText(kw)),
    ]);
    const introText = typeof p.intro === 'string' ? p.intro.slice(0, 2000) : '';
    const introTokens = new Set(tokenizeText(introText));
    let overlap = 0;
    let introOverlap = 0;
    for (const t of queryTokens) {
      if (headTokens.has(t)) overlap++;
      else if (introTokens.has(t)) introOverlap++;
    }
    if (overlap === 0 && introOverlap === 0) continue;
    // Title/keyword hits remain the dominant signal and intro-only matches
    // still surface, but note the head-match score is NOT strictly frozen:
    // when an entry matches BOTH head (title/keywords) and intro body, its
    // head-match score gains an additional 0.3 per intro token hit
    // ((overlap + 0.3 * introOverlap) / sqrt(headTokens.size)). That boost is
    // deliberate — an entry that matches on both surfaces is more on-topic
    // than one matching only its title — but it CAN flip the relative ranking
    // between two head-matched entries when only one has intro overlap.
    let score;
    if (overlap > 0) {
      score = (overlap + 0.3 * introOverlap) / Math.sqrt(headTokens.size || 1);
    } else {
      score = 0.3 * introOverlap / Math.sqrt(Math.max(headTokens.size, 8));
    }
    scored.push({ principle: p, score, overlap: overlap + introOverlap });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2);
}

export default buildContext;
