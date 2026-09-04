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
import { looksLikeSlashCommand } from '../slash_command.js';

/**
 * Heuristic multi-line input collector - a FALLBACK for terminals that do not
 * support (or do not forward) DECSET 2004 bracketed paste mode.
 *
 * Why this exists
 * ---------------
 * `lib/agent/paste.js` (PasteHandler) is the authoritative mechanism: when the
 * terminal supports bracketed paste, a multi-line paste is wrapped in
 * `\x1b[200~` ... `\x1b[201~` markers and flushed as one message. That path
 * works on xterm / iTerm2 / gnome-terminal / kitty / Alacritty / Windows
 * Terminal / tmux / screen.
 *
 * But some environments never send the markers: older terminal emulators,
 * certain IDE integrated consoles, multiplexers configured to strip the mode,
 * or non-TTY / piped input (where PasteHandler.start() is a no-op). In those
 * cases each pasted line arrives as its own readline `'line'` event with no
 * `paste-start`/`paste-end` framing. The first line fires off as a complete
 * agent turn immediately and the remaining lines queue behind it as stray
 * follow-up turns - the user perceives this as "only the first line is
 * displayed / processed".
 *
 * How it works
 * ------------
 * A human cannot press Enter, type a line, press Enter again within ~40ms.
 * A paste, by contrast, delivers many `\n`-terminated lines in a single tight
 * burst. So: if successive `'line'` events arrive within `PASTE_GAP_MS` of
 * each other, we accumulate them; when the burst ends (no line for
 * `PASTE_GAP_MS`), we flush the accumulated buffer as ONE `\n`-joined message.
 *
 * Safety rails
 * ------------
 *  - Defers entirely to PasteHandler while a bracketed paste is in flight
 *    (`isPasting()`). The two mechanisms never interfere.
 *  - Slash commands (`/...`) are never batched: they flush the pending buffer
 *    immediately and then pass through, so `/help`, `/quit`, `/model ...`
 *    stay single-line and snappy.
 *  - A lone line with a long gap before/after (normal typing) is flushed
 *    immediately as a single-line message - zero behaviour change for the
 *    common case.
 *  - Empty lines mid-burst are preserved (they're part of the pasted text);
 *    a leading empty line in a burst is kept too, since pasted code/logs
 *    commonly start with a blank line.
 *  - `flush()` is idempotent and safe to call from the `close` handler.
 */
export class MultiLineCollector {
  /**
   * @param {object}   opts
   * @param {number}   [opts.gapMs]      Max inter-line gap to count as one
   *                                     paste burst. Default 40ms.
   * @param {() => boolean} [opts.isPasting]  Returns true while a bracketed
   *                                     paste is active (defers to PasteHandler).
   * @param {(text: string) => void} opts.onFlush  Called with the joined text
   *                                     when a burst completes.
   * @param {readline.Interface} [opts.rl]  The readline interface. Used to
   *                                     recover the final line of a paste
   *                                     that had no trailing newline (which
   *                                     readline strands in `rl.line` and
   *                                     never emits as a 'line' event).
   */
  constructor({ gapMs = 40, isPasting = () => false, onFlush, rl = null } = {}) {
    this.gapMs = gapMs;
    this.isPasting = isPasting;
    this.onFlush = onFlush;
    this.rl = rl;
    /** @type {string[]} accumulated lines of the current burst */
    this.buf = null;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** timestamp (ms) of the last accepted line, for gap detection */
    this.lastAt = 0;
    /**
     * Tail-watch state for recovering a stranded last line. After a burst's
     * flush timer fires we can't know whether a trailing unterminated line is
     * still stranded in readline's edit buffer (rl.line) - it produces no
     * 'line' event. A short follow-up sampler inspects rl.line and, if it has
     * gained multiple characters in a single tick (the signature of a
     * coalesced paste burst), snatches it as the burst's final line. Without
     * this, a slow-delivered paste whose last line has no trailing newline
     * silently loses that last line (the gapMs flush timer fires before the
     * last bytes arrive, so nothing recovers them).
     */
    /** @type {NodeJS.Timeout|null} tail-watch interval handle */
    this.tailTimer = null;
    /** Last observed length of rl.line during a tail-watch, for growth-rate
     *  detection. */
    this.tailPrevLen = 0;
    /** How long after a flush to keep sampling for a stranded tail. Generous
     *  vs. gapMs so a throttled terminal still recovers its last line. */
    this.tailMs = Math.max(150, this.gapMs * 4);
    /** Sampling interval for the tail-watch. Must be < a typing keystroke gap
     *  (~60-100ms) so a paste burst (chars coalesced into one tick) is seen as
     *  a single multi-char jump, while typing (1 char/keystroke) is seen as
     *  successive +1 growths. */
    this.tailPollMs = 15;
    /** A stranded paste tail arrives as multiple coalesced chars in one tick;
     *  human typing adds one char per keystroke. Snatch only on a jump of at
     *  least this many chars in one poll, so we never steal a half-typed line. */
    this.tailBurstChars = 2;
  }

  /**
   * Ingest one readline `'line'` event. Returns true if the line was consumed
   * (buffered or flushed as part of a burst); false if the caller should
   * handle it immediately. The caller is typically the REPL's `'line'`
   * handler: it first asks PasteHandler, then this collector, then enqueues.
   *
   * @param {string} line
   * @returns {boolean} true if consumed (buffered/flushed), false to pass through
   */
  ingest(line) {
    // Never compete with an active bracketed paste - PasteHandler owns it.
    if (this.isPasting()) return false;

    const now = Date.now();
    const slash = looksLikeSlashCommand(line);

    // A slash command always flushes any pending burst first, then passes
    // through unchanged (slash commands are never multi-line pastes here).
    if (slash) {
      this._flushNow();
      return false;
    }

    const gap = now - this.lastAt;
    const withinBurst = this.buf !== null && gap <= this.gapMs;

    if (withinBurst) {
      // Continuation of an in-flight paste burst.
      this.buf.push(line);
      this._arm();
      this.lastAt = now;
      return true;
    }

    // Not currently bursting. Start a new burst with this line and arm a
    // short timer: if another line arrives within the gap, we'll absorb it
    // (and the first line) into the buffer; if not, the timer flushes this
    // single line. This adds at most `gapMs` of latency to a normal typed
    // line - imperceptible - while letting a paste coalesce.
    this._snatchStranded(); // recover a tail stranded by a prior slow burst
    this.buf = [line];
    this.lastAt = now;
    this._arm();
    return true;
  }

  /** (Re)arm the flush timer for the current burst. */
  _arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._flushNow(), this.gapMs);
  }

  /**
   * Snatch any text stranded in rl.line from a prior burst whose flush timer
   * already fired. When a paste is delivered slowly (>gapMs between lines) and
   * its last line has no trailing newline, readline strands that last line in
   * rl.line and never emits a 'line' event for it - so ingest() never sees it
   * and the burst's flush timer (which fires before the tail arrives) can't
   * recover it.
   *
   * CRITICAL safety: rl.line is non-empty here not only for a stranded paste
   * tail but also when the user has simply started typing the next line without
   * pressing Enter yet. We must not steal a half-typed line. The discriminator
   * is the growth rate: a paste tail is delivered as a coalesced multi-char
   * burst (rl.line jumps by >= tailBurstChars in one tick), while human typing
   * adds one char per keystroke. So snatch ONLY on a multi-char jump. By
   * default `force=false`; pass `force=true` for the close/flush path where any
   * non-empty rl.line is a genuine stranded tail (the REPL is closing).
   *
   * @param {boolean} force  Snatch any non-empty rl.line regardless of growth.
   * @returns {boolean} true if a tail was snatched.
   */
  _snatchStranded(force = false) {
    if (!this.rl || !this.rl.line) { this.tailPrevLen = 0; return false; }
    const tail = this.rl.line;
    if (!force && tail.length - this.tailPrevLen < this.tailBurstChars) {
      // Looks like single-char typing, not a paste burst. Keep watching.
      this.tailPrevLen = tail.length;
      return false;
    }
    this.rl.line = '';
    this.rl.cursor = 0;
    this.tailPrevLen = 0;
    try { this.rl.output?.write?.('\r\x1b[K'); this.rl.prompt(true); }
    catch { /* output gone */ }
    if (this.onFlush) this.onFlush(tail);
    return true;
  }

  /**
   * Arm a short sampling tail-watch that recovers a stranded last line. Polls
   * rl.line every `tailPollMs`; if it jumps by >= tailBurstChars in one poll
   * (a coalesced paste burst), snatches it. Stops after `tailMs` of no snatch.
   */
  _armTail() {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailPrevLen = this.rl ? this.rl.line.length : 0;
    const start = Date.now();
    this.tailTimer = setInterval(() => {
      if (Date.now() - start > this.tailMs) {
        clearInterval(this.tailTimer); this.tailTimer = null; this.tailPrevLen = 0;
        return;
      }
      if (this._snatchStranded(false)) {
        clearInterval(this.tailTimer); this.tailTimer = null;
      }
    }, this.tailPollMs);
  }

  /** Flush whatever is buffered, if anything. Idempotent / null-safe. */
  _flushNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buf === null) {
      // No burst in flight, but a slow paste may have stranded a last line in
      // rl.line after the previous burst flushed. Arm a tail-watch so it is
      // recovered even if no further input arrives.
      this._armTail();
      return;
    }
    // A paste whose final line has no trailing '\n' never emits a 'line'
    // event for that line - readline strands it in its pending edit buffer
    // (rl.line). Without this recovery the last line is silently lost.
    // Snatch it before flushing, then clear readline state and redraw the
    // prompt so the stranded text does not linger on screen. (Mirrors
    // PasteHandler's paste-end handling.)
    //
    // Why this is safe: rl.line is non-empty here ONLY when the last input
    // was unterminated (a paste tail). A normally-typed line clears rl.line
    // on Enter, so a single typed line flushes unchanged.
    if (this.rl && this.rl.line) {
      this.buf.push(this.rl.line);
      this.rl.line = '';
      this.rl.cursor = 0;
      try { this.rl.output?.write?.('\r\x1b[K'); this.rl.prompt(true); }
      catch { /* output gone */ }
    }
    const text = this.buf.join('\n');
    this.buf = null;
    this.lastAt = 0;
    // Arm a tail-watch: if this burst's last line had no trailing newline and
    // arrives AFTER this flush (slow paste), the tailMs timer recovers it.
    this._armTail();
    if (this.onFlush) this.onFlush(text);
  }

  /** Flush any pending burst immediately. Call from the REPL 'close' handler. */
  flush() {
    if (this.tailTimer) { clearInterval(this.tailTimer); this.tailTimer = null; }
    this._flushNow();
    // On close, make a final attempt to recover any tail that stranded after
    // the last flush. force=true: at REPL close any non-empty rl.line is a
    // genuine stranded tail (the user isn't going to keep typing).
    this._snatchStranded(true);
  }
}
