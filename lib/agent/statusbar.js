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
    this._resizeHandler = null;
    this._interval = null;
    this._started = false;
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
    // Reset scroll region to full screen and clear the bottom line
    const rows = this._rows();
    this._write(`\x1b[1;${rows}r`);
    this._write(`\x1b[${rows};1H\x1b[2K`);
    // Move cursor to a sane position (bottom-1)
    this._write(`\x1b[${Math.max(1, rows - 1)};1H\n`);
  }

  /**
   * Redraw the status bar at the bottom of the screen.
   * Safe to call any time; no-op if not enabled or not started.
   */
  update() {
    if (!this.enabled || !this._started) return;
    const rows = this._rows();
    const text = this._render();
    // Save cursor → move to last line → clear line → write status → restore cursor
    this._write(`\x1b7\x1b[${rows};1H\x1b[2K${text}\x1b8`);
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
    // Set scroll region to rows-1; cursor home inside the region
    this._write(`\x1b[1;${rows - 1}r`);
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
