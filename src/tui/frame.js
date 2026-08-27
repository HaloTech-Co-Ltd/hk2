/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频，图表，界面设计、版面框架，有关数据或电子文档等）
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
 * Frame — the TUI's reserved-bottom-region manager. Generalizes the proven
 * StatusBar scroll-region algorithm (lib/agent/statusbar.js: grow/shrink
 * reflow with SU, cursor parking, \x1b7/\x1b8 steady state) from
 * "plan block + status line" to an arbitrary STACK of blocks:
 *
 *   [ modal        ]  (top of the reserved region, closest to the transcript)
 *   [ completion   ]
 *   [ plan panel   ]
 *   [ input box    ]
 *   [ hint row     ]
 *   [ status line  ]  (always the LAST terminal row — the StatusBar contract)
 *
 * Blocks are providers: {name, render() -> string[], cursor?() -> {row, col}}
 * re-queried on every update(). The input box's optional cursor() returns the
 * terminal cell for the REAL cursor (row relative to its own rendered lines,
 * col absolute — the provider adds its own border padding).
 *
 * Single-writer invariant: transcript output goes ONLY through write() /
 * writeLine(), which first parks the cursor at the workspace bottom when it
 * currently sits inside the reserved region. Every draw re-establishes
 * _cursorIn. This is the correctness core: nothing outside update() ever
 * emits cursor-relative ANSI.
 *
 * Render coalescing: requestRender() batches bursts (typing changes the box
 * height on every keystroke) into one redraw per 16ms tick.
 */
import { truncateVisible } from '../../lib/agent/style.js';

export class Frame {
  /**
   * @param {object} stream TTY stream to draw into (stderr by default)
   * @param {{blocks?: Array, rows?: number, cols?: number, animateWhen?: Function}} opts
   *   blocks — ordered TOP→BOTTOM block providers
   *   rows/cols — terminal size override (tests); defaults read from the
   *   process streams like StatusBar.
   *   animateWhen — predicate polled after every state change: while true a
   *   200ms refresh interval runs (footer spinner / elapsed time); while
   *   false the interval STOPS and an idle frame writes NOTHING (no periodic
   *   redraw traffic over SSH, no log bloat, no flicker).
   */
  constructor(stream = process.stderr, { blocks = [], rows = 0, cols = 0, animateWhen = null } = {}) {
    this.stream = stream;
    this.enabled = !!stream?.isTTY && process.env.TERM !== 'dumb';
    this.blocks = blocks;
    this._optsRows = rows > 0 ? rows : 0;
    this._optsCols = cols > 0 ? cols : 0;
    this._animateWhen = animateWhen;
    this._started = false;
    this._prevTotal = 0;
    this._total = 0;
    this._contentRows = 0;   // workspace content rows written since cursorHome()
    this._lastTop = 0;       // row the reserved block was last drawn at
    this._lastTextRow = 0;   // last row that received TEXT (never cleared as stale)
    this._cursorIn = 'workspace';
    this._resizeHandler = null;
    this._animTimer = null;
    this._renderQueued = false;
    this._renderTimer = null;
  }

  isEnabled() { return this.enabled; }

  /** Ordered block stack (top→bottom). Hot-swappable at any time. */
  setBlocks(blocks) {
    this.blocks = blocks || [];
    if (this._started) this.update();
  }

  start() {
    if (!this.enabled || this._started) return;
    this._started = true;
    this._resizeHandler = () => this.update();
    process.stdout.on('resize', this._resizeHandler);
    process.on('SIGWINCH', this._resizeHandler);
    this._applyScrollRegion();
    this.update();
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._resizeHandler) {
      process.stdout.off('resize', this._resizeHandler);
      process.off('SIGWINCH', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._animTimer) { clearInterval(this._animTimer); this._animTimer = null; }
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; this._renderQueued = false; }
    // Reset scroll region to the full screen, clear every row we reserved,
    // and leave the cursor on a fresh line at the bottom of the workspace.
    const rows = this._rows();
    const total = this._total;
    this._write(`\x1b[?25h\x1b[1;${rows}r`);
    const from = this._lastTop > 0 ? this._lastTop : Math.max(1, rows - total + 1);
    for (let r = from; r <= rows; r++) {
      this._write(`\x1b[${r};1H\x1b[2K`);
    }
    this._write(`\x1b[${Math.max(1, rows - 1)};1H\n`);
    this._total = 0;
    this._prevTotal = 0;
    this._hadFirst = false;
    this._contentRows = 0;
    this._lastTop = 0;
    this._lastTextRow = 0;
    this._cursorIn = 'workspace';
  }

  /**
   * Full redraw: recompute every block's lines, reflow the scroll region on
   * height changes (the StatusBar grow/shrink algorithm, generalized from
   * planCount to the summed block height), draw all reserved rows, and place
   * the cursor — at the input box's cell when a block provides one, else
   * parked at the workspace bottom on transitions / restored on steady state.
   */
  update() {
    if (!this.enabled || !this._started) return;
    const rows = this._rows();
    const cols = this._cols();
    // Render + truncate every block; clamp the stack to the available rows
    // (workspace keeps ≥1 row). Overflow drops the TOPMOST lines first so
    // the input box / status line at the bottom always survive.
    const maxReserved = Math.max(0, rows - 1);
    const rendered = this.blocks.map(b => this._renderBlock(b, cols));
    const rawTotal = rendered.reduce((a, l) => a + l.length, 0);
    const drop = Math.max(0, rawTotal - maxReserved);
    const flat = rendered.flat().slice(drop);
    const total = flat.length;
    // Claude Code's boot geometry: while the workspace content is SHORTER
    // than the screen, the reserved block sits directly UNDER the content
    // (blank rows below it); it pins to the bottom only once content fills
    // the screen. pinnedTop is the classic StatusBar position.
    const pinnedTop = Math.max(1, rows - total + 1);
    const top = this._contentRows > 0
      ? Math.min(this._contentRows + 1, pinnedTop)
      : pinnedTop;
    // First paint is steady state, not a grow transition: there is no prior
    // geometry to reflow from (mirrors StatusBar's planCount 0→0 first draw).
    // It also (re)establishes the scroll region itself so update() is
    // self-sufficient even when start() was bypassed.
    let firstPaint = false;
    let prev = this._prevTotal;
    if (!this._hadFirst) {
      this._hadFirst = true;
      prev = total;
      this._prevTotal = total;
      this._lastTop = top; // first paint is steady state, not a move
      firstPaint = true;
    }
    const grew = total > prev;
    const shrank = total < prev;
    this._total = total;
    // GROW into a pinned position: content that no longer fits the smaller
    // workspace must be scrolled UP so the enlarged block covers no content
    // row (Claude Code: opening a large menu pushes the transcript up).
    // Computed BEFORE the contentRows clamp below (which would silently
    // discard the overflow) — see the transition sequence emission further
    // down for the actual SU emission.
    const growPush = (grew && this._contentRows > Math.max(0, rows - total))
      ? this._contentRows - Math.max(0, rows - total)
      : 0;
    // Invariant: content can never exceed the workspace height. Keeps the
    // follow-content geometry correct across terminal RESIZES (a stale
    // over-count from a larger window would pin the block at the bottom of
    // a smaller one, leaving a dead gap between content and input).
    this._contentRows = Math.min(this._contentRows, Math.max(0, rows - total));

    // Cursor collection: the FIRST block with a cursor() whose lines fully
    // survived the clip. cursor() = {row (within its own lines), col
    // (absolute terminal column, border padding included)}.
    let inputCursor = null;
    {
      let acc = 0;
      for (let i = 0; i < this.blocks.length && !inputCursor; i++) {
        const h = rendered[i].length;
        if (this.blocks[i].cursor && h > 0 && acc >= drop) {
          const c = safeCursor(this.blocks[i]);
          if (c && c.row >= 0 && c.row < h) {
            inputCursor = { row: acc - drop + c.row, col: Math.max(0, c.col | 0) };
          }
        }
        acc += h;
      }
    }

    // The scroll region depends ONLY on the stack height (classic StatusBar
    // geometry: 1..rows-total), never on where the block currently draws.
    // While unpinned the block sits higher, but content can never reach the
    // region bottom before the block pins (contentRows clamps to it), so
    // this is safe — and it keeps a trailing '\n' after content from firing
    // a margin scroll one row early (the whole-screen jump bug).
    const regionBottom = Math.max(1, rows - total);
    // Clear stale reserved-block pixels left above the block's new position,
    // but NEVER a row that received TEXT: min(lastTop, top) targets the
    // block's previous span, yet during incremental writes the just-written
    // content row can sit exactly there (boot's line-by-line card), so the
    // floor is the last text row + 1.
    const clearFrom = Math.max(
      this._lastTop > 0 ? Math.min(this._lastTop, top) : top,
      (this._lastTextRow || 0) + 1,
    );
    let seq = firstPaint ? `\x1b[1;${regionBottom}r` : '';
    seq += '\x1b7';
    if (grew || shrank) seq += '\x1b[?25l'; // hide the cursor during reflow
    // GROW into a pinned position: scroll the OLD workspace up by the
    // overflow so the enlarged block covers no content row. The
    // still-active previous region bounds the scroll. SHRINK never scrolls:
    // the region grows, content stays exactly where it is, and stale block
    // pixels are simply cleared.
    if (growPush > 0) {
      seq += `\x1b[${growPush}S`;
      this._lastTextRow = Math.max(0, (this._lastTextRow || 0) - growPush);
    }
    if (grew || shrank || firstPaint) {
      // Height changed (or first paint): re-establish the region.
      seq += `\x1b[1;${regionBottom}r`;
    }
    for (let r = clearFrom; r <= rows; r++) {
      seq += `\x1b[${r};1H\x1b[2K`;
    }
    for (let i = 0; i < flat.length; i++) {
      // \x1b[K (erase-to-EOL) after every block row: rendered rows are
      // often NARROWER than a previous frame's content on the same row
      // (text deleted, menu closed) — without the erase, stale glyphs
      // (stray characters, rule fragments) survive at the row's tail and
      // glue onto the new content.
      seq += `\x1b[${top + i};1H${flat[i]}\x1b[K`;
    }
    // Cursor placement: the input box cell when provided; else StatusBar's
    // parking rules (park on transitions so a stale \x1b8 can't land inside
    // the resized region; restore on steady state).
    if (inputCursor) {
      const r = Math.max(1, Math.min(rows, top + inputCursor.row));
      const c = Math.min(cols, inputCursor.col + 1);
      seq += `\x1b[?25h\x1b[${r};${c}H`;
      this._cursorIn = 'input';
    } else if (grew || shrank || this._lastTop !== top) {
      const scrollBottom = regionBottom;
      seq += `\x1b[?25h\x1b[${scrollBottom};1H`;
      this._cursorIn = 'workspace';
    } else {
      seq += '\x1b8';
      // \x1b8 restores whatever was saved — assume workspace (write() tracks).
      this._cursorIn = this._cursorIn === 'input' ? 'workspace' : this._cursorIn;
    }
    this._prevTotal = total;
    this._lastTop = top;
    this._write(seq);
    this._syncAnimation();
  }

  /**
   * Transcript output into the scroll workspace. Parks the cursor at the
   * workspace bottom first when it is inside the reserved region — the
   * single-writer invariant that keeps streaming output from overwriting
   * the input box.
   */
  write(s) {
    if (!this._started || !this.enabled) { this._write(s); return; }
    const rows = this._rows();
    const regionBottom = Math.max(1, rows - this._total);
    let pre = '';
    if (this._cursorIn !== 'workspace') {
      // Park where new content belongs: right under the existing content,
      // or at the workspace bottom once the screen is full.
      const parkRow = Math.min(this._contentRows + 1, regionBottom);
      pre = `\x1b[${Math.max(1, parkRow)};1H`;
      this._cursorIn = 'workspace';
    }
    // Every INTERIOR newline also takes ownership of the row it moves into:
    // multi-line writes (markdown paragraphs land as 'text\n\n') previously
    // erased only the parked first row — blank lines created by the 2nd '\n'
    // passed over stale block pixels (a ghost '❯' prompt) without erasing.
    // '\n\x1b[2K' erases the target row the instant the cursor arrives; at
    // the pinned region bottom the '\n' scrolls a fresh blank row and the
    // extra 2K is a harmless no-op.
    const str0 = String(s);
    const str = str0.includes('\n') ? str0.replace(/\n/g, '\n\x1b[2K') : str0;
    const n = (str0.match(/\n/g) || []).length;
    const hasText = str.trim().length > 0;
    const parkRow = pre ? Math.min(this._contentRows + 1, regionBottom) : this._contentRows + 1;
    // A parked write STARTS a fresh content line — usually on the row the
    // reserved block's top line still occupies (the block relocates below on
    // the next update). Take full ownership of the row (\x1b[2K) so stale
    // block pixels cannot glue in front of / behind the text, exactly like
    // writeLine. Non-parked writes continue the current line and must NOT
    // erase.
    this._write(pre + (pre ? '\x1b[2K' : '') + str);
    if (hasText) {
      // The last row that received TEXT: text ends before the final newline
      // (writeLine shape 'text\n'), or after it (multi-line writes).
      this._lastTextRow = n > 0 && str.endsWith('\n') ? parkRow + n - 1 : parkRow + n;
    }
    if (n > 0) {
      this._contentRows = Math.min(this._contentRows + n, regionBottom);
      // While the block is not pinned, it must move DOWN under the new
      // content immediately — a deferred render would leave it overlapped.
      if (this._contentRows + this._total < rows) this.update();
    }
  }

  /**
   * write() + a trailing newline, taking FULL ownership of the target row:
   * the row is erased first (\x1b[2K) so stale pixels from a previously
   * drawn reserved block (e.g. the input rule that sat there before the
   * content grew past it) can never bleed through — a bare '\n' only moves
   * the cursor and would leave them visible.
   */
  writeLine(s = '') {
    this.write('\x1b[2K' + s + '\n');
  }

  /**
   * Park the cursor at the TOP of the workspace and mark it in-workspace,
   * so the next write() starts a fresh block at the top of the cleared
   * screen (the boot banner) instead of the workspace bottom. Subsequent
   * write() calls then flow naturally below it — Claude Code's boot shape.
   */
  cursorHome() {
    if (!this._started || !this.enabled) return;
    this._write(`\x1b[1;1H`);
    this._cursorIn = 'workspace';
    this._contentRows = 0;
    this._lastTop = 0;
    this._lastTextRow = 0;
  }

  /** Coalesced redraw: bursts collapse into one update per 16ms. */
  requestRender() {
    if (!this.enabled || !this._started) return;
    if (this._renderQueued) return;
    this._renderQueued = true;
    this._renderTimer = setTimeout(() => {
      this._renderQueued = false;
      this._renderTimer = null;
      this.update();
    }, 16);
  }

  /**
   * Start/stop the 200ms animation refresh from the animateWhen predicate.
   * Called after every update() — busy (spinner spinning) arms the interval,
   * idle tears it down, so a resting frame emits ZERO bytes.
   */
  _syncAnimation() {
    if (!this._animateWhen) return;
    const want = this._started && this.enabled && !!this._animateWhen();
    if (want && !this._animTimer) {
      this._animTimer = setInterval(() => {
        if (!this._animateWhen || !this._animateWhen()) {
          this._stopAnimation();
          return;
        }
        this.update();
      }, 200);
    } else if (!want && this._animTimer) {
      this._stopAnimation();
    }
  }

  _stopAnimation() {
    if (this._animTimer) { clearInterval(this._animTimer); this._animTimer = null; }
  }

  _applyScrollRegion() {
    const rows = this._rows();
    const scrollBottom = Math.max(1, rows - this._total);
    this._write(`\x1b[1;${scrollBottom}r`);
  }

  _rows() {
    return this._optsRows || process.stdout.rows || process.stderr.rows || 24;
  }
  _cols() {
    return this._optsCols || this.stream?.columns || process.stdout.columns || process.stderr.columns || 80;
  }

  _renderBlock(b, cols) {
    const raw = b.render ? b.render() : [];
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out = [];
    for (const ln of raw) {
      const one = String(ln ?? '').replace(/\n/g, ' ').trimEnd();
      out.push(truncateVisible(one, cols));
    }
    while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
    return out;
  }

  _write(s) {
    try { this.stream.write(s); } catch { /* ignore */ }
  }
}

function safeCursor(block) {
  try {
    const c = block.cursor();
    if (c && typeof c.row === 'number' && typeof c.col === 'number') return c;
  } catch { /* optional */ }
  return null;
}

export default Frame;
