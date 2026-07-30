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

  _beginPhase(phase) {
    this.phase = phase;
    this.phaseStart = Date.now();
    if (this.isTTY) {
      this._render();
      this.interval = setInterval(() => this._render(), 200);
    } else {
      this.stream.write(`${muted('[' + phase + '...]')} `);
    }
  }

  _render() {
    const elapsed = ((Date.now() - this.phaseStart) / 1000).toFixed(1);
    const spinner = SPINNER[this.spinnerIdx];
    this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length;
    // Loader line: accent spinner, muted phase, dimmed elapsed suffix.
    this.stream.write(`\r${accent(spinner)} ${muted(this.phase)} ${dim(ICON.dot + ' ' + elapsed + 's')}`);
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
