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
 * Halo Database C 源码符号抽取器。
 *
 * 算法：单次扫描，跟踪 brace/paren 深度，在顶层（brace=0, paren=0）按以下 token 切分：
 *   - 行首 `#` → 完整逻辑行（含 `\` 续行），仅处理 #define
 *   - `;` → 完整声明（typedef / 函数原型 / 全局变量），原型与 extern 跳过
 *   - `{` → 当前累积 chunk 若为函数签名则视为函数定义，吃 body 到匹配 `}`
 *
 * 注释/字符串先经 tokenizer.stripLiterals 剥离（保留行号）。
 *
 * 输出 Symbol[]：
 *   { id, name, kind, fileId, lineStart, lineEnd, signature, body, modifiers, paramNames, references }
 *
 * kind ∈ { function, struct, enum, typedef, typedef_funcptr, macro_func, macro_const, global_var }
 */

import { stripLiterals, offsetToLine } from './tokenizer.js';

const MODIFIER_KEYWORDS = new Set([
  'static', 'inline', 'extern', 'const', 'volatile', 'register', 'auto',
  'PGDLLEXPORT', 'PGDLLIMPORT', 'pg_attribute_format', 'pg_attribute_noreturn',
  'pg_attribute_unused', 'pg_attribute_always_inline', 'pg_attribute_no_sanitize',
  '_Noreturn', 'noexcept', '__attribute__', 'restrict',
]);

const BUILTIN_TYPES = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  'bool', '_Bool', 'size_t', 'ssize_t', 'ptrdiff_t', 'wchar_t',
]);

const STRUCT_KW = new Set(['struct', 'union', 'enum']);

/**
 * 解析 C 源码，返回符号数组。
 * @param {string} srcText
 * @param {{fileId?: number}} [opts]
 */
export function parseCSource(srcText, opts = {}) {
  const fileId = opts.fileId ?? 0;
  const { stripped, lineStarts } = stripLiterals(srcText);
  const n = stripped.length;
  const symbols = [];
  const identRe = /[A-Za-z_][A-Za-z0-9_]*/g;

  const lineOf = (off) => offsetToLine(lineStarts, off);
  const isLineStart = (off) => off === 0 || stripped[off - 1] === '\n';

  let i = 0;
  let brace = 0;
  let paren = 0;
  let declStart = 0;

  while (i < n) {
    const c = stripped[i];

    // 预处理器行
    if (c === '#' && brace === 0 && paren === 0 && isLineStart(i)) {
      let j = i;
      while (j < n) {
        if (stripped[j] === '\\' && (stripped[j+1] === '\n' || stripped[j+1] === '\r')) { j += 2; continue; }
        if (stripped[j] === '\n') break;
        j++;
      }
      const m = /^#\s*(\w+)/.exec(stripped.slice(i, j));
      if (m && m[1] === 'define') {
        emitDefine(stripped.slice(i, j), i, j);
      }
      i = j;
      declStart = i;
      continue;
    }

    if (c === '{') {
      if (brace === 0 && paren === 0) {
        const chunk = stripped.slice(declStart, i).trim();
        if (chunk) {
          const idxBeforeMaybeFn = symbols.length;
          const handled = maybeFunctionDef(chunk, declStart, i);
          if (handled) {
            const bodyEnd = matchBrace(stripped, i);
            if (bodyEnd > 0) {
              const sym = symbols[symbols.length - 1];
              sym.lineEnd = lineOf(bodyEnd);
              const bodyStartOff = lineStarts[sym.lineStart - 1];
              const bodyEndOff = (sym.lineEnd < lineStarts.length) ? lineStarts[sym.lineEnd] - 1 : n;
              sym.body = srcText.slice(bodyStartOff, Math.max(bodyStartOff, bodyEndOff + 1));
              sym.references = extractIdents(stripped.slice(declStart, bodyEnd + 1), identRe);
              i = bodyEnd + 1;
              declStart = i;
              continue;
            }
            // 无匹配 }：回滚
            symbols.length = idxBeforeMaybeFn;
          }
        }
      }
      brace++;
      i++;
      continue;
    }

    if (c === '}') { if (brace > 0) brace--; i++; continue; }
    if (c === '(') { paren++; i++; continue; }
    if (c === ')') { if (paren > 0) paren--; i++; continue; }

    if (c === ';' && brace === 0 && paren === 0) {
      const raw = stripped.slice(declStart, i + 1);
      const trimLeft = raw.length - raw.replace(/^\s+/, '').length;
      const chunk = raw.trim();
      if (chunk) tryEmitDecl(chunk, declStart + trimLeft, declStart + trimLeft + chunk.length);
      declStart = i + 1;
      i++;
      continue;
    }

    i++;
  }

  // 收尾
  if (declStart < n) {
    const raw = stripped.slice(declStart, n);
    const trimLeft = raw.length - raw.replace(/^\s+/, '').length;
    const chunk = raw.trim();
    if (chunk) tryEmitDecl(chunk, declStart + trimLeft, declStart + trimLeft + chunk.length);
  }

  function maybeFunctionDef(chunk, start, bracePos) {
    // 排除 typedef struct/enum/union { ... }
    if (/^\s*typedef\s*(struct|union|enum)\b/i.test(chunk)) return false;
    // 排除 struct/union/enum Tag {
    if (/^\s*(struct|union|enum)\s+[A-Za-z_]\w*\s*$/i.test(chunk)) return false;
    // 必须以 ) 结尾
    if (!chunk.endsWith(')')) return false;
    const openIdx = chunk.lastIndexOf('(');
    if (openIdx < 0) return false;
    const paramsPart = chunk.slice(openIdx + 1, -1).trim();
    const beforeParen = chunk.slice(0, openIdx).trim();
    if (!beforeParen) return false;
    const identMatch = beforeParen.match(/([A-Za-z_]\w*)\s*$/);
    if (!identMatch) return false;
    const name = identMatch[1];
    // 函数指针 typedef/定义 → 交给 ; 处理
    if (beforeParen.endsWith('*')) return false;
    const prefixTokens = beforeParen.slice(0, identMatch.index).trim().split(/\s+/).filter(Boolean);
    if (prefixTokens.length === 0) return false;

    const modifiers = [];
    let returnType = '';
    for (const tk of prefixTokens) {
      if (MODIFIER_KEYWORDS.has(tk)) modifiers.push(tk);
      else returnType += (returnType ? ' ' : '') + tk;
    }
    const lineStart = lineOf(start);
    const lineEnd = lineOf(bracePos);
    const signature = `${returnType} ${name}(${paramsPart})`.replace(/\s+/g, ' ').trim();
    symbols.push({
      id: `${fileId}:${lineStart}`,
      name,
      kind: 'function',
      fileId,
      lineStart,
      lineEnd,
      signature,
      body: '',
      modifiers,
      paramNames: parseParamNames(paramsPart),
      references: [],
    });
    return true;
  }

  function tryEmitDecl(chunk, start, end) {
    if (/^\s*typedef\b/.test(chunk)) {
      emitTypedef(chunk, start, end);
      return;
    }
    // 函数原型（含括号且以 ; 结尾）跳过
    if (chunk.endsWith(';') && chunk.includes('(') && !chunk.includes('{')) return;
    // extern 声明跳过
    if (/^\s*extern\b/.test(chunk) && chunk.endsWith(';')) return;
    // forward declaration `struct Foo;`
    if (/^\s*(struct|union|enum)\s+[A-Za-z_]\w*\s*;?\s*$/.test(chunk)) return;
    emitGlobal(chunk, start, end);
  }

  function emitTypedef(chunk, start, end) {
    const lineStart = lineOf(start);
    const lineEnd = lineOf(end);
    let m;
    if (m = /^typedef\s+(struct|union|enum)\s*([A-Za-z_]\w*)?\s*\{([\s\S]*)\}\s*([A-Za-z_]\w*)?\s*;?\s*$/.exec(chunk)) {
      const kind = m[1] === 'enum' ? 'enum' : 'struct';
      const name = m[4] || m[2];
      if (!name) return;
      symbols.push({
        id: `${fileId}:${lineStart}`, name, kind, fileId, lineStart, lineEnd,
        signature: `typedef ${m[1]} ${m[2] || ''} { ... } ${m[4] || ''}`.replace(/\s+/g, ' ').trim(),
        body: chunk, modifiers: [], paramNames: [],
        references: extractIdents(chunk, identRe),
      });
      return;
    }
    if (m = /^typedef\s+([\s\S]*?)\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(chunk)) {
      symbols.push({
        id: `${fileId}:${lineStart}`, name: m[2], kind: 'typedef_funcptr',
        fileId, lineStart, lineEnd,
        signature: `typedef ${m[1].trim()} (*${m[2]})(${m[3].trim()})`,
        body: chunk, modifiers: [],
        paramNames: parseParamNames(m[3]),
        references: extractIdents(chunk, identRe),
      });
      return;
    }
    if (m = /^typedef\s+(.+?)([\s\*]+)([A-Za-z_]\w*)\s*;?\s*$/.exec(chunk)) {
      const target = m[1].trim();
      const sep = m[2];
      const name = m[3];
      if (!name) return;
      symbols.push({
        id: `${fileId}:${lineStart}`, name, kind: 'typedef',
        fileId, lineStart, lineEnd,
        signature: `typedef ${target}${sep}${name}`.replace(/\s+/g, ' ').trim(),
        body: chunk, modifiers: [], paramNames: [],
        references: extractIdents(chunk, identRe),
      });
    }
  }

  function emitDefine(chunk, start, end) {
    const m = /^#\s*define\s+([A-Za-z_]\w*)(\([^)]*\))?([\s\S]*)$/.exec(chunk);
    if (!m) return;
    const name = m[1];
    const args = m[2];
    const body = (m[3] || '').trim();
    const lineStart = lineOf(start);
    const lineEnd = lineOf(end);
    symbols.push({
      id: `${fileId}:${lineStart}`, name,
      kind: args ? 'macro_func' : 'macro_const',
      fileId, lineStart, lineEnd,
      signature: `#define ${name}${args || ''}`,
      body: chunk.replace(/^\s+/, ''),
      modifiers: [],
      paramNames: args ? parseMacroParams(args) : [],
      references: extractIdents(body, identRe),
    });
  }

  function emitGlobal(chunk, start, end) {
    if (!chunk.endsWith(';')) return;
    if (chunk.includes('(')) return;
    const m = /^(.*?)([A-Za-z_]\w*)(\s*\[[^\]]*\])*\s*(=\s*[\s\S]*)?;\s*$/.exec(chunk);
    if (!m) return;
    const name = m[2];
    if (!name) return;
    if (MODIFIER_KEYWORDS.has(name) || BUILTIN_TYPES.has(name) || STRUCT_KW.has(name)) return;
    const modifiers = (m[1] || '').split(/\s+/).filter(Boolean);
    symbols.push({
      id: `${fileId}:${lineOf(start)}`, name, kind: 'global_var',
      fileId, lineStart: lineOf(start), lineEnd: lineOf(end),
      signature: chunk.replace(/\s+/g, ' ').trim(),
      body: chunk, modifiers, paramNames: [], references: [],
    });
  }

  function parseParamNames(paramsStr) {
    if (!paramsStr || /^\s*(void)?\s*$/.test(paramsStr)) return [];
    if (paramsStr.trim() === '...') return ['...'];
    return paramsStr.split(',').map(seg => {
      const s = seg.trim();
      if (!s) return null;
      if (s === '...') return '...';
      const m = /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$/.exec(s);
      return m ? m[1] : null;
    }).filter(Boolean);
  }

  function parseMacroParams(argsStr) {
    const inner = argsStr.replace(/[()]/g, '').trim();
    if (!inner) return [];
    return inner.split(',').map(s => s.trim()).filter(Boolean);
  }

  function extractIdents(text, re) {
    re.lastIndex = 0;
    const set = new Set();
    let m;
    while ((m = re.exec(text))) {
      const w = m[0];
      if (!MODIFIER_KEYWORDS.has(w) && !BUILTIN_TYPES.has(w) && !STRUCT_KW.has(w) && w.length >= 2) {
        set.add(w);
      }
      re.lastIndex = m.index + w.length;
    }
    return Array.from(set);
  }

  return { symbols, generated: false };
}

function matchBrace(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export default parseCSource;
