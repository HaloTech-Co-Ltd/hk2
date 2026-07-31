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
 * Streaming markdown renderer for the REPL.
 *
 * The agent's output is markdown-formatted. Streaming the raw source as-is
 * was hard to read; this module parses line-by-line as deltas arrive and
 * emits ANSI-styled output via lib/agent/style.js.
 *
 * Usage:
 *   const md = new MarkdownStream();
 *   for each delta: process.stdout.write(md.feed(delta));
 *   at end of stream: process.stdout.write(md.flush());
 *
 * Block elements handled:
 *   - ATX headings (H1/H2 with underline, H3+ bold)
 *   - Horizontal rules
 *   - Blockquotes
 *   - Bullet / numbered lists
 *   - Fenced code blocks (``` and ~~~), with `mermaid` blocks labelled
 *   - GFM tables (header + separator + rows), rendered with box edges and
 *     per-column alignment, widths capped to 40 cols with ellipsis.
 *
 * Inline: `code`, **bold**, *italic*, ~~strike~~, [link](url). Nested inline
 * (e.g. bold inside a list item) is supported.
 *
 * Tables need a 1-line lookahead (to confirm the second line is the
 * `|---|---|` separator) and accumulate until a non-row line arrives, so a
 * table's text is buffered and emitted as one rendered block at the end.
 */

import * as style from './style.js';

const MAX_CELL_WIDTH = 40;

export class MarkdownStream {
  constructor() {
    this.buf = '';
    this.inCode = false;
    this.codeFence = '';
    this.codeLang = '';
    this.pendingLine = null;   // line held for table-start lookahead
    this.tableRows = null;     // array of strings while collecting a table
  }

  /** Feed a delta. Returns styled text to write to stdout. */
  feed(text) {
    this.buf += text;
    let out = '';
    while (true) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      out += this._processLine(line);
    }
    return out;
  }

  /** Flush trailing buffered content (partial line / open table / pending line). */
  flush() {
    let out = '';
    if (this.buf) {
      out += this._processLine(this.buf);
      this.buf = '';
    }
    if (this.tableRows) {
      out += renderTable(this.tableRows) + '\n';
      this.tableRows = null;
    }
    if (this.pendingLine !== null) {
      out += this._renderLine(this.pendingLine) + '\n';
      this.pendingLine = null;
    }
    return out;
  }

  /** Process one complete line — may buffer for tables, otherwise renders. */
  _processLine(line) {
    // Inside a table: accumulate rows until a non-table line ends it.
    if (this.tableRows !== null) {
      if (isTableRow(line)) {
        this.tableRows.push(line);
        return '';
      }
      const rendered = renderTable(this.tableRows) + '\n';
      this.tableRows = null;
      return rendered + this._processLine(line);
    }
    // Pending-line window: looking for a table separator on the next line.
    if (this.pendingLine !== null) {
      const prev = this.pendingLine;
      this.pendingLine = null;
      if (isTableSeparator(line) && isTableRow(prev)) {
        this.tableRows = [prev, line];
        return '';
      }
      return this._renderLine(prev) + '\n' + this._processLine(line);
    }
    // Outside tables / code: hold table-row candidates for one-line lookahead.
    if (!this.inCode && isTableRow(line)) {
      this.pendingLine = line;
      return '';
    }
    return this._renderLine(line) + '\n';
  }

  _renderLine(line) {
    // Fenced code block: open or close.
    const fenceMatch = /^(```+|~~~+)(.*)$/.exec(line.trimStart());
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!this.inCode) {
        this.inCode = true;
        this.codeFence = marker[0];
        this.codeLang = fenceMatch[2].trim();
        // Mermaid blocks get a distinct label since terminals can't render
        // the diagram; the source is shown muted so the user can copy it
        // into a real renderer.
        if (this.codeLang.toLowerCase() === 'mermaid') {
          return style.warning(style.ICON.warn + ' mermaid diagram') +
                 style.dim(' (terminal cannot render; source below)');
        }
        return style.dim(marker + (this.codeLang ? ' ' + this.codeLang : ''));
      }
      if (marker[0] === this.codeFence) {
        this.inCode = false;
        this.codeFence = '';
        this.codeLang = '';
        return style.dim(marker);
      }
    }
    if (this.inCode) {
      return style.muted(line);
    }
    return this._renderBlock(line);
  }

  _renderBlock(line) {
    if (/^\s*-{3,}\s*$/.test(line)) {
      return style.dim(style.BOX.horizontal.repeat(Math.max(20, Math.min(60, 40))));
    }
    const h = /^(#{1,6})\s+(.*?)(\s*#{1,6})?\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = applyInline(h[2]);
      if (level <= 2) {
        const visibleLen = stripAnsi(text).length;
        const rule = style.accent(style.HEADING_RULE.repeat(Math.max(3, Math.min(60, visibleLen))));
        return style.bold(style.accent(text)) + '\n' + rule;
      }
      return style.bold(style.accent(text));
    }
    const q = /^(\s*)>\s?(.*)$/.exec(line);
    if (q) {
      return q[1] + style.dim(style.BOX.vertical + ' ') + style.italic(applyInline(q[2]));
    }
    const b = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    if (b) {
      return b[1] + style.accent(style.ICON.bullet + ' ') + applyInline(b[3]);
    }
    const n = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (n) {
      return n[1] + style.accent(n[2] + '. ') + applyInline(n[3]);
    }
    if (line.trim() === '') return '';
    return applyInline(line);
  }
}

/* ------------------------------------------------------------------ */
/* Tables (GFM)                                                        */
/* ------------------------------------------------------------------ */

function isTableRow(line) {
  const t = line.trim();
  if (!t.includes('|')) return false;
  return /^\|?\s*[^|\n]+\s*(\|\s*[^|\n]+\s*)+\|?$/.test(t);
}

function isTableSeparator(line) {
  const t = line.trim();
  if (!t.includes('|')) return false;
  const inner = t.replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|').map(s => s.trim());
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c) && c.replace(/:/g, '').length >= 3);
}

/** Parse `| a | b |` into ['a', 'b'] (handles missing/escaped pipes). */
function parseTableRow(line) {
  let s = line.trim();
  s = s.replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Render a buffered table (header, separator, data rows) as an aligned grid.
 * Column widths cap at MAX_CELL_WIDTH; longer cells get truncated with `…`.
 * Separator's `:` markers drive per-column alignment.
 */
function renderTable(rows) {
  const parsed = rows.map(parseTableRow);
  const header = parsed[0] || [];
  const sep = parsed[1] || [];
  const data = parsed.slice(2);
  const cols = Math.max(header.length, ...data.map(r => r.length));
  const aligns = [];
  for (let i = 0; i < cols; i++) {
    const cell = sep[i] || '';
    if (cell.startsWith(':') && cell.endsWith(':')) aligns[i] = 'center';
    else if (cell.endsWith(':')) aligns[i] = 'right';
    else aligns[i] = 'left';
  }
  // Column widths from data, capped.
  const widths = new Array(cols).fill(0);
  for (const row of [header, ...data]) {
    for (let i = 0; i < cols; i++) {
      const cellText = stripAnsi(applyInline(String(row[i] || '')));
      widths[i] = Math.max(widths[i], Math.min(MAX_CELL_WIDTH, cellWidth(cellText)));
    }
  }

  const pad = (text, w, align) => {
    let t = String(text || '');
    const vis = cellWidth(stripAnsi(t));
    if (vis > w) {
      const ell = style.ICON.ellipsis;
      const ellW = cellWidth(ell);
      let out = '', w2 = 0, inEsc = false;
      for (const ch of t) {
        if (ch === '\x1b') inEsc = true;
        if (inEsc) { out += ch; if (ch === 'm') inEsc = false; continue; }
        if (w2 >= w - ellW) break;
        out += ch;
        w2 += cellWidth(ch);
      }
      t = out + style.dim(ell);
    } else {
      const padding = w - vis;
      if (align === 'right') t = ' '.repeat(padding) + t;
      else if (align === 'center') t = ' '.repeat(Math.floor(padding / 2)) + t + ' '.repeat(Math.ceil(padding / 2));
      else t = t + ' '.repeat(padding);
    }
    return t;
  };

  const formatRow = (row, isHeader) => {
    const cells = [];
    for (let i = 0; i < cols; i++) {
      const raw = row[i] || '';
      const styled = isHeader ? style.bold(applyInline(raw)) : applyInline(raw);
      cells.push(pad(styled, widths[i], aligns[i]));
    }
    const v = style.dim(style.BOX.vertical);
    return `${v} ${cells.join(` ${v} `)} ${v}`;
  };

  // Header/separator junctions.
  const h = style.dim(style.BOX.horizontal);
  const cross = style.dim(style.HAS_UTF8 ? '┼' : '+');
  const left = style.dim(style.HAS_UTF8 ? '├' : '+');
  const right = style.dim(style.HAS_UTF8 ? '┤' : '+');
  const sepParts = widths.map(w => h.repeat(w + 2));
  const sepLine = `${left}${sepParts.join(cross)}${right}`;

  const out = [];
  out.push(formatRow(header, true));
  out.push(sepLine);
  for (const row of data) out.push(formatRow(row, false));
  return out.join('\n');
}

/** Visible width of a string that may already be ANSI-stripped. */
function cellWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x1100 && (
      (cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF)
    ) ? 2 : 1;
  }
  return w;
}

/* ------------------------------------------------------------------ */
/* Inline formatting                                                   */
/* ------------------------------------------------------------------ */

/**
 * Apply inline markdown formatting to a single line of text.
 * Code spans are extracted first as sentinels so bold/italic/link passes
 * don't touch their contents.
 */
export function applyInline(text) {
  if (!text) return '';
  const codes = [];
  let work = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\x00${codes.length - 1}\x00`;
  });
  work = work.replace(/\*\*([^*]+)\*\*/g, (_, t) => style.bold(t));
  work = work.replace(/__([^_]+)__/g, (_, t) => style.bold(t));
  work = work.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, t) => pre + style.italic(t));
  work = work.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_, pre, t) => pre + style.italic(t));
  work = work.replace(/~~([^~]+)~~/g, (_, t) => style.dim('\x1b[9m' + t + '\x1b[29m'));
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) =>
    style.accent(t) + ' ' + style.dim('<' + u + '>'));
  work = work.replace(/\x00(\d+)\x00/g, (_, i) => style.bashMode(codes[+i] ?? ''));
  return work;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}
