/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 *-------------------------------------------------------------------------*/

/**
 * Streaming renderer for reasoning models' reasoning_content.
 *
 * Reasoning models (e.g. deepseek-v4-pro, GLM-4.7, Claude extended thinking)
 * emit a long `reasoning_content` stream BEFORE any body text. Previously the
 * REPL only switched the spinner to a static 'thinking' label and threw the
 * reasoning text away, so the user saw the spinner flicker between
 * 'thinking' / 'waiting for model' with NO description of what the model was
 * actually doing. This renderer surfaces that reasoning content live so the
 * user can follow the model's thought process.
 *
 * Design:
 *  - Distinct visual style from body output: a '✎ thinking' header line, and
 *    every reasoning line wrapped dim (greyed) + italic so it reads clearly
 *    as "internal reasoning", not as the assistant's final answer.
 *  - Independent buffer from the body MarkdownStream, so reasoning and body
 *    never interleave state (they arrive in separate phases anyway).
 *  - Header is emitted ONCE on the first non-empty delta; subsequent deltas
 *    just continue the dim stream. Reset via reset() at every turn / phase
 *    boundary so each reasoning window gets its own header.
 *  - Line cap: reasoning streams can be very long and flood the REPL, so by
 *    default (HK2_HIDE_THINKING unset or =1) only the first 5 content lines
 *    render; a dim notice then reports how many lines were hidden.
 *    HK2_HIDE_THINKING=0 restores the full-stream behavior.
 *
 * Usage:
 *   const rs = new ReasoningStream();
 *   for each reasoning delta: process.stdout.write(rs.feed(delta));
 *   on phase boundary / before body or tool card: rs.end();   // emits trailing newline
 *   at turn start: rs.reset();
 */
import * as style from './style.js';

/**
 * Per-window reasoning line budget, from HK2_HIDE_THINKING:
 *   '0'             -> Infinity — stream the FULL reasoning content (old behavior)
 *   unset / '1' / * -> 5 — cap the thinking window at 5 content lines
 * Re-read at every ReasoningStream construction / reset, so each LLM call
 * picks up the current value.
 */
function thinkingLineBudget() {
  return (process.env.HK2_HIDE_THINKING ?? '').trim() === '0' ? Infinity : 5;
}

export class ReasoningStream {
  constructor() {
    this.reset();
  }

  /** Feed a reasoning delta. Returns styled text to write to stdout. */
  feed(text) {
    if (this.ended || !text) return '';
    this.buf += text;
    let out = '';
    // Emit the header on the first delta so the user sees a clear marker that
    // the following greyed text is the model's reasoning, not its answer.
    if (!this.headerShown) {
      out += style.italic(style.dim('✎ thinking')) + '\n';
      this.headerShown = true;
    }
    while (true) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      // _renderLine owns the trailing newline: over-budget lines return ''
      // (dropped silently) so suppressed lines don't emit blank rows.
      out += this._renderLine(line);
    }
    return out;
  }

  /**
   * Finalize the current reasoning window: flush any trailing partial line.
   * Call this before body text or a tool card so reasoning output is cleanly
   * terminated. After end(), further feed() calls are ignored until reset().
   * Returns any final styled text to write.
   */
  end() {
    if (this.ended) return '';
    let out = '';
    if (this.buf) {
      if (!this.headerShown) {
        out += style.italic(style.dim('✎ thinking')) + '\n';
        this.headerShown = true;
      }
      out += this._renderLine(this.buf);
      this.buf = '';
    }
    if (this.hiddenLines > 0) {
      out += style.italic(style.dim(
        `… ${this.hiddenLines} more line${this.hiddenLines === 1 ? '' : 's'} hidden — set HK2_HIDE_THINKING=0 to show full thinking`
      )) + '\n';
    }
    this.ended = true;
    return out;
  }

  /** Reset for the next reasoning window (called at every turn boundary). */
  reset() {
    this.buf = '';
    this.headerShown = false;
    this.ended = false;
    this.maxLines = thinkingLineBudget();
    this.shownLines = 0;   // reasoning content lines rendered this window
    this.hiddenLines = 0;  // reasoning content lines suppressed this window
  }

  _renderLine(line) {
    // Keep reasoning visually subdued: dim + italic, preserved whitespace so
    // the model's indentation / structure is readable. Lines over the budget
    // are dropped silently; end() reports the hidden-line count once.
    if (this.shownLines >= this.maxLines) {
      this.hiddenLines++;
      return '';
    }
    this.shownLines++;
    return style.italic(style.dim(line)) + '\n';
  }
}

export default ReasoningStream;
