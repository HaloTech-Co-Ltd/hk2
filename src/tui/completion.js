/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频，图表，界面设计，版面框架，有关数据或电子文档等）
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
 * protected by intellectual property laws. As expressly permitted in
 * your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software in
 * dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Completion menu — the Claude Code layout: rendered BELOW the input area,
 * a two-column list (command / description) where long descriptions wrap
 * onto continuation lines aligned under the description column, the
 * selected row highlighted in accent, and the window sized by terminal
 * rows. Candidates come from slashCompletions() (src/slash/index.js,
 * derived from SLASH_COMMANDS + HELP_TEXT — there is no separate list to
 * drift); this module only formats and moves the selection.
 */
import * as style from '../../lib/agent/style.js';
import { slashCompletions } from '../slash/index.js';

/** Description column ceiling (labels are padded to the ACTUAL max label). */
const DESC_COL = 30;
/** Below this width the menu switches to a stacked label/description layout. */
const NARROW_W = 64;
/** Below this width descriptions are dropped entirely (labels only). */
const HIDE_DESC_W = 44;

/**
 * Build the menu state for the current input line.
 *
 * @param {string} line current input
 * @param {{selected?: number, maxRows?: number, width?: number}} opts
 *   maxRows — visible LINE budget (each item takes 1–2 lines); 0 = auto
 *   (terminal rows − 10, clamped to 3..14)
 * @returns {{items: Array, selected: number, replaceFrom: number, lines: string[], open: boolean}}
 */
export function completionMenu(line, { selected = 0, maxRows = 0, width = 0 } = {}) {
  const { items: rawItems, replaceFrom } = slashCompletions(line);
  // Sort for DISPLAY (Claude Code lists commands alphabetically; the
  // registry order stays authoritative everywhere else) and DEDUPE: the
  // same label can arrive from two branches (a family subcommand AND a
  // nested topic, e.g. '/review code') — a duplicate breaks the
  // single-exact-match Enter rule, turning a submit into an accept+space.
  const seen = new Set();
  const items = [...rawItems]
    .sort((a, b) => a.label.localeCompare(b.label))
    .filter(it => (seen.has(it.label) ? false : (seen.add(it.label), true)));
  const open = items.length > 0;
  const sel = Math.max(0, Math.min(selected, Math.max(0, items.length - 1)));
  const w = width > 0 ? width : style.termWidth();
  const budget = maxRows > 0 ? maxRows : autoMaxRows();
  return {
    items,
    selected: sel,
    replaceFrom,
    lines: open ? renderItems(items, sel, budget, w) : [],
    open,
  };
}

function autoMaxRows() {
  const rows = process.stdout.rows || process.stderr.rows || 24;
  return Math.max(3, Math.min(14, rows - 10));
}

/** Plain-text word wrap (descriptions carry no ANSI of their own). */
function wrapPlain(text, w) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out = [];
  let cur = '';
  for (const word of words) {
    if (cur.length === 0) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += ' ' + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out;
}

function padVis(s, w) {
  const vis = style.visibleWidth(s);
  return vis >= w ? s : s + ' '.repeat(w - vis);
}

function renderItems(items, selected, maxRows, width) {
  const narrow = width < NARROW_W;
  const hideDesc = width < HIDE_DESC_W;
  // Dynamic label column (wide layout only): pad to the ACTUAL longest label
  // instead of a fixed 30, so medium terminals get real description room.
  const labelCol = narrow || hideDesc ? 0
    : Math.max(12, Math.min(DESC_COL, Math.max(...items.map(it => style.visibleWidth(it.label))) + 2));
  const descW = hideDesc ? 0 : Math.max(10, width - (narrow ? 6 : labelCol) - 4);
  // Pre-render each item as 1..N lines. The selection is ALWAYS marked with
  // the non-color '❯' glyph — color only enhances it, so NO_COLOR terminals
  // still show WHICH row Enter will accept.
  const mark = (sel) => (sel ? '❯ ' : '  ');
  const blocks = items.map((it, i) => {
    const sel = i === selected;
    const label = (sel ? style.accent(style.bold(it.label)) : style.muted(it.label));
    if (hideDesc) return [mark(sel) + label];
    if (narrow) {
      // Stacked: label row, description indented on the row(s) below.
      const desc = wrapPlain(it.description || '', descW);
      return [mark(sel) + label, ...desc.map(d => style.dim('    ' + d))];
    }
    const desc = wrapPlain(it.description || '', descW);
    const first = padVis(mark(sel) + label, labelCol) + style.dim(desc[0] || '');
    return [first, ...desc.slice(1).map(d => ' '.repeat(labelCol) + style.dim(d))];
  });
  // Window by LINES: start at item 0, advance until the selected item fits.
  let start = 0;
  const linesOf = (from, to) => blocks.slice(from, to).reduce((a, b) => a + b.length, 0);
  while (selected > start && linesOf(start, selected + 1) > maxRows) start++;
  const lines = [];
  let used = 0;
  let end = start;
  for (let i = start; i < blocks.length && used + blocks[i].length <= maxRows; i++) {
    lines.push(...blocks[i]);
    used += blocks[i].length;
    end = i + 1;
  }
  // Hidden-count hint, DIRECTION-AWARE: at the first row everything hidden is
  // below ('↓ N more'); mid-list both ('↑ a · ↓ b'). A wrong arrow misleads
  // spatial navigation more than no hint at all.
  const above = start;
  const below = items.length - end;
  if (above > 0 || below > 0) {
    const parts = [];
    if (above > 0) parts.push(`↑ ${above} more`);
    if (below > 0) parts.push(`↓ ${below} more`);
    lines.push(style.dim(`  ${parts.join(' · ')}`));
  }
  return lines;
}

/**
 * Ctrl+R incremental history search menu: entries filtered by a substring of
 * the current buffer (most recent first). The window FOLLOWS THE SELECTION
 * (start/end computed like the completion menu) so the ❯ marker and Enter's
 * target are always on screen; hidden counts are direction-aware. Entry
 * truncation is grapheme-aware via truncateVisible (CJK/emoji safe).
 */
export function historyMenu(query, entries, { selected = 0, maxRows = 8, width = 0 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const hits = [];
  for (let i = entries.length - 1; i >= 0 && hits.length < 50; i--) {
    const e = entries[i];
    if (e == null) continue;
    if (!q || String(e).toLowerCase().includes(q)) hits.push(String(e));
  }
  const open = hits.length > 0;
  const sel = Math.max(0, Math.min(selected, Math.max(0, hits.length - 1)));
  const w = width > 0 ? width : style.termWidth();
  // Window: show the selection with as much following context as fits.
  const start = Math.max(0, Math.min(sel, hits.length - maxRows));
  const visible = hits.slice(start, start + maxRows);
  const rows = visible.map((h, i) => {
    const isSel = start + i === sel;
    const shown = style.truncateVisible(h, Math.max(8, w - 4));
    return (isSel ? '❯ ' : '  ') + (isSel ? style.accent(style.bold(shown)) : style.muted(shown));
  });
  const above = start;
  const below = hits.length - (start + visible.length);
  const parts = [];
  if (above > 0) parts.push(`↑ ${above} more`);
  if (below > 0) parts.push(`↓ ${below} more`);
  if (parts.length > 0) rows.push(style.dim(`  ${parts.join(' · ')}`));
  // Header: compact form for narrow screens (the full sentence alone is 43
  // columns and would just get truncated below ~45).
  const header = w < 45
    ? '  ↻ enter pick · esc close'
    : '  ↻ history search · enter pick · esc close';
  return {
    items: hits,
    selected: sel,
    lines: open ? [style.dim(header), ...rows] : [],
    open,
  };
}

/**
 * Move the selection; wraps around.
 * @returns {number} new selected index
 */
export function moveSelection(items, selected, dir) {
  const n = items.length;
  if (n === 0) return 0;
  return (selected + dir + n) % n;
}
