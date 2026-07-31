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
 * Yacc/Lex 源文件解析器（Halo Database gram.y / scan.l 风格）。
 *
 * 文件区段：
 *   %{ ... %}      prologue（C 代码）
 *   %token / %type / %left 等声明
 *   %% ... %%      规则区（bison grammar 或 flex rules）
 *   C 代码          epilogue
 *
 * 我们从 prologue 与 epilogue 抽取 C 符号（委托 c_parser），
 * 规则区把每条规则的 action 当作一个 "rule" 符号（kind: grammar_rule | lex_rule）。
 *
 * 对于 .y：`nonterminal: production { action } | production { action } ;`
 * 对于 .l：`pattern { action }`（无分号分隔）
 */

import { parseCSource } from './c_parser.js';
import { stripLiterals, offsetToLine } from './tokenizer.js';

export function parseYlexSource(srcText, opts = {}) {
  const fileId = opts.fileId ?? 0;
  const isLex = opts.isLex ?? (opts.filename ? /\.l$/.test(opts.filename) : false);
  const { stripped, lineStarts } = stripLiterals(srcText);
  const n = stripped.length;
  const lineOf = (off) => offsetToLine(lineStarts, off);

  // 1. 切分四段：prologue, declarations, rules, epilogue
  const segments = splitYlexSegments(stripped);
  const symbols = [];

  // 2. prologue %{ %} 内的 C 代码交给 c_parser
  for (const seg of segments.filter(s => s.kind === 'cblock')) {
    const sub = srcText.slice(seg.innerStart, seg.innerEnd);
    const inner = parseCSource(sub, { fileId });
    // 调整 inner 符号的行号偏移
    const baseLine = lineOf(seg.innerStart);
    for (const sym of inner.symbols) {
      sym.lineStart += baseLine - 1;
      sym.lineEnd += baseLine - 1;
      sym.id = `${fileId}:${sym.lineStart}`;
      symbols.push(sym);
    }
  }

  // 3. 规则区抽取每条规则的 action 作为符号
  for (const seg of segments.filter(s => s.kind === 'rules')) {
    const rules = extractRules(stripped.slice(seg.start, seg.end), seg.start, isLex);
    for (const r of rules) {
      const lineStart = lineOf(r.actionStart);
      const lineEnd = lineOf(r.actionEnd);
      symbols.push({
        id: `${fileId}:${lineStart}`,
        name: r.name || `rule_${lineStart}`,
        kind: isLex ? 'lex_rule' : 'grammar_rule',
        fileId,
        lineStart,
        lineEnd,
        signature: r.head,
        body: srcText.slice(r.actionStart, r.actionEnd + 1),
        modifiers: [],
        paramNames: [],
        references: r.references,
        // 额外字段：规则的左部与右部
        grammarHead: r.head,
        grammarBody: r.body_preview,
      });
    }
  }

  return { symbols, generated: false };
}

/**
 * 把 stripped 源码切成段。返回 [{ kind, start, end, innerStart, innerEnd }]。
 */
function splitYlexSegments(stripped) {
  const segs = [];
  const n = stripped.length;
  let i = 0;
  let pos = 0;

  // prologue / declarations / rules / epilogue
  let phase = 'prologue';   // prologue → after first %% → rules → after second %% → epilogue
  let declStart = 0;

  while (i < n) {
    // %{ ... %}
    if (stripped[i] === '%' && stripped[i+1] === '{') {
      const start = i;
      let j = i + 2;
      while (j < n && !(stripped[j] === '%' && stripped[j+1] === '}')) j++;
      const innerStart = i + 2;
      const innerEnd = j;
      segs.push({ kind: 'cblock', start, end: j + 2, innerStart, innerEnd });
      i = j + 2;
      pos = i;
      continue;
    }
    // %pure-parser, %token, %type, %left, %right, %union, %expect 等 → 跳过
    if (stripped[i] === '%' && /[A-Za-z_]/.test(stripped[i+1] || '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(stripped[j])) j++;
      // 若是 %union { ... } 或 %destructor { ... } { ... } 等，需要吃 {}
      if (stripped[j] === '{') {
        const match = matchBrace(stripped, j);
        if (match > 0) j = match + 1;
      }
      i = j;
      pos = i;
      continue;
    }
    // %%
    if (stripped[i] === '%' && stripped[i+1] === '%') {
      if (phase === 'prologue') {
        phase = 'rules';
        declStart = i + 2;
        i += 2;
        pos = i;
        continue;
      } else if (phase === 'rules') {
        // rules 段落：declStart 之前的去声明区，declStart..i 是 rules
        // 简化：把 declStart..i 当作 rules 区段
        segs.push({ kind: 'rules', start: declStart, end: i });
        segs.push({ kind: 'cblock', start: i + 2, end: n, innerStart: i + 2, innerEnd: n });
        i = n;
        pos = i;
        break;
      }
    }
    i++;
    pos = i;
  }
  // 若没有遇到 %%（异常），把全部当 cblock
  if (segs.length === 0) {
    segs.push({ kind: 'cblock', start: 0, end: n, innerStart: 0, innerEnd: n });
  }
  return segs;
}

function matchBrace(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * 从规则区抽取每条规则。
 *
 * .y 风格：`nt: production1 { action1 } | production2 { action2 } ;`
 *   - 我们把每条规则的 action 当成单独符号，name=nt
 * .l 风格：`pattern { action }`（每个 pattern 一行）
 */
function extractRules(text, baseOffset, isLex) {
  const rules = [];
  const n = text.length;
  let i = 0;
  const identRe = /[A-Za-z_][A-Za-z0-9_]*/g;

  if (isLex) {
    // 简化：扫描每个 { ... } 块，前溯找最近的 pattern（同行起头）
    while (i < n) {
      if (text[i] === '{') {
        const actionEnd = matchBrace(text, i);
        if (actionEnd < 0) break;
        // 找 action 所在行的开头，回退到 { 之前作为 pattern
        let lineStart = i;
        while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
        const pattern = text.slice(lineStart, i).trim();
        // pattern 通常是一段正则，可能很长。截短显示
        const head = pattern.length > 60 ? pattern.slice(0, 60) + '...' : pattern;
        if (head) {
          const body = text.slice(i + 1, actionEnd);
          rules.push({
            name: head.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32) || `lex_${lineStart}`,
            head,
            body_preview: body.slice(0, 80),
            actionStart: baseOffset + i,
            actionEnd: baseOffset + actionEnd,
            references: extractIdents(body, identRe),
          });
        }
        i = actionEnd + 1;
        continue;
      }
      i++;
    }
    return rules;
  }

  // bison 风格：单次扫描，前向追踪最近的 nonterminal 名。
  // 状态：遇 NAME : 即更新 currentNt；遇 { 即弹出一条规则；遇 ; 重置 currentNt。
  let currentNt = null;
  let lastIdent = null;     // 上一个识别到的标识符（候选 nt 名）
  let sawColon = false;

  while (i < n) {
    const c = text[i];
    if (c === '{') {
      const actionEnd = matchBrace(text, i);
      if (actionEnd < 0) break;
      const ntName = currentNt || (lastIdent || 'rule');
      const body = text.slice(i + 1, actionEnd);
      rules.push({
        name: ntName,
        head: ntName,
        body_preview: body.slice(0, 80),
        actionStart: baseOffset + i,
        actionEnd: baseOffset + actionEnd,
        references: extractIdents(body, identRe),
      });
      i = actionEnd + 1;
      continue;
    }
    if (c === ':') {
      // 把上一个标识符作为 nt 名
      currentNt = lastIdent;
      lastIdent = null;
      i++;
      continue;
    }
    if (c === ';') {
      currentNt = null;
      lastIdent = null;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      lastIdent = text.slice(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return rules;
}

function extractIdents(text, re) {
  re.lastIndex = 0;
  const set = new Set();
  let m;
  while ((m = re.exec(text))) {
    const w = m[0];
    if (w.length >= 2) set.add(w);
    re.lastIndex = m.index + w.length;
  }
  return Array.from(set);
}

export default parseYlexSource;
