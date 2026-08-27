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
 * 商标和商号相关的商誉、设计和专利；与创新，技术诀窍、商业秘密、保密技术、非
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
 * ModalHost — the TUI's prompt queue. Keeps the Promise-based prompt
 * contracts (ctx.confirm / ctx.choose / the turn pipeline's ui.optionList)
 * intact while rendering them as arrow-key modals above the input box.
 *
 * FIFO queue: a knowledgeConfirm can arrive while a slash command's confirm
 * is still open; the old readline `consumeNext` single-slot silently
 * misrouted overlapping prompts — the queue resolves them in order.
 *
 * Semantics preserved from the readline era:
 *   confirm     → true | false ('y'/'n'/arrows+Enter; Esc/Ctrl+D → false)
 *   confirm 3-way → true | false | 'eden' (adds the E row)
 *   optionList  → {index} (0-based) | null on Esc/cancel; 1-9 jump+accept
 *   freeText    → the InputBox itself is captured (see isFreeText); the
 *                 shell routes Enter to the modal instead of submitting
 */
import * as style from '../../lib/agent/style.js';

export class ModalHost {
  constructor() {
    this.queue = []; // [{kind, spec, resolve, selected}]
    this._activeCbs = new Set();
  }

  /**
   * Subscribe to active-prompt changes: the callback fires with the new
   * active() EVERY time a prompt is enqueued or resolved — including when
   * the queue advances to the next one. The shell uses this to hand the
   * input box to a freeText modal THE MOMENT it becomes active (not on the
   * first keypress): the visible editor must already be the modal's empty
   * one when the frame next renders, or Enter-on-first-frame resolves
   * against a stale picture.
   */
  onActive(cb) {
    if (typeof cb === 'function') this._activeCbs.add(cb);
    return () => this._activeCbs.delete(cb);
  }

  _notify() {
    const m = this.active();
    for (const cb of this._activeCbs) {
      try { cb(m); } catch { /* subscriber error must not break the queue */ }
    }
  }

  /** Open a prompt; resolves when answered or cancelled. */
  open(kind, spec = {}) {
    return new Promise((resolve) => {
      const item = { kind, spec, resolve, selected: defaultSelection(kind, spec) };
      this.queue.push(item);
      this._notify();
    });
  }

  /** The currently displayed modal, or null. */
  active() {
    return this.queue[0] || null;
  }

  /** True while a freeText modal owns the input box. */
  isFreeText() {
    return this.active()?.kind === 'freeText';
  }

  /** Resolve the active modal with `value` and advance the queue. */
  _finish(value) {
    const item = this.queue.shift();
    if (item) item.resolve(value);
    this._notify();
  }

  /**
   * Feed one normalized key to the ACTIVE modal. Returns true when the key
   * was consumed (the main loop must not forward it to the InputBox).
   */
  applyKey(key) {
    const m = this.active();
    if (!m || m.kind === 'freeText') return m ? true : false; // freeText: shell owns the keys
    if (!key) return true;
    const optionCount = m.kind === 'optionList'
      ? m.spec.options.length
      : (m.kind === 'confirm' ? confirmOptions(m).length : 0);
    switch (key.type) {
      case 'up':
        if (optionCount > 0) m.selected = Math.max(0, m.selected - 1);
        return true;
      case 'down':
        if (optionCount > 0) m.selected = Math.min(optionCount - 1, m.selected + 1);
        return true;
      case 'enter': {
        if (m.kind === 'optionList') this._finish({ index: m.selected });
        else if (m.kind === 'confirm') this._finish(confirmOptions(m)[m.selected].value);
        return true;
      }
      case 'escape':
        this._finish(m.kind === 'optionList' ? null : false);
        return true;
      default:
        break;
    }
    if (key.type === 'char' && key.text) {
      const t = key.text.toLowerCase();
      if (m.kind === 'confirm') {
        const opts = confirmOptions(m);
        const hit = opts.find(o => o.key === t);
        if (hit) { this._finish(hit.value); return true; }
      } else if (m.kind === 'optionList') {
        const n = parseInt(t, 10);
        if (Number.isInteger(n) && n >= 1 && n <= m.spec.options.length) {
          this._finish({ index: n - 1 });
          return true;
        }
        // y/N quick-answers on a confirm-shaped option list are NOT honored
        // (rows are options, not yes/no).
      }
    }
    if (key.type === 'ctrl' && key.ch === 'd') {
      this._finish(m.kind === 'optionList' ? null : false);
      return true;
    }
    return true; // modal swallows everything else while open
  }

  /** Render the active modal as bordered lines (or [] when none). */
  render(width = 60) {
    const m = this.active();
    if (!m) return [];
    // Body budget inside the card: │ + space + content + space + │, with a
    // little slack so bodyLine() never has to truncate what we wrapped.
    const bodyW = Math.max(10, width - 6);
    const lines = [];
    if (m.kind === 'confirm') {
      const opts = confirmOptions(m);
      for (const ln of wrapVisible(m.spec.text ?? '', bodyW)) lines.push(ln);
      lines.push('');
      for (let i = 0; i < opts.length; i++) {
        const sel = i === m.selected;
        const marker = sel ? style.accent('❯ ') : '  ';
        lines.push(`${marker}${opts[i].label}`);
      }
      lines.push('');
      lines.push(style.dim(hintLine(m, bodyW)));
      return style.card({ title: m.spec.title || 'Confirm', lines, width, token: 'accent' });
    }
    if (m.kind === 'optionList') {
      for (const ln of m.spec.header || []) {
        for (const w of wrapVisible(ln, bodyW)) lines.push(w);
      }
      for (let i = 0; i < m.spec.options.length; i++) {
        const sel = i === m.selected;
        const marker = sel ? style.accent('❯ ') : '  ';
        // Rows and notes are the DECISION CONTENT (strategies, review
        // suggestions) — wrap them like the header instead of letting
        // bodyLine truncate: a cut-off tail can hide the very option text
        // the choice depends on. Continuations align under the text.
        const row = wrapVisible(m.spec.options[i].row ?? '', Math.max(8, bodyW - 2));
        lines.push(marker + (row[0] ?? ''));
        for (const cont of row.slice(1)) lines.push('  ' + cont);
        if (sel && m.spec.options[i].note) {
          const note = wrapVisible(m.spec.options[i].note, Math.max(8, bodyW - 4));
          for (const nl of note) lines.push('    ' + nl);
        }
      }
      lines.push('');
      lines.push(style.dim(hintLine(m, bodyW)));
      return style.card({ title: m.spec.title || 'Choose', lines, width, token: 'accent' });
    }
    if (m.kind === 'freeText') {
      const body = wrapVisible(m.spec.label ?? '', bodyW);
      body.push('');
      body.push(style.dim(hintLine(m, bodyW)));
      return style.card({ title: m.spec.title || 'Input', lines: body, width, token: 'accent' });
    }
    return [];
  }
}

/**
 * Word-wrap `text` to `w` visible columns (grapheme-aware: CJK wide glyphs
 * and ZWJ emoji never split mid-cluster; a word longer than the line is
 * hard-broken at cluster boundaries). Modal QUESTION text must wrap — a
 * truncated prompt hides the very information the decision depends on
 * (what exactly gets deleted / saved / overwritten).
 */
export function wrapVisible(text, w) {
  const str = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!str) return [];
  const out = [];
  let cur = '';
  let curW = 0;
  const place = (piece, pieceW) => {
    const space = cur ? 1 : 0;
    if (curW + space + pieceW <= w) {
      cur += (space ? ' ' : '') + piece;
      curW += space + pieceW;
    } else {
      if (cur) out.push(cur);
      cur = piece;
      curW = pieceW;
    }
  };
  for (const word of str.split(' ')) {
    // ANSI-aware measurement: option rows carry SGR spans (bold numbers,
    // accent names) that occupy ZERO columns. Sequences contain no spaces,
    // so word-splitting never cuts through them.
    const ww = style.visibleWidth(word);
    if (ww <= w) { place(word, ww); continue; }
    // Over-wide word: hard-break at grapheme boundaries. PLAIN words split
    // directly; STYLED words (plan notes arrive dim()-wrapped and CJK text
    // has no spaces, so styled over-wide words are the common case, not the
    // exception) are split with their SGR state tracked and RE-OPENED on
    // every continuation line — otherwise the tail was handed to bodyLine's
    // truncation and the decision content disappeared behind an ellipsis.
    for (const piece of breakWord(word, w)) place(piece.piece, piece.w);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Hard-break one over-wide word (plain or ANSI-styled) into pieces that each
 * fit `w` columns. Escape sequences are zero-width: an opening sequence is
 * remembered and re-emitted after every break; a closing reset is emitted at
 * the break itself so the remainder of the line never inherits the style.
 */
function breakWord(word, w) {
  const pieces = [];
  let piece = '';
  let pieceW = 0;
  const open = []; // active SGR sequences, in order
  const esc = /\x1b\[[0-9;?]*[A-Za-z]/g;
  let m;
  let last = 0;
  const flush = () => {
    if (piece) { pieces.push({ piece, w: pieceW }); piece = ''; pieceW = 0; }
  };
  while ((m = esc.exec(word)) !== null) {
    for (const g of style.graphemes(word.slice(last, m.index))) {
      const gw = style.graphemeWidth(g);
      if (pieceW + gw > w && pieceW > 0) {
        // Close the style at the break, re-open it on the next piece.
        if (open.length > 0) piece += '\x1b[0m';
        flush();
        for (const seq of open) piece += seq;
      }
      piece += g;
      pieceW += gw;
    }
    const seq = m[0];
    piece += seq;
    if (seq === '\x1b[0m') open.length = 0;
    else open.push(seq);
    last = m.index + seq.length;
  }
  for (const g of style.graphemes(word.slice(last))) {
    const gw = style.graphemeWidth(g);
    if (pieceW + gw > w && pieceW > 0) {
      if (open.length > 0) piece += '\x1b[0m';
      flush();
      for (const seq of open) piece += seq;
    }
    piece += g;
    pieceW += gw;
  }
  if (pieceW > 0) pieces.push({ piece, w: pieceW });
  // A word too wide for one column can only happen with w <= 1; emit as-is.
  if (pieces.length === 0) pieces.push({ piece: word, w: style.visibleWidth(word) });
  return pieces;
}

/** Key-hint row at the modal's bottom. Falls back to a compact form when narrow. */
function hintLine(m, w) {
  let hint;
  if (m.kind === 'confirm') {
    hint = `↑↓ select · enter confirm · esc cancel · y/n${m.spec.threeWay ? '/e' : ''}`;
  } else if (m.kind === 'optionList') {
    hint = '↑↓ select · enter confirm · 1-9 jump · esc cancel';
  } else {
    hint = 'enter submit · esc cancel';
  }
  if (style.visibleWidth(hint) > w) {
    hint = m.kind === 'confirm'
      ? `↑↓ · enter · esc · y/n${m.spec.threeWay ? '/e' : ''}`
      : '↑↓ · enter · esc';
  }
  return hint;
}

function confirmOptions(m) {
  const opts = [
    { key: 'y', label: style.success('Yes'), value: true },
    { key: 'n', label: style.errorT('No'), value: false },
  ];
  if (m.spec.threeWay) {
    opts.push({ key: 'e', label: style.warning('Eden (save to Eden instead)'), value: 'eden' });
  }
  return opts;
}

function defaultSelection(kind, spec) {
  if (kind === 'confirm') return 1; // 'No' preselected — the conservative default
  if (kind === 'optionList') {
    // The historical readline menus defaulted Enter to the LAST option (the
    // conservative skip) — mirror that unless an explicit default is given.
    return typeof spec.defaultIndex === 'number' ? spec.defaultIndex : Math.max(0, (spec.options?.length || 1) - 1);
  }
  return 0;
}

export default ModalHost;
