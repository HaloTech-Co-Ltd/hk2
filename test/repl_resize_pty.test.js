/*-------------------------------------------------------------------------
 *
 * PTY integration test for the REPL terminal-resize cursor fix.
 *
 * Root cause (byte-verified): the StatusBar's resize handler emitted the
 * DECSTBM scroll region (\x1b[1;Nr) BEFORE any cursor save. DECSTBM homes
 * the physical cursor to (1,1) as a documented side effect, so the \x1b7
 * that update() emitted afterwards re-saved the HOMED position and the
 * trailing \x1b8 restored it — the user's mid-screen typing cursor jumped
 * to the top row, and readline's next refresh (\x1b[1G\x1b[0J, an ED that
 * IGNORES the scroll region) wiped the transcript from row 1 down.
 *
 * The fix (StatusBar.handleResize) saves the cursor FIRST:
 *
 *   \x1b7  →  \x1b[1;Nr (new region)  →  update({skipCursorSave:true})  →  \x1b8
 *
 * This test drives the REAL CLI in a real pty, resizes it mid-session via a
 * background `stty` (a kernel-level TIOCSWINSZ → SIGWINCH to the foreground
 * process group), and asserts the resize emission's byte ORDER:
 *
 *   PASS signature:  "\x1b7\x1b[1;11r"   (save precedes the new region)
 *   FAIL signature:  "\x1b[1;11r\x1b7"   (region homed the cursor, THEN the
 *                                         save captured the homed position)
 *
 * 24 rows -> 12 rows, no plan / no input box: the reserved block is the
 * single status line, so the new region is 1..(12-1)=1..11 and the resize
 * emission is the ONLY place \x1b[1;11r appears (steady-state polls never
 * re-emit the region).
 *
 * Runs via test/_pty_runner.js (util-linux `script` on Linux, `expect` on
 * macOS). Skipped when neither backend is available.
 * Run: node --test test/repl_resize_pty.test.js
 *----------------------------------------------------------------------
 */
import './_tty_env.js';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';
import { ptyAvailable, spawnPty } from './_pty_runner.js';

// HK2_HOME must be pinned BEFORE lib/config/home.js is imported (it freezes
// the path at module load). Isolated per-run home: bare boot, no project.
const HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-rs-pty-'));
process.env.HK2_HOME = HOME;

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, '..', 'bin', 'hk2');
const hasScript = ptyAvailable();

test('pty: terminal resize is cursor-transparent (save precedes the region reset)', { skip: !hasScript }, async () => {
  let out = '';
  await new Promise((resolve, reject) => {
    // The background subshell shares the pty as its controlling terminal:
    // its `stty rows 12` performs a real TIOCSWINSZ, and the kernel raises
    // SIGWINCH in the foreground process group — the actual node REPL. The
    // explicit `< /dev/tty` matters: a backgrounded job's stdin is otherwise
    // /dev/null (POSIX job control) and stty would reject it with "stdin
    // isn't a terminal", silently never resizing (probe-verified).
    const { child } = spawnPty(
      `stty rows 24 cols 80 2>/dev/null; (sleep 3.4; stty rows 12 cols 80 < /dev/tty) & exec node ${JSON.stringify(CLI)}`,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          HK2_HOME: HOME,
          HK2_AUTOIMPORT_CLAUDE: '0',
        },
        keys: [
          [4400, 'x'],          // a keystroke AFTER the resize: forces a
                                // readline refresh on the post-resize cursor
          [5400, '/quit\r'],
          [8000, '/quit\r'],    // in case a prompt consumed the first
        ],
      },
    );
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty timed out; tail: ${out.slice(-300)}`)); }, 25000);
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });

  // The REPL booted and rendered its status bar at the original 24-row
  // geometry (region 1..23).
  assert.ok(out.includes('\x1b[1;23r'), `boot established the 24-row region; tail: ${out.slice(-200)}`);

  // THE assertion: the resize emission must SAVE the cursor BEFORE the new
  // DECSTBM. The new geometry is 12 rows, reserved 1 → region 1..11.
  const passSig = out.indexOf('\x1b7\x1b[1;11r');
  assert.ok(passSig >= 0,
    'resize emitted \\x1b7 BEFORE \\x1b[1;11r (cursor-transparent); got tail: '
    + JSON.stringify(out.slice(Math.max(0, out.indexOf('\x1b[1;11r') - 40), out.indexOf('\x1b[1;11r') + 20)));

  // The FAIL signature of the old handler: the bare region first, THEN the
  // save that captured the DECSTBM-homed (1,1) position.
  assert.ok(!out.includes('\x1b[1;11r\x1b7'),
    'resize must not home the cursor before saving it (old bug signature \\x1b[1;Nr\\x1b7)');

  // The resize happened while the REPL was live and it stayed usable: the
  // post-resize keystroke echoed and /quit exited cleanly.
  const resizeAt = out.indexOf('\x1b[1;11r');
  assert.ok(out.indexOf('x', resizeAt) > resizeAt, 'post-resize keystroke echoed');
  assert.ok(/idle/.test(out), 'status bar still rendering after the resize');
});
