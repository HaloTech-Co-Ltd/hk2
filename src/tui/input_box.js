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
 * InputBox — the Claude Code-style bottom input box, as a PURE widget.
 *
 * No TTY, no stream, no timers: everything is a reducer over an immutable
 * state plus string-returning render/layout helpers, so the whole editor
 * (CJK-aware wrapping, cursor math, history, backslash continuation) is
 * unit-testable without a terminal. The Frame (M5) draws render()'s lines
 * into the reserved bottom region and positions the real terminal cursor
 * at cursorScreen()'s cell; the key loop (M6) feeds normalizeKey() results
 * into applyKey().
 *
 * Buffer model: `lines` are logical lines (real '\n' allowed — this replaces
 * the readline-era pendingDraft workaround). The cursor is `row` (logical
 * line index) + `col` (CODE POINT offset within that line). All edits go
 * through Array.from() so surrogate pairs (emoji) move and delete as one
 * character. Wrapping/cursor math uses style.charWidth — the same table
 * visibleWidth() uses — and never splits a 2-column glyph across visual
 * rows.
 */
import * as style from '../../lib/agent/style.js';

const DEFAULT_WIDTH = 80;

/** Fresh empty state. width is the CONTENT width (box interior, not terminal width). */
export function initialState({ placeholder = '', width = DEFAULT_WIDTH, maxVisibleRows = 6 } = {}) {
  return {
    lines: [''],
    row: 0,
    col: 0,
    placeholder,
    width,
    maxVisibleRows,
    scrollTop: 0,
    historyIndex: null,
    historyDraft: null,
  };
}

/* ------------------------------------------------------------------ */
/* Wrap layout */

/**
 * Wrap ONE logical line into visual rows at `width` columns.
 * Returns { rows: [{ text, startCol, width }] } where startCol is the code
 * point offset the row starts at. A 2-column glyph that would straddle the
 * right edge moves to the next row whole (never split).
 */
export function layoutLine(line, width) {
  const w = Math.max(1, width | 0);
  const g = style.graphemes(line);
  const rows = [];
  let start = 0;   // grapheme index where the current row starts
  let used = 0;    // columns used in the current row
  for (let i = 0; i < g.length; i++) {
    const cw = style.graphemeWidth(g[i]);
    if (used + cw > w) {
      rows.push({ text: g.slice(start, i).join(''), startCol: start, width: used });
      start = i;
      used = 0;
    }
    used += cw;
  }
  rows.push({ text: g.slice(start).join(''), startCol: start, width: used });
  return { rows };
}

/**
 * Layout the whole buffer: per-line visual rows + absolute visual row of
 * each logical line + the cursor's (visual row, visual column).
 */
export function layout(state, width = state.width) {
  const perLine = state.lines.map(l => layoutLine(l, width));
  const lineRow0 = []; // first visual row index of each logical line
  let total = 0;
  for (const l of perLine) {
    lineRow0.push(total);
    total += l.rows.length;
  }
  // Cursor position within its logical line's rows.
  const cl = perLine[state.row];
  let cursorVisualRow = lineRow0[state.row];
  let cursorVisualCol = 0;
  const colCp = state.col;
  for (const r of cl.rows) {
    if (colCp >= r.startCol && colCp <= r.startCol + style.graphemes(r.text).length) {
      cursorVisualRow = lineRow0[state.row] + (cl.rows.indexOf(r));
      cursorVisualCol = style.graphemes(r.text).slice(0, colCp - r.startCol).reduce((a, c) => a + style.graphemeWidth(c), 0);
      break;
    }
  }
  return { perLine, lineRow0, totalRows: total, cursorVisualRow, cursorVisualCol };
}

/** Cursor cell for the Frame to position the terminal cursor at. */
export function cursorScreen(state, width = state.width) {
  const L = layout(state, width);
  return { row: L.cursorVisualRow, col: L.cursorVisualCol };
}

/* ------------------------------------------------------------------ */
/* Edits (all pure, return new state) */

// Editing operates on GRAPHEME clusters (user-perceived characters), not
// code points: ZWJ emoji families and combining sequences move/delete as
// one unit and are never split mid-cluster.
const cps = (s) => style.graphemes(s);

function clampCursor(st) {
  st.row = Math.max(0, Math.min(st.row, st.lines.length - 1));
  st.col = Math.max(0, Math.min(st.col, cps(st.lines[st.row]).length));
  return st;
}

function clone(st) {
  return { ...st, lines: [...st.lines] };
}

function scrollIntoView(st) {
  const L = layout(st);
  const max = Math.max(1, st.maxVisibleRows);
  if (L.cursorVisualRow < st.scrollTop) st.scrollTop = L.cursorVisualRow;
  if (L.cursorVisualRow >= st.scrollTop + max) st.scrollTop = L.cursorVisualRow - max + 1;
  st.scrollTop = Math.max(0, st.scrollTop);
  return st;
}

function insertText(st, text) {
  const chunks = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (let k = 0; k < chunks.length; k++) {
    const parts = cps(st.lines[st.row]);
    st.lines[st.row] = [...parts.slice(0, st.col), ...cps(chunks[k]), ...parts.slice(st.col)].join('');
    st.col += cps(chunks[k]).length;
    if (k < chunks.length - 1) {
      // more chunks follow: split the line at the cursor and continue below
      const cur = cps(st.lines[st.row]);
      st.lines[st.row] = cur.slice(0, st.col).join('');
      st.lines.splice(st.row + 1, 0, cur.slice(st.col).join(''));
      st.row += 1;
      st.col = 0;
    }
  }
  return st;
}

function isEmpty(st) {
  return st.lines.length === 1 && st.lines[0] === '';
}

function bufferText(st) {
  return st.lines.join('\n');
}

/** Replace the whole buffer (paste, history recall); cursor to the end.
 * History navigation passes {resetHistory:false} and stamps the fields itself. */
export function setText(st, text, { resetHistory = true } = {}) {
  const next = clone(st);
  next.lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  next.row = next.lines.length - 1;
  next.col = cps(next.lines[next.row]).length;
  if (resetHistory) {
    next.historyIndex = null;
    next.historyDraft = null;
  }
  return scrollIntoView(clampCursor(next));
}

/** Whole buffer as one string (for submit echo / transcript). */
export function text(st) {
  return bufferText(st);
}

/* ------------------------------------------------------------------ */
/* History */

function historyPrev(st, entries) {
  if (!entries || entries.length === 0) return st;
  let index, draft;
  if (st.historyIndex === null) {
    draft = bufferText(st);
    index = entries.length - 1;
  } else if (st.historyIndex > 0) {
    index = st.historyIndex - 1;
    draft = st.historyDraft;
  } else {
    return st; // already at the oldest entry
  }
  const n = setText(st, entries[index], { resetHistory: false });
  n.historyIndex = index;
  n.historyDraft = draft;
  return n;
}

function historyNext(st, entries) {
  if (st.historyIndex === null) return st;
  if (st.historyIndex < entries.length - 1) {
    const index = st.historyIndex + 1;
    const n = setText(st, entries[index], { resetHistory: false });
    n.historyIndex = index;
    n.historyDraft = st.historyDraft;
    return n;
  }
  const draft = st.historyDraft ?? '';
  const n = setText(st, draft, { resetHistory: false });
  n.historyIndex = null;
  n.historyDraft = null;
  return n;
}

/* ------------------------------------------------------------------ */
/* Word delete */

function deleteWordBefore(st) {
  const parts = cps(st.lines[st.row]);
  if (st.col === 0) {
    if (st.row === 0) return st;
    const prev = st.lines[st.row - 1];
    const cur = st.lines[st.row];
    const n = clone(st);
    n.lines.splice(st.row - 1, 2, prev + cur);
    n.row -= 1;
    n.col = cps(prev).length;
    return clampCursor(n);
  }
  let i = st.col;
  // skip trailing whitespace, then the word run
  while (i > 0 && /\s/.test(parts[i - 1])) i -= 1;
  const wordChar = i > 0 ? (/\s/.test(parts[i - 1]) ? null : parts[i - 1]) : null;
  if (wordChar !== null && /[\w]/.test(wordChar)) {
    while (i > 0 && /[\w]/.test(parts[i - 1])) i -= 1;
  } else if (wordChar !== null) {
    while (i > 0 && !/\s/.test(parts[i - 1]) && !/[\w]/.test(parts[i - 1])) i -= 1;
  }
  const n = clone(st);
  n.lines[n.row] = [...parts.slice(0, i), ...parts.slice(st.col)].join('');
  n.col = i;
  return n;
}

/* ------------------------------------------------------------------ */
/* The reducer */

/**
 * Apply one normalized key. Returns { state, submitted?, exit? }:
 *   submitted — set when Enter submits: the whole buffer text ('\n'-joined)
 *   exit      — set true on ctrl+d with an EMPTY buffer (caller exits)
 * Tab / Escape are NOT consumed here (the completion menu / interrupt
 * precedence owns them); the reducer returns the state unchanged.
 *
 * opts.history: string[] of past entries (newest last), read-only.
 */
export function applyKey(state, key, opts = {}) {
  if (!key || key.type === 'unknown' || key.type === 'tab' || key.type === 'escape'
      || key.type === 'paste-start' || key.type === 'paste-end') {
    return { state };
  }
  const history = opts.history || [];

  const moved = (st) => scrollIntoView(clampCursor(st));

  switch (key.type) {
    case 'char': {
      const n = clone(state);
      insertText(n, key.text);
      return { state: moved(n) };
    }
    case 'newline': {
      const n = clone(state);
      const parts = cps(n.lines[n.row]);
      n.lines[n.row] = parts.slice(0, n.col).join('');
      n.lines.splice(n.row + 1, 0, parts.slice(n.col).join(''));
      n.row += 1;
      n.col = 0;
      return { state: moved(n) };
    }
    case 'enter': {
      // Empty buffer: never submit an empty turn.
      if (isEmpty(state)) return { state };
      // Backslash continuation (the documented REPL contract): a line ending
      // in '\' (and not a slash command) continues instead of submitting —
      // strip the backslash and open the next line for editing.
      const cur = state.lines[state.row];
      const isLast = state.row === state.lines.length - 1;
      if (isLast && cur.endsWith('\\') && !state.lines[0].startsWith('/')) {
        const n = clone(state);
        const stripped = cps(cur);
        stripped.splice(stripped.length - 1, 1); // remove the backslash
        n.lines[n.row] = stripped.join('');
        n.lines.splice(n.row + 1, 0, '');
        n.row += 1;
        n.col = 0;
        return { state: moved(n) };
      }
      const submitted = bufferText(state);
      const n = initialState({ placeholder: state.placeholder, width: state.width, maxVisibleRows: state.maxVisibleRows });
      return { state: n, submitted };
    }
    case 'backspace': {
      if (state.col > 0) {
        const n = clone(state);
        const parts = cps(n.lines[n.row]);
        n.lines[n.row] = [...parts.slice(0, n.col - 1), ...parts.slice(n.col)].join('');
        n.col -= 1;
        return { state: moved(n) };
      }
      if (state.row > 0) {
        const n = clone(state);
        const prev = n.lines[n.row - 1];
        const prevLen = cps(prev).length;
        n.lines[n.row - 1] = prev + n.lines[n.row];
        n.lines.splice(n.row, 1);
        n.row -= 1;
        n.col = prevLen;
        return { state: moved(n) };
      }
      return { state };
    }
    case 'delete': {
      const parts = cps(state.lines[state.row]);
      if (state.col < parts.length) {
        const n = clone(state);
        n.lines[n.row] = [...parts.slice(0, state.col), ...parts.slice(state.col + 1)].join('');
        return { state: n };
      }
      if (state.row < state.lines.length - 1) {
        const n = clone(state);
        n.lines[n.row] += n.lines[n.row + 1];
        n.lines.splice(n.row + 1, 1);
        return { state: n };
      }
      return { state };
    }
    case 'alt-backspace':
      return { state: moved(deleteWordBefore(state)) };
    case 'left': {
      if (state.col > 0) {
        const n = clone(state);
        n.col -= 1;
        return { state: moved(n) };
      }
      if (state.row > 0) {
        const n = clone(state);
        n.row -= 1;
        n.col = cps(n.lines[n.row]).length;
        return { state: moved(n) };
      }
      return { state };
    }
    case 'right': {
      const parts = cps(state.lines[state.row]);
      if (state.col < parts.length) {
        const n = clone(state);
        n.col += 1;
        return { state: moved(n) };
      }
      if (state.row < state.lines.length - 1) {
        const n = clone(state);
        n.row += 1;
        n.col = 0;
        return { state: moved(n) };
      }
      return { state };
    }
    case 'up': {
      // History navigation from the FIRST visual row (even a wrapped line);
      // otherwise move one visual row up.
      const L = layout(state);
      if (L.cursorVisualRow === 0) {
        return { state: historyPrev(state, history) };
      }
      const n = clone(state);
      visualMove(n, L, -1);
      return { state: moved(n) };
    }
    case 'down': {
      // History forward-navigation from the LAST visual row; otherwise move
      // one visual row down.
      const L = layout(state);
      if (L.cursorVisualRow >= L.totalRows - 1) {
        return { state: historyNext(state, history) };
      }
      const n = clone(state);
      visualMove(n, L, +1);
      return { state: moved(n) };
    }
    case 'home': {
      const n = clone(state);
      n.col = 0;
      return { state: moved(n) };
    }
    case 'end': {
      const n = clone(state);
      n.col = cps(n.lines[n.row]).length;
      return { state: moved(n) };
    }
    case 'ctrl': {
      switch (key.ch) {
        case 'a': return applyKey(state, { type: 'home' }, opts);
        case 'e': return applyKey(state, { type: 'end' }, opts);
        case 'd': {
          if (isEmpty(state)) return { state, exit: true };
          return applyKey(state, { type: 'delete' }, opts);
        }
        case 'k': {
          const n = clone(state);
          n.lines[n.row] = cps(n.lines[n.row]).slice(0, n.col).join('');
          return { state: n };
        }
        case 'u': {
          const n = clone(state);
          n.lines[n.row] = cps(n.lines[n.row]).slice(n.col).join('');
          n.col = 0;
          return { state: n };
        }
        case 'w':
          return { state: moved(deleteWordBefore(state)) };
        default:
          return { state };
      }
    }
    default:
      return { state };
  }
}

/** Move the cursor one visual row up/down, keeping the visual column. */
function visualMove(st, L, dir) {
  const targetVisualRow = L.cursorVisualRow + dir;
  // Find the logical line + row segment containing the target visual row.
  for (let li = 0; li < L.perLine.length; li++) {
    const r0 = L.lineRow0[li];
    const rowCount = L.perLine[li].rows.length;
    if (targetVisualRow >= r0 && targetVisualRow < r0 + rowCount) {
      const seg = L.perLine[li].rows[targetVisualRow - r0];
      st.row = li;
      // Snap to the closest code point at/before the visual column.
      const segCps = cps(seg.text);
      let vis = 0, cp = 0;
      while (cp < segCps.length && vis < L.cursorVisualCol) {
        vis += style.charWidth(segCps[cp].codePointAt(0));
        if (vis > L.cursorVisualCol) break;
        cp += 1;
      }
      st.col = seg.startCol + cp;
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Render */

/**
 * The visible window of wrapped row texts (after maxVisibleRows windowing),
 * for chrome that draws its own frame around the editable rows (the TUI's
 * open-rules layout). Aligned with render()'s windowing.
 */
export function visibleRows(st, width = st.width) {
  const L = layout(st, width);
  const max = Math.max(1, st.maxVisibleRows);
  const from = Math.min(st.scrollTop, Math.max(0, L.totalRows - max));
  const all = L.perLine.flatMap(l => l.rows);
  return all.slice(from, Math.min(all.length, from + max)).map(r => r.text);
}

/**
 * Render the box as styled lines: top border (title + `· N lines` tag when
 * multi-line) + the visible window of visual rows + bottom border. The real
 * terminal cursor is placed by the Frame at cursorScreen(); no fake cursor
 * glyph is drawn. `width` is the OUTER box width (borders included).
 */
export function render(state, width = state.width + 2, { title = 'hk2', token = 'border' } = {}) {
  const contentW = Math.max(4, width - 2);
  const L = layout(state, contentW);
  const lines = [];
  const multi = state.lines.length > 1;
  const boxTitle = multi ? `${title} ${style.dim(`· ${state.lines.length} lines`)}` : title;
  lines.push(style.topBorder(boxTitle, { width, token }));
  const max = Math.max(1, state.maxVisibleRows);
  const from = Math.min(state.scrollTop, Math.max(0, L.totalRows - max));
  const allRows = L.perLine.flatMap(l => l.rows);
  const empty = isEmpty(state);
  for (let i = from; i < Math.min(allRows.length, from + max); i++) {
    const rowText = empty ? '' : allRows[i].text;
    const body = empty && i === from
      ? style.italic(style.dim(state.placeholder || ''))
      : rowText;
    lines.push(style.bodyLine(body, { width, token }));
  }
  lines.push(style.bottomBorder({ width, token }));
  return lines;
}
