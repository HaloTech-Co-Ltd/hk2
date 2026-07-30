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
 * next typed input. On paste-end the captured text is flushed to `onFlush`.
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
        let text = this.buf.join('');
        this.buf = [];
        this.pasting = false;
        // Clear readline's pending edit buffer: when the paste had no trailing
        // newline, its last line is stranded in rl.line and would otherwise
        // leak into the next typed input. Redraw a clean prompt line.
        if (this.rl) {
          this.rl.line = '';
          this.rl.cursor = 0;
        }
        this.output.write('\r\x1b[K');
        if (this.rl) this.rl.prompt(true);
        // Normalize line endings (Windows \r\n / old Mac \r -> \n) and strip
        // a single trailing line terminator so a paste with or without a
        // final newline yields the same message.
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
        if (this.onFlush && text.length > 0) this.onFlush(text);
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
   * keypresses and flushed as one message on paste-end).
   */
  bufferIfPasting(_line) {
    return this.pasting;
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
  }
}
