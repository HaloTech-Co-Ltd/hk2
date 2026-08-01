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
 * Persistent bottom status bar.
 *
 * Pins a one-line status to the bottom of the terminal using an ANSI scroll
 * region. Lines 1..(rows-1) become the scrolling workspace where the prompt,
 * agent output, and tool logs land normally; line `rows` is reserved for the
 * status bar and is rewritten whenever `update()` is called.
 *
 * Lifecycle:
 *   const bar = new StatusBar(process.stderr);
 *   if (bar.isEnabled()) { bar.start(); bar.update(state); ...; bar.stop(); }
 *
 * `state` is anything with a `format()` function returning a single-line
 * string; we call it on every update so callers don't need to track state.
 *
 * Caveats:
 *   - Only enabled in TTY mode (interactive REPL). Skipped when stdin/stderr
 *     is piped, when TERM is "dumb", or when terminal rows can't be read.
 *   - On SIGWINCH (terminal resize) the scroll region is re-established.
 *   - On stop() the scroll region is reset to the full screen.
 */

import { truncateVisible } from './style.js';

export class StatusBar {
  constructor(stream = process.stderr, opts = {}) {
    this.stream = stream;
    this.enabled = !!stream?.isTTY && process.env.TERM !== 'dumb';
    this.formatter = opts.formatter || (() => '');
    // Optional multi-line block rendered JUST ABOVE the one-line status bar.
    // When `planRenderer` returns a non-empty array of strings, the scroll
    // region is shrunk by that many lines so those lines are reserved as a
    // pinned plan-progress panel; the status line stays on the very bottom.
    // Only meaningful in TTY mode (interactive REPL) along with the bar.
    this.planRenderer = opts.planRenderer || (() => []);
    this._resizeHandler = null;
    this._interval = null;
    this._started = false;
    // Cached visible-line count of the last rendered plan block, so the
    // scroll region can be re-established when it changes (0 -> N or N -> M).
    this._planLineCount = 0;
  }

  /**
   * Swap the plan-block renderer at runtime (e.g. when a plan is confirmed
   * or cleared). Re-establishes the scroll region so the reserved lines
   * appear / disappear immediately. Pass null/undefined to clear.
   */
  setPlanRenderer(fn) {
    this.planRenderer = typeof fn === 'function' ? fn : (() => []);
    this._applyScrollRegion(true);
  }

  isEnabled() { return this.enabled; }

  start() {
    if (!this.enabled || this._started) return;
    this._started = true;
    this._resizeHandler = () => this._applyScrollRegion(true);
    process.stdout.on('resize', this._resizeHandler);
    // Also re-draw on SIGWINCH (some terminals emit it on resize)
    process.on('SIGWINCH', this._resizeHandler);
    this._applyScrollRegion(true);
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
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    // Reset scroll region to full screen and clear the bottom region we
    // previously reserved (1 status line + any pinned plan lines).
    const rows = this._rows();
    const bottomFrom = Math.max(1, rows - this._planLineCount);
    this._write(`\x1b[1;${rows}r`);
    for (let r = bottomFrom; r <= rows; r++) {
      this._write(`\x1b[${r};1H\x1b[2K`);
    }
    // Move cursor to a sane position (bottom-1)
    this._write(`\x1b[${Math.max(1, rows - 1)};1H\n`);
    this._planLineCount = 0;
  }

  /**
   * Redraw the pinned plan block (if any) plus the status bar at the bottom.
   * Safe to call any time; no-op if not enabled or not started.
   *
   * Layout (bottom up), when a plan block is active:
   *   rows - planLines         .. rows - 1   -> plan block lines
   *   rows                               -> one-line status bar
   * The scroll region is rows-1-planLines so agent output / the prompt never
   * overwrite the reserved block. When no plan block is active this is
   * identical to the legacy behaviour: 1 reserved status line on row `rows`.
   */
  update() {
    if (!this.enabled || !this._started) return;
    const rows = this._rows();
    const planLines = this._renderPlanLines();
    const planCount = planLines.length;
    const prevCount = this._planLineCount;
    // If the plan block's height changed, the reserved scroll region must be
    // re-established before we draw, otherwise old lines linger above.
    const grew = planCount > prevCount;
    if (planCount !== prevCount) {
      this._planLineCount = planCount;
      this._applyScrollRegion(false);
    }
    const text = this._render();
    // When the block SHRANK (e.g. last step done -> cleared, or a step's
    // strategy sub-line disappeared), the rows just released above the new
    // smaller block still show stale text. Clear the full former reserved
    // region before redrawing so no ghost lines remain.
    const clearFrom = Math.min(rows - prevCount, rows - planCount);
    // Clear + rewrite the whole reserved region (plan block + status line).
    // \x1b7 saves cursor; we move to the first reserved row, clear each line,
    // write plan lines, then write the status line on the very bottom.
    const firstRow = rows - planCount;
    let seq = '\x1b7';
    for (let r = clearFrom; r <= rows; r++) {
      seq += `\x1b[${r};1H\x1b[2K`;
    }
    for (let i = 0; i < planCount; i++) {
      const r = firstRow + i;
      seq += `\x1b[${r};1H${planLines[i]}`;
    }
    seq += `\x1b[${rows};1H${text}`;
    // On a GROW transition the cursor we just saved with \x1b7 can now sit
    // inside the newly reserved plan block: it was at the bottom of the old,
    // larger workspace (e.g. right after the plan-confirmation "Choose"
    // prompt). Restoring it there (\x1b8) would make the subsequent spinner /
    // streaming output overwrite the pinned block, so the confirmation text
    // lingers while execution output renders above it. Instead park the
    // cursor at the bottom of the NEW scroll workspace so output lands above
    // the block and the stale menu scrolls away naturally. Steady-state and
    // shrink transitions keep the save+restore so the 500ms poll doesn't
    // move the user's cursor.
    if (grew) {
      const scrollBottom = Math.max(1, rows - 1 - planCount);
      seq += `\x1b[${scrollBottom};1H`;
    } else {
      seq += '\x1b8';
    }
    this._write(seq);
  }

  /**
   * Optionally poll-refresh every `ms` (useful to refresh elapsed time during
   * streaming). Pass 0 to stop polling.
   */
  poll(ms) {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    if (ms > 0 && this.enabled && this._started) {
      this._interval = setInterval(() => this.update(), ms);
    }
  }

  _applyScrollRegion(redraw = false) {
    const rows = this._rows();
    // Reserve 1 status line + any pinned plan lines at the bottom. The
    // scrolling workspace is rows 1..(rows - 1 - planLineCount).
    const reserved = 1 + this._planLineCount;
    const scrollBottom = Math.max(1, rows - reserved);
    // Set scroll region; cursor home inside the region.
    this._write(`\x1b[1;${scrollBottom}r`);
    if (redraw) this.update();
  }

  _rows() {
    return process.stdout.rows || process.stderr.rows || 24;
  }

  _cols() {
    // Prefer the bar's own stream (stderr TTY) so the width matches the
    // terminal we actually draw into, even when stdout is piped.
    return this.stream?.columns || process.stdout.columns || process.stderr.columns || 80;
  }

  /**
   * Render the plan-progress block as an array of visible lines (no trailing
   * newlines). Each line is truncated to the terminal's visible width so the
   * pinned block never wraps and pushes the status line off-screen. Returns []
   * when there is no active plan.
   */
  _renderPlanLines() {
    try {
      const raw = this.planRenderer ? this.planRenderer() : [];
      if (!Array.isArray(raw) || raw.length === 0) return [];
      const cols = this._cols();
      const out = [];
      for (const ln of raw) {
        const one = String(ln ?? '').replace(/\n/g, ' ').trimEnd();
        out.push(truncateVisible(one, cols));
      }
      // Drop trailing empty lines so the block is tight.
      while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
      return out;
    } catch {
      return [];
    }
  }

  _render() {
    try {
      const text = this.formatter() || '';
      // Single line, no trailing newline. Truncate to the terminal's VISIBLE
      // width using an ANSI-aware helper. The formatter returns a colored
      // string whose raw byte length (with escape sequences) is ~4-5x its
      // visible width; slicing that raw string cut through color escapes and
      // multi-byte glyphs, which produced garbled bars - stray `..` / `??`,
      // or a blank line (no bar) when the slice landed inside leading
      // escapes and left zero visible characters.
      const cols = this._cols();
      const oneLine = String(text).replace(/\n/g, ' ').trim();
      return truncateVisible(oneLine, cols);
    } catch {
      return '';
    }
  }

  _write(s) {
    try { this.stream.write(s); } catch { /* ignore */ }
  }
}

export default StatusBar;
