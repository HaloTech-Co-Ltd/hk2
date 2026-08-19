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
 * Progress indicator: shows a spinner + phase + elapsed time during LLM
 * generation (principle / impl / interactive modes).
 *
 * TTY mode: refresh the same line with \r; clear it when the first delta arrives.
 * Non-TTY (piped): print `[phase...]` header only, no spinner.
 *
 * Phase flow:
 *   start(query-rewrite | waiting-for-model) -> rewrite event -> nextPhase(retrieving)
 *   -> first delta -> tick() clears spinner -> stdout stream
 *   -> done() prints final stats
 *
 * Themed via lib/agent/style.js.
 */

import { SPINNER, ICON, accent, muted, dim, success } from '../lib/agent/style.js';

export class ProgressIndicator {
  constructor(stream = process.stderr) {
    this.stream = stream;
    this.isTTY = !!stream.isTTY;
    this.phase = null;
    this.phaseStart = 0;
    this.totalStart = 0;
    this.charCount = 0;
    this.spinnerIdx = 0;
    this.interval = null;
    this.stopped = false;
    // True while a rendered frame (TTY spinner line / non-TTY phase header)
    // sits on the stream WITHOUT a trailing newline. breakLine() uses this to
    // decide whether another writer (ctx.print warnings) needs the line broken
    // first — see breakLine().
    this.midLine = false;
  }

  /** Begin the first phase */
  start(phase) {
    this.totalStart = Date.now();
    this._beginPhase(phase);
  }

  /** Switch to the next phase */
  nextPhase(phase) {
    this._endPhase();
    this._beginPhase(phase);
  }

  /**
   * Transition the spinner into the reasoning ("thinking") phase.
   *
   * Reasoning models (e.g. deepseek-v4-pro, GLM-4.7) emit a long stream of
   * reasoning_content BEFORE any body text. Unlike tick() — which finalizes
   * the spinner because body output is about to take over the line — this
   * keeps the spinner animating under a 'thinking' label so the user sees
   * live progress instead of a stale 'waiting for model' that never advances.
   *
   * It does NOT set `stopped`, so a later tick() (first body delta) still
   * clears the line cleanly and streaming proceeds normally. Idempotent:
   * repeated calls while already on 'thinking' are a no-op, so it is safe to
   * invoke on every reasoning delta.
   */
  reason() {
    // No active phase (e.g. reasoning delta arrived after the spinner was
    // already finalized by tick()/stop()): don't fabricate a new phase. Also
    // skip when already on 'thinking' so repeated reasoning deltas are idempotent.
    if (!this.phase || this.phase === 'thinking') return;
    this._endPhase();
    this._beginPhase('thinking');
  }

  /**
   * Re-arm a previously finalized spinner WITHOUT resetting totalStart.
   *
   * In a multi-turn agent loop the first LLM call's first body delta drives
   * tick(), which sets `stopped=true` and clears `phase`. On EVERY subsequent
   * LLM call (after a tool round) the spinner must animate again for that
   * call's reasoning/body window. But reason()/tick() are no-ops once the
   * spinner is stopped (phase is null), so without re-arming the spinner stays
   * dead for the rest of the loop.
   *
   * resume() clears the stopped flag and begins a fresh phase, leaving
   * totalStart untouched (so the final per-turn stats line is still measured
   * from the original start()). Distinct from start(), which resets totalStart
   * and is meant for the very first phase of an indicator's life. Safe to call
   * on every turn > 1; safe to call when a phase is already active (it just
   * advances to the new phase like nextPhase).
   */
  resume(phase = 'waiting for model') {
    this.stopped = false;
    if (this.phase && this.phase !== phase) {
      this.nextPhase(phase);
    } else if (!this.phase) {
      this._beginPhase(phase);
    }
  }

  /**
   * Finalize the active spinner phase so another writer can take over the line
   * cleanly (e.g. a tool-call card printed to stderr). Sets `stopped` so the
   * spinner won't restart on its own; resume() re-arms it for the next turn.
   *
   * Safe to call when no phase is active (post-tick / non-TTY): a no-op, so it
   * never disturbs already-clean body output. This is the key difference from
   * pause() — pause() deliberately does NOT set `stopped` (it expects a later
   * nextPhase()/tick() to resume the same phase), whereas stop() finalizes for
   * real and is what callers should use when handing the line to a tool card.
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.isTTY) {
      this.stream.write('\r\x1b[K');
    } else if (this.phase) {
      this.stream.write('\n');
    }
    this.phase = null;
    this.stopped = true;
    this.midLine = false; // TTY: line wiped by \r\x1b[K; non-TTY: newline above
  }

  _beginPhase(phase) {
    this.phase = phase;
    this.phaseStart = Date.now();
    if (this.isTTY) {
      this._render();
      this.interval = setInterval(() => this._render(), 200);
    } else {
      this.stream.write(`${muted('[' + phase + '...]')} `);
      this.midLine = true; // header has no trailing newline yet
    }
  }

  _render() {
    const elapsed = ((Date.now() - this.phaseStart) / 1000).toFixed(1);
    const spinner = SPINNER[this.spinnerIdx];
    this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length;
    // Loader line: accent spinner, muted phase, dimmed elapsed suffix.
    this.stream.write(`\r${accent(spinner)} ${muted(this.phase)} ${dim(ICON.dot + ' ' + elapsed + 's')}`);
    this.midLine = true; // frame ends without a newline
  }

  _endPhase() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.isTTY && this.phase) {
      const elapsed = ((Date.now() - this.phaseStart) / 1000).toFixed(1);
      this.stream.write(`\r${success(ICON.ok)} ${muted(this.phase)} ${dim(ICON.dot + ' ' + elapsed + 's')}\n`);
    } else if (!this.isTTY && this.phase) {
      const elapsed = ((Date.now() - this.phaseStart) / 1000).toFixed(1);
      this.stream.write(`${dim(ICON.dot + ' ' + elapsed + 's')}\n`);
    }
    this.phase = null;
    this.midLine = false; // the finalized line ends with a newline
  }

  /**
   * Temporarily stop the spinner WITHOUT finalizing the phase, so an
   * interactive prompt (e.g. the plan-mode "Choose [1-k]" menu) can take
   * over the line cleanly. Unlike tick()/stop(), this does NOT set `stopped`,
   * so a later nextPhase()/tick()/done() still works normally WITHOUT needing
   * a resume() first. Safe to call when no phase is active (non-TTY or already
   * stopped).
   *
   * Note: for handing the line to a tool-call card (a hard finalization),
   * prefer stop() — it sets `stopped` so the spinner won't resume until the
   * next turn's resume(). pause() leaves the spinner "armed" so a stray
   * delta could restart it mid-card.
   */
  pause() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.isTTY) {
      this.stream.write('\r\x1b[K');
    } else if (this.phase) {
      this.stream.write('\n');
    }
    this.phase = null;
    this.midLine = false; // line is clear for whoever takes over next
  }

  /**
   * Break the current line IF a rendered frame is sitting on the stream
   * without a trailing newline, so the next writer (e.g. a ctx.print warning
   * emitted mid-phase by the phase-model fallback policy) starts on a fresh
   * line instead of being glued onto the spinner/timing text:
   *
   *   ⠋ rewriting query · 0.0s[warn] phase model ... is unreachable
   *
   * Idempotent: when the line is already broken (no frame pending) this is a
   * no-op, so back-to-back warnings do not produce blank lines between them.
   * After breaking, the spinner's next 200ms _render() re-claims the new line
   * with \r as usual — the frame is transient, the warning stays on its own
   * line. Safe to call in non-TTY mode (breaks the "[phase...]" header line)
   * and when no phase is active.
   */
  breakLine() {
    if (!this.midLine) return;
    this.midLine = false;
    this.stream.write('\n');
  }

  /**
   * Called on each delta: clears the spinner line so stdout streaming is clean.
   * Subsequent deltas just accumulate char count.
   */
  tick(text) {
    this.charCount += (text || '').length;
    if (this.stopped) return;
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.isTTY) {
      this.stream.write('\r\x1b[K');
    } else if (this.phase) {
      this.stream.write('\n');
    }
    this.phase = null;
    this.midLine = false; // streaming output starts on a clean line
  }

  /** All done — print final stats */
  done() {
    if (!this.stopped) {
      this._endPhase();
    }
    const totalElapsed = ((Date.now() - this.totalStart) / 1000).toFixed(1);
    this.stream.write(`${success(ICON.ok + ' done')} ${dim(ICON.dot)} ${muted(totalElapsed + 's, ' + this.charCount + ' chars')}\n`);
  }
}

export default ProgressIndicator;
