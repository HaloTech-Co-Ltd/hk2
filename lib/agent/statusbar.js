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

import { truncateVisible, visibleWidth } from './style.js';

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
    // Optional one-line input box rendered as the FIRST line of the reserved
    // block — i.e. ABOVE the plan panel and BELOW the status line (when a
    // plan is active; with no plan it sits directly above the status line).
    // While active the caller routes the user's typing here via refreshInputLine()
    // so normal streaming redraws stay away from the in-progress text.
    this.inputRenderer = opts.inputRenderer || (() => []);
    this._resizeHandler = null;
    this._interval = null;
    // Last requested poll cadence. start() re-arms the poll loop from it after
    // a stop()/start() round-trip (SIGTSTP → SIGCONT recovery): without this,
    // a resumed session's spinner refresh AND the slot-probe watchdog stayed
    // dead until the next REPL boot.
    this._pollMs = 0;
    this._started = false;
    // Cached visible-line count of the last rendered plan block, so the
    // scroll region can be re-established when it changes (0 -> N or N -> M).
    this._planLineCount = 0;
    // Cached presence (0 or 1) of the pinned input-box line. Both counts feed
    // the same reserved-block geometry, so grow/shrink transitions and the
    // shrink reflow work identically for the input line and the plan lines.
    this._inputLineCount = 0;
    // Real-cursor docking: while the input box is active the REAL terminal
    // cursor is parked just after the label/draft on the input row (instead
    // of blinking somewhere in the streaming workspace where it misleads).
    // _cursorColFn() -> 1-based visible column for the dock, or null when the
    // cursor must NOT be docked (box off, or an in-run menu owns the input).
    // All docking writes go through _rawWrite (captured BEFORE any stream
    // wrapper is installed by interactive.js) so the StatusBar never fights
    // the write-router that saves/restores the DECSC/DECRC slot.
    this._cursorColFn = null;
    this._rawWrite = typeof stream?.write === 'function' ? stream.write.bind(stream) : null;
    // True while the REAL cursor was last moved INTO the box (docked). Gates
    // undockInputCursor() so a stray DECRC is never emitted while the cursor
    // legitimately lives in the workspace (idle prompt, in-run menu echo).
    this._docked = false;
    // In-run menu state provider (setMenuStateFn): fn() -> { active, prompt,
    // line } while a consumeNext menu owns the input. The resize path uses it
    // to re-emit the menu prompt after the row it was printed on moved.
    this._menuStateFn = null;
    // Terminal rows the LAST paint assumed. A resize that changes the height
    // leaves the previous paint's reserved block at the OLD geometry; on a
    // grow those rows are still on screen (the duplicate mid-screen bar) and
    // update() clears them before repainting at the fresh geometry.
    this._lastRows = 0;
    // Same-tick resize-storm support: trailing re-pass dedupe flag + the
    // in-resize-dispatch marker consulted by patchReadlineRefresh's gate.
    this._resizeQueued = false;
    this._inResizeEvt = false;
    // Anti-flicker paint cache: the exact reserved-block lines (input box,
    // plan panel, status line — top-down) the last paint left on screen, plus
    // the geometry (rows, block size) it assumed. The 200ms poll repaints
    // only rows whose rendered content CHANGED (Pi-style row diffing);
    // anything that can invalidate terminal state unseen by us (readline's
    // ED erases, resizes, suspend/resume, display-sleep) forces a FULL
    // repaint via update({force:true}).
    this._painted = null;
    this._paintedRows = 0;
    this._paintedBlock = 0;
    // Last plausible terminal height (rows > 0). Some pty/terminal states
    // transiently report 0 (display sleep, detach); re-deriving geometry
    // from 0 repaints at a fabricated height and thrashes the scroll region.
    this._lastGoodRows = 0;
    // App-Nap / display-sleep heal support: poll tick timestamps. A gap far
    // wider than the poll interval means the event loop was frozen — the
    // terminal-side state may have drifted while we slept.
    this._lastPollAt = 0;
    // Continuation-slot watchdog (the live-reported fourth defect): while the
    // mid-task input box owns the DECSC slot the router trusts it blindly;
    // any unobserved event that moves the saved cursor into the reserved
    // block makes every routed write replay output ON TOP of the bar/plan
    // rows — the display freezes while the task streams on. The watchdog
    // re-banks the slot at the workspace bottom when drift is proven or
    // unknown. See _slotWatchdog().
    this._slotWatchdogArmed = false;
  }

  /**
   * Direct stream write that BYPASSES any write wrapper installed on the
   * stream by the caller (interactive.js routes workspace writes through a
   * save/restore wrapper while the input box is active). StatusBar drawing
   * must never be re-routed, so it always speaks through this raw channel.
   */
  rawWrite(s) {
    this._write(s);
  }

  /**
   * Register the cursor-dock column provider. fn() returns the 1-based
   * VISIBLE column the real cursor should sit at on the input row (just
   * after the label + the draft text left of the readline cursor), or null
   * when the cursor must stay wherever it is (box inactive, menu active).
   */
  setInputCursorFn(fn) {
    this._cursorColFn = typeof fn === 'function' ? fn : null;
  }

  /**
   * Register the in-run menu state provider: fn() -> { active, prompt, line }.
   * `active` is true while an in-run menu (session.consumeNext — y/N confirms,
   * numeric choices, free-text prompts) owns the input; `prompt` is the exact
   * prompt string to re-emit after a terminal resize moved the row it was
   * printed on; `line` is the user's partial draft (echoed after the prompt).
   * Null/inactive => menus are not considered by the resize / refresh paths.
   */
  setMenuStateFn(fn) {
    this._menuStateFn = typeof fn === 'function' ? fn : null;
  }

  /** Internal: the active menu state, or null when no menu owns the input. */
  _menuState() {
    try {
      const m = this._menuStateFn ? this._menuStateFn() : null;
      return (m && m.active) ? m : null;
    } catch {
      return null;
    }
  }

  /**
   * Cursor-back sequence parking the terminal cursor at the EDIT column (the
   * readline model cursor) after a menu-row redraw. The redraw itself leaves
   * the cursor at END of prompt+line; readline's native refresh would have
   * left it at the model cursor. Every subsequent edit (insert-at-cursor,
   * backspace, arrows) emits RELATIVE cursor moves (\b, CU D) that are only
   * correct when the physical cursor matches the model — a redraw that
   * parked at end-of-line made mid-line edits land in the wrong cells
   * (characters scattered, backspace deleting the wrong column: the
   * plan-confirm custom-input corruption). Width-aware for CJK drafts.
   */
  _menuCursorBack(line, cursor) {
    const s = String(line ?? '');
    const cur = Math.max(0, Math.min(Number.isFinite(cursor) ? cursor | 0 : s.length, s.length));
    const back = visibleWidth(s) - visibleWidth(s.slice(0, cur));
    return back > 0 ? `\x1b[${back}D` : '';
  }

  /**
   * Cursor-park escape sequence for the input row, or null when parking is
   * disabled (box not active / no fn / fn returned null). Shared by
   * refreshInputLine(), update() and the interactive.js write-router so every
   * path parks the real cursor at exactly the same cell.
   */
  parkSeq() {
    if (!this.enabled || !this._started || this._inputLineCount === 0) return null;
    const col = this._cursorColFn ? this._cursorColFn() : null;
    if (col == null) return null;
    const rows = this._rows();
    const r = Math.max(1, rows - this._inputLineCount - this._planLineCount);
    const c = Math.max(1, Math.min(col | 0, this._cols()));
    return `\x1b[${r};${c}H`;
  }

  /** Park the real cursor inside the input box (no-op when not dockable). */
  parkInputCursor() {
    const q = this.parkSeq();
    if (!q) return;
    this._docked = true;
    this._write(q);
  }

  /**
   * Hand the real cursor back to the workspace: restore the DECSC slot (the
   * workspace continuation position). Called when an in-run menu seizes the
   * input (consumeNext armed) so the menu's own prompt + native echo land at
   * the workspace cursor exactly as before the docking feature.
   */
  undockInputCursor() {
    if (!this.enabled || !this._started || !this._docked) return;
    this._docked = false;
    this._write('\x1b8');
  }

  /**
   * After an in-run menu released the input (consumeNext cleared): the real
   * cursor sits wherever the menu's last echo left it (right after the
   * answer). Adopt that as the NEW workspace continuation slot, then re-dock
   * the cursor into the box. No-op when the box is not active.
   */
  reanchorAfterMenu() {
    const park = this.parkSeq();
    if (!park) return;
    this._docked = true;
    this._write(`\x1b7${park}`);
  }

  /**
   * Swap the plan-block renderer at runtime (e.g. when a plan is confirmed
   * or cleared). Re-establishes the scroll region so the reserved lines
   * appear / disappear immediately. Pass null/undefined to clear.
   */
  setPlanRenderer(fn) {
    this.planRenderer = typeof fn === 'function' ? fn : (() => []);
    // Cursor-transparent region re-assert + repaint: the old
    // _applyScrollRegion(true) path homed the cursor via DECSTBM before any
    // save and, when the new renderer kept the SAME line count (steady
    // state), the trailing \x1b8 restored the homed (1,1) position — the
    // same top-of-screen cursor jump as the resize bug.
    this.handleResize();
  }

  /**
   * Patch a readline Interface so its editing redraws cannot blank the
   * reserved block. THE per-Backspace flicker fix.
   *
   * WHY: readline's private _refreshLine() — the redraw behind Backspace,
   * ctrl+w / alt+backspace, history navigation, and mid-line edits — clears
   * the screen with an UNBOUNDED ED (\x1b[0J, erase cursor→end of screen).
   * ED ignores the DECSTBM scroll region, so every editing keystroke wipes
   * this bar (plus any plan/input rows) and they stay blank until the next
   * 200ms poll repaint — a visible flash per keypress. Plain typing at end
   * of line takes readline's fast path (echo the char only, no erase), which
   * is why typing never flickered while Backspace did.
   *
   * FIX: repair synchronously. After each refresh, repaint the whole
   * reserved block in the SAME event-loop tick, so the erase and the repaint
   * land in one terminal frame — no intermediate blank state is ever shown.
   *
   * Fails open: no-op when the bar is disabled/not started, or when the
   * runtime's readline lacks _refreshLine (private surface, same contract as
   * the _writeToOutput wrapper in interactive.js — see its MAINTENANCE note).
   * Returns an uninstall function that restores the original method.
   */
  patchReadlineRefresh(rl, { gate = null } = {}) {
    if (!this.enabled || !this._started) return () => {};
    if (!rl || typeof rl._refreshLine !== 'function') return () => {};
    const orig = rl._refreshLine.bind(rl);
    const gateFn = typeof gate === 'function' ? gate : null;
    rl._refreshLine = (...args) => {
      // GATED (an in-run menu owns the input, or the mid-task input box is
      // echoing): readline's native redraw is both WRONG and DESTRUCTIVE
      // here. It re-prints the MAIN prompt (not the menu prompt) behind an
      // UNBOUNDED ED erase (\x1b[1G\x1b[0J) that ignores the DECSTBM scroll
      // region — and readline also redraws on its OUTPUT stream's 'resize'
      // event, so every terminal resize wiped the y/N confirmation line and
      // everything below it. While a menu is active, redraw its row BOUNDED
      // (CR + EL clears only that row) with the menu prompt + draft; while
      // the input box is echoing, emit nothing (the keypress handler repaints
      // the box row itself).
      if (gateFn && gateFn()) {
        // During a resize dispatch the update() menu branch is the
        // authoritative re-emission (it re-anchors the row); skip the
        // redundant redraw here.
        if (this._inResizeEvt) return;
        const menu = this._menuState();
        if (menu && typeof menu.prompt === 'string' && menu.prompt) {
          const line = typeof menu.line === 'string' ? menu.line : String(rl.line ?? '');
          const cursor = Number.isFinite(menu.cursor) ? menu.cursor
            : (Number.isFinite(rl?.cursor) ? rl.cursor : line.length);
          this._write(`\r\x1b[2K${menu.prompt}${line}${this._menuCursorBack(line, cursor)}`);
        }
        return;
      }
      const r = orig(...args);
      // FORCE: readline's private output just wrote escapes we never see
      // (its \x1b[0J ED erases below-cursor rows, ignoring the scroll
      // region) — the paint cache cannot know what was wiped, so the repair
      // must repaint the whole reserved block, not just changed rows.
      try { this.update({ force: true }); } catch { /* repaint is best-effort */ }
      return r;
    };
    return () => { rl._refreshLine = orig; };
  }

  /**
   * Redraw ONLY the input-box line (the first reserved row) — a cheap
   * targeted repaint used while the user is typing. The 200ms poll
   * repaints the whole reserved block (input + plan + status); this path
   * rewrites just the input row in place so streaming output above never
   * disturbs the in-progress draft. No-op when the box is not active.
   */
  refreshInputLine() {
    if (!this.enabled || !this._started) return;
    const inputLines = this._renderInputLines();
    if (inputLines.length === 0 || this._inputLineCount === 0) return;
    const rows = this._rows();
    const r = rows - this._inputLineCount - this._planLineCount;
    // While the real cursor is DOCKED in the box, repainting the row must end
    // with the dock (not a DECRC \x1b8): a save/restore pair here would leave
    // the cursor wherever it happened to be before the repaint — outside the
    // box — and would also overwrite the DECSC slot the write-router relies
    // on for workspace continuation. Legacy path (no dock) keeps \x1b7/\x1b8.
    const park = this.parkSeq();
    if (park) this._docked = true;
    this._write(`${park ? '' : '\x1b7'}\x1b[${r};1H\x1b[2K${inputLines[0]}${park || '\x1b8'}`);
    // Keep the diff cache coherent: this targeted write changed the input
    // row outside update(), so record it or the next poll would wrongly
    // consider the row already painted / stale.
    if (this._painted && this._painted.length > 0) this._painted[0] = inputLines[0];
  }

  isEnabled() { return this.enabled; }

  start() {
    if (!this.enabled || this._started) return;
    this._started = true;
    this._resizeHandler = () => this.handleResize();
    process.stdout.on('resize', this._resizeHandler);
    // Follow the DRAW stream as well: with stdout redirected (`hk2 >log`)
    // stdout never emits 'resize', but the stream we draw into still does.
    // PREPENDED so we run BEFORE readline's own output-stream 'resize'
    // listener (registered at Interface construction, earlier than start()):
    // our menu-aware repaint re-anchors the in-run menu prompt FIRST, then
    // readline's _refreshLine fires into the gate which skips its own
    // (now redundant) redraw while the resize dispatch is still on the stack.
    this.stream?.prependListener?.('resize', this._resizeHandler)
      || this.stream?.on?.('resize', this._resizeHandler);
    // Also re-draw on SIGWINCH (some terminals emit it on resize)
    process.on('SIGWINCH', this._resizeHandler);
    this.handleResize();
    // Re-arm the recorded poll cadence (see _pollMs): stop() tears the
    // interval down, and a bar restarted after SIGCONT must resume both the
    // spinner refresh and the slot-probe watchdog.
    if (this._pollMs > 0) this.poll(this._pollMs);
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._resizeHandler) {
      process.stdout.off('resize', this._resizeHandler);
      this.stream?.off?.('resize', this._resizeHandler);
      process.off('SIGWINCH', this._resizeHandler);
      this._resizeHandler = null;
    }
    this._resizeQueued = false;
    this._inResizeEvt = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    // Reset scroll region to full screen and clear the bottom region we
    // previously reserved (1 status line + input box + pinned plan lines).
    const rows = this._rows();
    const bottomFrom = Math.max(1, rows - this._planLineCount - this._inputLineCount);
    this._write(`\x1b[1;${rows}r`);
    for (let r = bottomFrom; r <= rows; r++) {
      this._write(`\x1b[${r};1H\x1b[2K`);
    }
    // Move cursor to a sane position (bottom-1)
    this._write(`\x1b[${Math.max(1, rows - 1)};1H\n`);
    this._planLineCount = 0;
    this._inputLineCount = 0;
    this._lastRows = 0;
    this._painted = null;
    this._paintedRows = 0;
    this._paintedBlock = 0;
    this._lastGoodRows = 0;
    this._lastPollAt = 0;
    this._slotCheckCounter = 0;
    // NOTE: _slotProbeFn deliberately SURVIVES stop() — the REPL's SIGCONT
    // recovery restarts a stopped bar and the watchdog's seam (installed once
    // by installSlotProbe) must resume with it. The explicit removal path is
    // the probe's own cleanup fn (session._slotCleanup); a stopped bar can
    // never probe anyway (no interval → no slotTick, and slotProbeResult()
    // ignores results while !_started).
  }

  /**
   * Terminal-resize entry point — what start() wires to 'resize'/SIGWINCH.
   * Emits ONE atomic, cursor-transparent sequence:
   *
   *   \x1b7 (save the user's cursor)  →  \x1b[1;Nr (new region)  →
   *   update() repaint  →  \x1b8 (restore the user's cursor)
   *
   * WHY the save must PRECEDE the region: DECSTBM (\x1b[1;Nr) homes the
   * cursor to (1,1) as a documented side effect. The old resize path
   * (_applyScrollRegion(true) → update()) emitted the region BEFORE any
   * cursor save, so update()'s entry \x1b7 then re-saved the HOMED (1,1)
   * position and its trailing \x1b8 restored THAT — the user's typing
   * cursor jumped to the top row ("cursor jumps to the top of the window"),
   * and readline's next refresh — \x1b[1G\x1b[0J, an ED erase that IGNORES
   * the scroll region — wiped the transcript from row 1 down ("previous
   * output gets overwritten"). Saving first and skipping update()'s own
   * save (skipCursorSave) keeps the DECSC slot holding the pre-resize
   * position across the whole sequence, so the net cursor effect is zero;
   * readline then redraws its prompt at the right row by itself.
   *
   * Docked (mid-task input box armed): the DECSC slot belongs to the
   * WORKSPACE continuation position (saved by armInputBox / the
   * write-router), so the prefix must NOT save over it — exactly like
   * update()'s docked path — and the tail re-docks the visible cursor on
   * the input row at its NEW geometry (parkSeq() recomputes the row).
   */
  handleResize() {
    if (!this.enabled || !this._started) return;
    // Mark the resize dispatch so patchReadlineRefresh's gate can skip its
    // (redundant) menu-row redraw — the update() menu branch below is the
    // authoritative re-emission. Cleared once the dispatch settles.
    this._inResizeEvt = true;
    try {
      this._resizePass();
    } finally {
      if (!this._resizeQueued) {
        this._resizeQueued = true;
        setImmediate(() => {
          this._resizeQueued = false;
          this._inResizeEvt = false;
          if (this.enabled && this._started) this._resizePass();
        });
      } else {
        this._inResizeEvt = false;
      }
    }
  }

  /**
   * Force a full structural repaint: re-assert the scroll region, repaint
   * the whole reserved block, re-derive the cursor tail. `heal` additionally
   * re-banks the DECSC continuation slot at the workspace BOTTOM instead of
   * restoring it — used when the slot itself may be corrupt (display sleep,
   * detach, any state drift we could not observe), where a DECRC restore
   * would resume streaming output at a garbage position and every following
   * frame would overwrite the same wrong rows (the "display frozen mid-task
   * while the task kept running" regression).
   */
  fullRepaint({ heal = false } = {}) {
    if (!this.enabled || !this._started) return;
    this._resizePass({ heal });
  }

  /** One resize pass: cursor-transparent region reset + repaint. */
  _resizePass({ heal = false } = {}) {
    const rows = this._rows();
    const reserved = 1 + this._planLineCount + this._inputLineCount;
    const scrollBottom = Math.max(1, rows - reserved);
    const park = this.parkSeq();
    this._write(`${park ? '' : '\x1b7'}\x1b[1;${scrollBottom}r`);
    // force: a resize (or heal) may have invalidated terminal-side state we
    // cannot observe — always repaint everything, never trust the diff cache.
    this.update({ skipCursorSave: true, force: true, heal });
  }

  /**
   * Redraw the pinned block (input box + plan panel, if active) plus the
   * status bar at the bottom. Safe to call any time; no-op if not enabled
   * or not started.
   *
   * Layout (bottom up), when the full block is active:
   *   rows - 1 - planLines            -> one-line input box (draft echo)
   *   rows - planLines .. rows - 1    -> plan block lines
   *   rows                             -> one-line status bar
   * The scroll region is rows-1-planLines-inputLines so agent output / the
   * prompt never overwrite the reserved block. With neither active this is
   * identical to the legacy behaviour: 1 reserved status line on row `rows`.
   */
  update({ skipCursorSave = false, force = false, heal = false } = {}) {
    if (!this.enabled || !this._started) return;
    let rows = this._rows();
    // Geometry defense: some terminal states transiently report rows 0/1
    // (display sleep, detach probes, pty handoff). Repainting at such a
    // height would fabricate a 1-row screen and thrash the scroll region;
    // keep the last PLAUSIBLE height instead, and paint nothing at all if
    // we never saw one.
    if (rows <= 1) {
      if (this._lastGoodRows > 1) rows = this._lastGoodRows;
      else return;
    }
    this._lastGoodRows = rows;
    const planLines = this._renderPlanLines();
    const inputLines = this._renderInputLines();
    const planCount = planLines.length;
    const inputCount = inputLines.length;
    // The input line and the plan lines form ONE reserved block; transitions
    // (grow / shrink / steady state) and the reflow math operate on the total.
    const blockCount = inputCount + planCount;
    // Cache the new counts BEFORE computing the dock (parkSeq reads
    // _inputLineCount / _planLineCount), the transition flags, and the diff
    // gate below. handleResize() also uses them to size the region.
    const prevBlock = this._inputLineCount + this._planLineCount;
    this._planLineCount = planCount;
    this._inputLineCount = inputCount;
    const grew = blockCount > prevBlock;
    const shrank = blockCount < prevBlock;
    // Terminal HEIGHT changed since the last paint (a resize slipped in
    // between paints). The previous paint's reserved block still sits at the
    // OLD geometry — on a grow those rows are live workspace now and keep
    // showing a stale duplicate bar mid-screen until they scroll away.
    const heightChanged = this._lastRows > 0 && this._lastRows !== rows;
    const text = this._render();
    // Real-cursor dock state, computed ONCE up front: both the row-diff fast
    // path and the full paint below need it, and the diff path must not wait
    // for a declaration further down (TDZ).
    const park = this.parkSeq();
    // Anti-flicker row-diff fast path (Pi-style): when neither geometry nor
    // force/heal applies and the rendered line set has the same shape, only
    // the rows whose CONTENT changed are repainted. The 200ms poll used to
    // wipe + rewrite the whole reserved block every tick (spinner/elapsed on
    // the status line change constantly), so the plan panel flashed on every
    // frame even though its rows were byte-identical — the "plan status bar
    // flickers continuously during execution" report.
    const painted = inputLines.concat(planLines);
    painted.push(text);
    const diffable = !force && !heal && !grew && !shrank && !heightChanged
      && Array.isArray(this._painted) && this._painted.length === painted.length
      && this._paintedRows === rows && this._paintedBlock === blockCount;
    if (diffable) {
      const changed = [];
      for (let i = 0; i < painted.length; i++) {
        if (this._painted[i] !== painted[i]) changed.push(i);
      }
      const firstDiffRow = rows - blockCount;
      const scrollBottom = Math.max(1, rows - 1 - blockCount);
      // Re-assert the scroll region on every paint (self-heal): a terminal
      // reset that cleared DECSTBM silently turns reserved rows into scroll
      // workspace. The leading save (or the docked no-save contract) plus the
      // tail keep the net cursor effect zero, exactly like _resizePass.
      let dseq = park ? '' : '\x1b7';
      dseq += `\x1b[1;${scrollBottom}r`;
      for (const i of changed) {
        const r = firstDiffRow + i;
        dseq += `\x1b[${r};1H\x1b[2K${painted[i]}`;
      }
      if (park) {
        this._docked = true;
        dseq += park;
      } else {
        dseq += '\x1b8';
      }
      this._painted = painted;
      this._lastRows = rows;
      this._write(dseq);
      return;
    }
    // Clear + rewrite the whole reserved region (block + status line).
    // \x1b7 saves cursor; we move to the first reserved row, clear each line,
    // write the block, then write the status line on the very bottom.
    let clearFrom = Math.min(rows - prevBlock, rows - blockCount);
    if (heightChanged) {
      // Also wipe the OLD geometry's reserved rows: after a grow they are
      // ordinary workspace rows still holding the previous status/plan/input
      // paint (the "duplicate status bar in the middle of the screen" bug).
      // After a shrink they are off-screen and the clears are no-ops.
      clearFrom = Math.min(clearFrom, Math.max(1, this._lastRows - prevBlock));
    }
    const firstRow = rows - blockCount;
    // skipCursorSave: the caller (handleResize) already saved the cursor
    // BEFORE the DECSTBM that homes it — saving again here would clobber
    // the slot with the homed position and the trailing \x1b8 would park
    // the cursor at (1,1) (the resize regression).
    let seq = (park || skipCursorSave) ? '' : '\x1b7';
    // SHRINK reflow: when the plan block shrinks mid-turn (notably the last
    // plan_step clearing the block N->0), the scroll workspace grows. Output
    // already written during the smaller-region era sits at fixed terminal
    // rows up to the OLD workspace bottom; restoring the cursor to that stale
    // saved position makes the next writes (final summary / usage) land ON TOP
    // of that prior output -> overlap. To avoid this, on a shrink we scroll the
    // OLD workspace content UP by the number of released rows so it moves into
    // the newly reclaimed area, blanking the bottom of the old region. SU
    // (Scroll Up) scrolls only the rows within the currently set scroll region,
    // so we point it at the OLD region, scroll, then switch to the NEW region.
    if (shrank) {
      const released = prevBlock - blockCount;
      const oldScrollBottom = Math.max(1, rows - 1 - prevBlock);
      seq += `\x1b[1;${oldScrollBottom}r`;   // OLD region
      seq += `\x1b[${released}S`;             // scroll workspace up; bottom rows blank
      seq += `\x1b[1;${Math.max(1, rows - 1 - blockCount)}r`; // NEW (larger) region
    } else if (grew) {
      // On grow the reserved area grows; switch to the new (smaller) region up
      // front so the cleared/drawn rows sit inside it. But FIRST scroll the
      // OLD workspace up by the growth delta (mirroring the shrink reflow):
      // the row the cursor is about to park on — the NEW workspace bottom —
      // is one row below the OLD workspace bottom, which after a turn ended
      // holds the just-submitted prompt line (disarm parked the cursor there,
      // rl.prompt() drew the prompt, and Enter scrolled it up one row).
      // Parking on it let the first spinner frame overwrite the prompt echo
      // ("✓ rewriting query" on top of "hk2(...)> new instruction"). SU in
      // the OLD region shifts that line up out of the way and blanks the row
      // the cursor then lands on, so the spinner starts on a fresh line.
      const delta = blockCount - prevBlock;
      const oldScrollBottom = Math.max(1, rows - 1 - prevBlock);
      seq += `\x1b[1;${oldScrollBottom}r`;   // OLD region (explicit, like shrink)
      seq += `\x1b[${delta}S`;               // scroll old workspace up; bottom blanks
      seq += `\x1b[1;${Math.max(1, rows - 1 - blockCount)}r`; // NEW (smaller) region
    }
    // The SU reflow above scrolled workspace CONTENT up by `n` rows (n = the
    // block delta on a grow/shrink transition), so any cursor position saved
    // earlier (the DECSC slot) now sits `n` rows BELOW its content. Restoring
    // it unchanged would resume output on a blank row, punching a visual hole
    // between the user's echoed instruction and the first spinner frame — the
    // first-instruction-after-boot case, where the slot holds the fresh row
    // right under the echoed instruction, far ABOVE the region bottom. Track
    // the reflow amount so the tail below can adjust the saved slot by the
    // same `n` instead of resetting it to the bottom.
    const reflowed = (grew || shrank) ? Math.abs(blockCount - prevBlock) : 0;
    if (!shrank && !grew && !skipCursorSave) {
      // Steady-geometry full paint WITHOUT a preceding region emission (the
      // readline-repair force path): re-assert the scroll region here — same
      // cursor-neutral save/region contract as the diff path above. When
      // skipCursorSave is set the caller (_resizePass) JUST emitted it.
      seq += `\x1b[1;${Math.max(1, rows - 1 - blockCount)}r`;
    }
    for (let r = clearFrom; r <= rows; r++) {
      seq += `\x1b[${r};1H\x1b[2K`;
    }
    // Input box first (topmost reserved row), then the plan block beneath it,
    // then the status line on the very bottom row.
    if (inputCount > 0) {
      seq += `\x1b[${firstRow};1H${inputLines[0]}`;
    }
    for (let i = 0; i < planCount; i++) {
      const r = firstRow + inputCount + i;
      seq += `\x1b[${r};1H${planLines[i]}`;
    }
    seq += `\x1b[${rows};1H${text}`;
    // Geometry-change tail. Two cases, one invariant: workspace output must
    // resume exactly where its content now lives after the reflow.
    //
    // DOCKED (mid-turn, the box is armed): the DECSC slot holds the REAL
    // continuation position saved by armInputBox / the write-router (e.g. the
    // fresh row right under the user's echoed instruction — which on the
    // first instruction after boot sits far above the workspace bottom). The
    // reflow scrolled that content up `reflowed` rows, so adjust the slot the
    // same way: DECRC (restore) + CUU `reflowed` (cursor up; the terminal does
    // the arithmetic and clamps at the top) + DECSC (re-save), then re-dock
    // the visible cursor into the box. This replaces the old hard reset to
    // the new workspace bottom, which fabricated a multi-row blank gap in
    // exactly this first-instruction case.
    //
    // IN-RUN MENU ACTIVE (an in-run y/N / numeric / free-text prompt owns the
    // input via session.consumeNext): a terminal resize DESTROYED the row the
    // menu prompt was printed on — a shrink clamps the physical cursor (and
    // the surviving content) such that the pre-resize DECSC slot now points
    // INSIDE the reserved block, and our own stale-row wipe clears the old
    // prompt row on a grow. Restoring \x1b8 there parks the cursor on the
    // status line and the next Enter scrolls the whole reserved block up
    // (the "confirm input vanished / status bar duplicated mid-screen" bug).
    // Instead: park the cursor at the NEW workspace bottom, bank THAT as the
    // continuation slot, and re-emit the menu prompt (+draft) on the fresh
    // row so the user can see and answer it. Bounded CR+EL keeps the redraw
    // to that single row.
    //
    // UNDOCKED (box off / legacy geometry change, e.g. a plan growing while
    // no turn is active): there is no tracked slot to adjust, so park the real
    // cursor at the bottom of the NEW scroll workspace — a stale \x1b8 would
    // land inside the newly reserved block (the original grow regression) or
    // on top of reflowed output (the shrink regression). readline redraws its
    // prompt at the real cursor, so parking there stays correct. A pure
    // height change with no menu keeps the \x1b8 restore (cursor-transparent
    // resize — the idle-typing contract).
    const menu = this._menuState();
    if (heal) {
      // HEAL tail: the continuation slot itself may be corrupt (display
      // sleep, detach, SIGSTOP/SIGCONT). Re-bank it at the workspace BOTTOM
      // so streaming output resumes on a fresh row instead of overwriting
      // the same wrong row every frame (the "display frozen mid-task while
      // the task kept running" regression), then re-emit the in-run menu
      // prompt / re-dock the input cursor if either owns the input.
      const scrollBottom = Math.max(1, rows - 1 - blockCount);
      seq += `\x1b[${scrollBottom};1H\x1b7`;
      if (menu && typeof menu.prompt === 'string' && menu.prompt) {
        const line = typeof menu.line === 'string' ? menu.line : '';
        const cursor = Number.isFinite(menu.cursor) ? menu.cursor : line.length;
        seq += `\r\x1b[2K${menu.prompt}${line}${this._menuCursorBack(line, cursor)}`;
      } else if (park) {
        this._docked = true;
        seq += park;
      }
    } else if (grew || shrank || heightChanged) {
      if (park) {
        this._docked = true;
        seq += `\x1b8${reflowed > 0 ? `\x1b[${reflowed}A` : ''}\x1b7${park}`;
      } else if (menu && heightChanged) {
        const scrollBottom = Math.max(1, rows - 1 - blockCount);
        const prompt = typeof menu.prompt === 'string' ? menu.prompt : '';
        const line = typeof menu.line === 'string' ? menu.line : '';
        const cursor = Number.isFinite(menu.cursor) ? menu.cursor : line.length;
        seq += `\x1b[${scrollBottom};1H\x1b7\r\x1b[2K${prompt}${line}${this._menuCursorBack(line, cursor)}`;
      } else if (heightChanged && !grew && !shrank) {
        seq += '\x1b8';
      } else {
        const scrollBottom = Math.max(1, rows - 1 - blockCount);
        seq += `\x1b[${scrollBottom};1H`;
      }
    } else if (park) {
      this._docked = true;
      seq += park;
    } else {
      seq += '\x1b8';
    }
    this._lastRows = rows;
    this._painted = painted;
    this._paintedRows = rows;
    this._paintedBlock = blockCount;
    this._write(seq);
  }

  /**
   * Optionally poll-refresh every `ms` (useful to refresh elapsed time during
   * streaming). Pass 0 to stop polling.
   */
  poll(ms) {
    this._pollMs = ms > 0 ? ms : 0; // recorded so start() can re-arm after stop()
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    if (ms > 0 && this.enabled && this._started) {
      // Continuation-slot watchdog (fourth defect): while the input box is
      // docked, periodically verify the DECSC slot the write-router relies
      // on. Drift here — with a HEALTHY event loop — is exactly the live
      // corruption the screenshot captured: tool-card payloads replay over
      // the reserved rows and the display freezes mid-task until the user
      // interrupts. Cadence: every ~5s (25 polls at 200ms) — cheap enough to
      // never matter, frequent enough to bound the corruption window.
      // (_slotTickForTest lets unit tests drive the cadence synchronously.)
      const slotTick = () => {
        if (this._docked && this._slotProbeFn && (this._slotCheckCounter = (this._slotCheckCounter || 0) + 1) % 25 === 0) {
          const rowsNow = this._rows();
          if (rowsNow > 1) this._slotProbeFn(rowsNow);
        }
      };
      this._slotTickForTest = slotTick;
      this._interval = setInterval(() => {
        const now = Date.now();
        // Freeze detection (App Nap / display sleep / SIGSTOP): a gap far
        // wider than the poll interval means the event loop was frozen and
        // terminal-side state may have drifted unobserved — heal instead of
        // a plain repaint. This is what brings the display back after the
        // monitor wakes while a long task kept streaming into a dead slot.
        const gap = this._lastPollAt > 0 ? now - this._lastPollAt : ms;
        this._lastPollAt = now;
        slotTick();
        if (gap > Math.max(1000, ms * 8)) {
          this.fullRepaint({ heal: true });
          return;
        }
        this.update();
      }, ms);
    }
  }

  /**
   * Install the continuation-slot probe used by the poll watchdog. fn()
   * queries the SAVED DECSC slot (ESC8 + DSR + ESC7 + re-dock) and reports
   * back via slotProbeResult(healthy). interactive.js supplies the stdin
   * isolation-window listener that decodes ESC[r;cR answers; tests can
   * inject a synchronous fake.
   */
  setSlotProbeFn(fn) {
    this._slotProbeFn = typeof fn === 'function' ? fn : null;
  }

  /**
   * Synchronously judge a DSR row against the current geometry: true = the
   * row is inside the scroll workspace (slot healthy), false = inside the
   * reserved block (drift proven), undefined = geometry unknown (rows<=1).
   * Used by interactive.js's isolation-window probe, which must close its
   * stdin window synchronously with the verdict.
   */
  slotProbeHealthyRow(row) {
    const rows = this._rows();
    if (rows <= 1) return undefined;
    const scrollBottom = Math.max(1, rows - 1 - this._planLineCount - this._inputLineCount);
    return Number.isFinite(row) && row >= 1 && row <= scrollBottom;
  }

  /**
   * Receive a decoded DSR row — the row the SAVED DECSC slot pointed at
   * (the probe sequence restores the slot before asking) — and judge it
   * against the current geometry: rows inside the scroll workspace are
   * healthy; rows inside the reserved block prove slot drift (heal).
   */
  slotProbeReport(row) {
    const rows = this._rows();
    if (rows <= 1) return;
    const healthy = this.slotProbeHealthyRow(row);
    if (healthy === undefined) return;
    this.slotProbeResult(healthy, rows);
  }

  /**
   * Consume a slot-probe verdict. `healthy` = the terminal reported the
   * cursor inside the scroll workspace (slot plausible). Anything else —
   * cursor inside the reserved block (drift PROVEN) or no answer (terminal
   * doesn't do DSR; drift UNKNOWN) — conservatively re-banks the slot at
   * the workspace bottom via the full heal path. Re-banking is always safe:
   * worst case the continuation moves to a fresh row (one blank line),
   * never corrupt state. Force skips the diff cache for one paint.
   */
  slotProbeResult(healthy, rowsArg) {
    if (!this.enabled || !this._started) return;
    if (healthy) { this._slotCheckCounter = 0; return; }
    const rows = rowsArg || this._rows();
    if (rows <= 1) return;
    this.fullRepaint({ heal: true });
  }

  _rows() {
    // Prefer the bar's own (DRAW) stream so the region math matches the
    // screen we actually paint on — mirrors _cols(). stdout's rows can lag
    // behind stderr's on a resize (they are separate TTY objects refreshed
    // independently), and reading a stale height painted the bar at the OLD
    // row on the NEW screen (the "status bar mid-screen" bug). A rows value
    // of 0/undefined counts as UNKNOWN (display-sleep transients report 0):
    // fall through to the next source, and only use 24 when NO source knows.
    // update() additionally guards rows<=1 with the last plausible height.
    const r = this.stream?.rows;
    if (r && r > 1) return r;
    if (process.stdout.rows && process.stdout.rows > 1) return process.stdout.rows;
    if (process.stderr.rows && process.stderr.rows > 1) return process.stderr.rows;
    if (this._lastGoodRows > 1) return this._lastGoodRows;
    return 24;
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

  /**
   * Render the input-box line as a 0/1-element array. Unlike the plan block
   * an empty formatted string is still rendered (the box frame '» ...▏' is
   * never empty in practice) — presence alone drives the reserved row, so
   * typing whitespace can never make the row (and the region) thrash.
   */
  _renderInputLines() {
    try {
      const raw = this.inputRenderer ? this.inputRenderer() : [];
      if (!Array.isArray(raw) || raw.length === 0) return [];
      const cols = this._cols();
      const one = String(raw[0] ?? '').replace(/\n/g, ' ');
      return [truncateVisible(one, cols)];
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
    try {
      if (this._rawWrite) this._rawWrite(s);
      else this.stream.write(s);
    } catch { /* ignore */ }
  }
}

export default StatusBar;
