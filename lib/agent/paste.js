/**
 * Bracketed paste support for the interactive REPL.
 *
 * Problem: when a user pastes multi-line text into a plain readline prompt,
 * each pasted line arrives as its own 'line' event. The first line fires off
 * as a complete agent turn immediately, and the remaining lines become stray
 * follow-up turns. The backslash-continuation mode in processLine does not
 * help with pasting because pasted lines don't end with a backslash.
 *
 * Solution: enable DECSET 2004 "bracketed paste mode". When enabled, the
 * terminal wraps pasted content between `\x1b[200~` (paste-start) and
 * `\x1b[201~` (paste-end). Node's readline keypress decoder turns those two
 * markers into keypress events with `key.name === 'paste-start'` /
 * `'paste-end'` (verified across packetized input and real ptys).
 *
 * Between the markers the pasted text is captured from the raw keypress
 * characters (each keypress's `str` arg reconstructs the exact pasted bytes,
 * including '\n' for enter). This is more reliable than watching 'line' events:
 * when a paste has no trailing newline, readline keeps the last line in its
 * internal edit buffer (rl.line) and never emits it as a 'line' event. We
 * therefore (a) suppress 'line' events while pasting and (b) clear readline's
 * pending buffer at paste-end so the unterminated tail doesn't leak into the
 * next typed input.
 *
 * IMPORTANT - no paste is ever auto-submitted. On paste-end the captured text
 * is kept as a DRAFT and submitted only when the user presses Enter:
 *  - Single-line paste (no newline): the text already sits in rl.line (echoed
 *    by Node's _ttyWrite during the paste); we just refresh it. Enter submits
 *    it through the normal 'line' flow.
 *  - Multi-line paste: Node's readline cannot hold a literal '\n' in rl.line
 *    (it would fire a 'line' event), so the full text is stashed in
 *    `pendingDraft` and the prompt is cleared. The REPL's 'line' handler calls
 *    `consumePendingDraft()` on the next Enter to submit the whole block. If
 *    the user types fresh text instead, that text wins and the draft is dropped.
 *
 * Most modern terminals (xterm, iTerm2, gnome-terminal, kitty, Alacritty,
 * Windows Terminal, tmux, screen) support bracketed paste. Non-TTY / piped
 * input is unaffected (start() is a no-op).
 */
import readline from 'node:readline';

const ENABLE = '\x1b[?2004h';
const DISABLE = '\x1b[?2004l';

export class PasteHandler {
  /**
   * @param {NodeJS.WriteStream} output  stream to write the enable/disable
   *                                     escape sequences to (process.stderr)
   * @param {NodeJS.ReadStream}  input   the readline input stream
   *                                     (process.stdin / session.rl.input)
   * @param {readline.Interface} rl      the readline interface, used to clear
   *                                     the pending edit buffer at paste-end
   */
  constructor(output, input, rl) {
    this.output = output;
    this.input = input;
    this.rl = rl;
    this.enabled = false;
    this.pasting = false;
    /** @type {string[]} raw keypress chars of the in-flight paste */
    this.buf = [];
    /**
     * A multi-line paste is NOT auto-submitted (the user may have more to
     * add / review). Because Node's readline cannot hold a literal '\n' in
     * rl.line (any embedded newline fires a 'line' event), we stash the full
     * normalized paste text here and submit it when the user presses Enter on
     * the (cleared) prompt. The 'line' handler calls consumePendingDraft()
     * to drain it. null when no multi-line draft is waiting.
     */
    this.pendingDraft = null;
    /** Flush callback set by the caller; invoked with the joined paste text. */
    this.onFlush = null;
    this._kp = null;
  }

  /** True only between a paste-start and paste-end keypress. */
  isPasting() {
    return this.pasting;
  }

  /**
   * Enable bracketed paste mode and register a keypress listener that tracks
   * paste-start / paste-end markers and captures the pasted characters. No-op
   * in non-TTY mode.
   */
  start() {
    if (!this.input?.isTTY || !this.output?.isTTY) return;
    try {
      readline.emitKeypressEvents(this.input); // idempotent
    } catch { /* readline already wired it */ }
    this._kp = (str, key) => {
      if (!key) return;
      if (key.name === 'paste-start') {
        this.pasting = true;
        this.buf = [];
      } else if (key.name === 'paste-end') {
        const raw = this.buf.join('');
        this.buf = [];
        this.pasting = false;
        // Normalize line endings (Windows \r\n / old Mac \r -> \n) and strip a
        // single trailing line terminator so a paste with or without a final
        // newline yields the same message.
        const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
        if (text.length === 0) return;
        const isMultiLine = text.indexOf('\n') !== -1;
        if (isMultiLine) {
          // Multi-line paste: do NOT auto-submit. Node's readline cannot keep
          // a literal '\n' in rl.line (it would fire a 'line' event), so we
          // stash the full text in pendingDraft and clear the prompt. The user
          // presses Enter on the empty prompt to submit the whole block as one
          // message (drained by consumePendingDraft() from the 'line' handler).
          this.pendingDraft = text;
          if (this.rl) { this.rl.line = ''; this.rl.cursor = 0; }
          this.output.write('\r\x1b[K');
          if (this.rl) this.rl.prompt(true);
          // Show a dim one-line hint so the user knows a multi-line paste is
          // pending and that Enter will submit it (nothing is auto-sent).
          const n = text.split('\n').length;
          const firstNonEmpty = text.split('\n').find((l) => l.trim() !== '') || '';
          const preview = firstNonEmpty.length > 40 ? firstNonEmpty.slice(0, 40) + '\u2026' : firstNonEmpty;
          const hint = `\x1b[2m[paste: ${n} line${n === 1 ? '' : 's'}${preview ? ' \u00b7 ' + preview : ''} \u2014 press Enter to send, or type to discard]\x1b[0m`;
          this.output.write('\n' + hint + '\n');
          if (this.rl) this.rl.prompt(true);
        } else {
          // Single-line paste, no trailing newline: keep it as an editable
          // draft in readline's edit buffer (rl.line). The pasted chars were
          // already echoed there by Node's _ttyWrite default-case during the
          // paste, so rl.line already holds the text; just put the cursor at
          // the end and refresh. The user presses Enter to submit it through
          // the normal 'line' flow - we never fabricate an Enter.
          if (this.rl) {
            this.rl.cursor = this.rl.line.length;
            try { this.rl._refreshLine(); } catch { /* output gone */ }
          }
        }
      } else if (this.pasting) {
        // Reconstruct the pasted text from raw keypress chars. `str` is the
        // character; for the enter key it is '\n'. (key.sequence could also be
        // used, but `str` already normalizes printable chars + newline.)
        if (str) this.buf.push(str);
        else if (key?.name === 'enter') this.buf.push('\n');
      }
    };
    this.input.on('keypress', this._kp);
    this.output.write(ENABLE);
    this.enabled = true;
  }

  /**
   * Returns true if the line was emitted during an active paste (so the caller
   * should drop it - the paste content is captured separately from raw
   * keypresses and is kept as a pending draft until the user presses Enter).
   */
  bufferIfPasting(_line) {
    return this.pasting;
  }

  /**
   * Drain a pending multi-line paste draft, if any. Called from the REPL's
   * 'line' handler when the user presses Enter. A multi-line paste is never
   * auto-submitted; it sits in pendingDraft until the user confirms with
   * Enter. When a draft is pending, this returns the full paste text and
   * clears it; the caller submits that instead of the (possibly empty or
   * last-line-only) readline 'line'. Returns null when nothing is pending.
   *
   * @param {string} line  The readline 'line' event content (used to decide
   *                       whether to honor or discard the draft - see below).
   * @returns {string|null}
   */
  consumePendingDraft(line) {
    if (this.pendingDraft === null) return null;
    const draft = this.pendingDraft;
    this.pendingDraft = null;
    // If the user typed something fresh on the cleared prompt before pressing
    // Enter, that input wins - they're moving on, not confirming the paste.
    // Only an empty (or whitespace-only) Enter is treated as 'submit the
    // pasted block'. A non-empty line is returned as-is so the caller submits
    // exactly what the user typed, and the draft is discarded.
    const typed = line != null ? line.trim() : '';
    if (typed === '') return draft;
    return line;
  }

  /** True when a multi-line paste is buffered and awaiting an Enter to submit. */
  hasPendingDraft() {
    return this.pendingDraft !== null;
  }

  /** Drop any pending multi-line paste draft without submitting it. */
  discardPendingDraft() {
    this.pendingDraft = null;
  }

  /** Disable bracketed paste mode and detach the keypress listener. */
  stop() {
    if (!this.enabled) return;
    if (this._kp) this.input?.off('keypress', this._kp);
    this._kp = null;
    try { this.output?.write(DISABLE); } catch { /* output gone */ }
    this.enabled = false;
    this.pasting = false;
    this.buf = [];
    this.pendingDraft = null;
  }
}
