/*----------------------------------------------------------------------
 * Cross-platform pty runner for the interactive tests.
 *
 * Why this exists: the pty tests were written against util-linux `script`
 * (`script -qec "<sh command>" /dev/null`). macOS ships BSD script, whose
 * command argument is a POSITIONAL arg exec'd directly (no -c option at
 * all: "script: illegal option -- c") and which moreover fatally rejects
 * a non-tty stdin ("tcgetattr/ioctl: Operation not supported on socket"),
 * so timed keystroke feeding through child.stdin is impossible on BSD.
 *
 * Strategy: platform dispatch.
 *   - util-linux script available  -> exact legacy spawn (Linux CI keeps
 *     its byte-identical args and behaviour; keystrokes go through
 *     child.stdin exactly as before).
 *   - else macOS system `expect`   -> the ENTIRE run is compiled into ONE
 *     Tcl script written to expect's stdin at spawn: prologue (spawn the
 *     SAME /bin/sh command in a real pty, unbuffered stdout, log output),
 *     timed `send` lines implemented with Tcl `after` timers, and an
 *     epilogue that waits for eof and propagates the child's exit status.
 *     Timing MUST live inside Tcl: expect only drains the pty (and logs
 *     its output) while its event loop runs — while blocked reading the
 *     next stdin script line it forwards NOTHING (verified empirically:
 *     with stdin-streamed sends all output arrives only at script end).
 *     `after` timers run inside that same loop, so pty output flows live.
 *
 * Exit-status and stty-size probes verified: codes propagate exactly,
 * `stty rows/cols` works, ANSI bytes pass through untouched.
 *
 * Run: used by test/tui_pty.test.js and test/repl_midtask_pty.test.js
 *----------------------------------------------------------------------*/
import { spawn, spawnSync } from 'node:child_process';

/** util-linux script prints a version and exits 0; BSD script exits non-0. */
const SCRIPT_IS_UTIL_LINUX = (() => {
  try {
    return spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

const HAS_EXPECT = (() => {
  try {
    return spawnSync('which', ['expect'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

export const PTY_BACKEND = SCRIPT_IS_UTIL_LINUX
  ? 'script'
  : (HAS_EXPECT ? 'expect' : null);

/** True when either backend can provide a real pty (gate for test skip). */
export function ptyAvailable() {
  return PTY_BACKEND !== null;
}

/**
 * Quote a JS string as a Tcl double-quoted literal. Lossless round-trip for
 * the character sets these tests use: shell metachars ($, [, ]) are escaped,
 * common control chars become Tcl escapes (\r, \n, \t, \x1b, ...).
 */
function tclQuote(s) {
  let out = '"';
  for (const ch of String(s)) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '$': out += '\\$'; break;
      case '[': out += '\\['; break;
      case ']': out += '\\]'; break;
      case '\r': out += '\\r'; break;
      case '\n': out += '\\n'; break;
      case '\t': out += '\\t'; break;
      case '\x1b': out += '\\x1b'; break;
      case '\x07': out += '\\a'; break;
      case '\x08': out += '\\b'; break;
      default: out += ch;
    }
  }
  return `${out}"`;
}

/**
 * Spawn `cmd` (a /bin/sh command string) under a real pty.
 *
 * `keys` schedules keystrokes: an array of [delayMsFromSpawn, text] pairs.
 * On the script backend they are delivered via node setTimeout → stdin
 * (legacy behaviour, timing from spawn); on the expect backend they are
 * compiled into Tcl `after` timers inside the one-shot script.
 *
 * Returns { backend, child } — collect stdout/stderr and resolve on
 * 'close' for the propagated exit code. (No send()/finish() API: the
 * schedule is fixed up front by design — see the header comment.)
 */
export function spawnPty(cmd, { cwd, env, keys = [] } = {}) {
  if (PTY_BACKEND === 'script') {
    const child = spawn('script', ['-qec', cmd, '/dev/null'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const [delay, text] of keys) {
      setTimeout(() => {
        if (!child.stdin.destroyed) child.stdin.write(text);
      }, delay);
    }
    return { backend: 'script', child };
  }
  if (PTY_BACKEND === 'expect') {
    const lines = [
      'set timeout -1',                       // we drive timing via `after`
      'log_user 0',                           // suppress the "spawn ..." banner
      'fconfigure stdout -buffering none',    // pipe-friendly: flush every chunk
      `spawn /bin/sh -c ${tclQuote(cmd)}`,    // the SAME command, in a real pty
      'log_user 1',                           // forward spawned output live
    ];
    for (const [delay, text] of keys) {
      lines.push(`after ${Math.max(0, delay | 0)} {send -- ${tclQuote(text)}}`);
    }
    lines.push(
      'expect eof',                           // block until the command exits
      'catch {wait} w',
      'exit [lindex $w 3]',                   // propagate the child's exit status
    );
    const child = spawn('expect', [], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(`${lines.join('\n')}\n`);
    child.stdin.end();
    return { backend: 'expect', child };
  }
  throw new Error('no pty backend available (need util-linux script or expect)');
}
