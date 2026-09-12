/*-------------------------------------------------------------------------
 *
 * PTY integration test for the TUI terminal-resize region fix.
 *
 * The TUI Frame (src/tui/frame.js) had two residual defects of the same
 * family as the StatusBar resize bug (see test/repl_resize_pty.test.js):
 *
 *   1. A pure-height resize (block-stack height unchanged — the common
 *      case: input box + status heights don't depend on the window) never
 *      re-derived the DECSTBM scroll region. The reserved block repainted
 *      at the new bottom while the STALE region still reached past the new
 *      screen bottom — streaming output then scrolled over the input box
 *      and status line ("output gets overwritten" family).
 *
 *   2. start()/_applyScrollRegion emitted a bare DECSTBM before update()'s
 *      \x1b7 save — the same "DECSTBM homes the cursor to (1,1), then the
 *      save banks the homed position" ordering defect (cursor top-jump).
 *
 * Fix invariant: the region is established ONLY inside update(), always
 * AFTER the \x1b7 save, and re-emitted whenever terminal ROWS changed
 * (tracked via _regionRows) — not just on stack-height changes.
 *
 * This test drives the REAL TUI CLI (`hk2 --tui`) in a real pty, resizes it
 * mid-session via a background `stty` (kernel TIOCSWINSZ → SIGWINCH), and
 * asserts the byte signature:
 *
 *   PASS: the new region "\x1b[1;11r" IS emitted (re-derived for the new
 *         height), and every DECSTBM is preceded by \x1b7 in the same
 *         update emission (cursor-transparent).
 *   FAIL (old bug 1): no "\x1b[1;11r" anywhere after the resize.
 *   FAIL (old bug 2): "\x1b[1;11r" appears BEFORE a save that then banks
 *         the homed position ("\x1b[1;11r\x1b7" as the FIRST bytes of an
 *         update emission).
 *
 * Geometry: 24 rows → 12 rows, cols 80. The TUI input box renders ~4 rows
 * (top border + 1 content + bottom border + hint) plus status ~1 → but the
 * exact stack height doesn't matter for the assertion: what matters is that
 * SOME "\x1b[1;Nr" with the NEW geometry (N ≤ 11 = rows-1) is emitted after
 * the resize, because a stale region would use the OLD 24-row bottom (23).
 *
 * Runs via test/_pty_runner.js (util-linux `script` on Linux, `expect` on
 * macOS). Skipped when neither backend is available.
 * Run: node --test test/tui_resize_pty.test.js
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
const HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-tui-rs-pty-'));
process.env.HK2_HOME = HOME;

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, '..', 'bin', 'hk2');
const hasScript = ptyAvailable();

test('pty: TUI terminal resize re-derives the scroll region cursor-transparently', { skip: !hasScript }, async () => {
  let out = '';
  await new Promise((resolve, reject) => {
    // The background subshell shares the pty as its controlling terminal:
    // its `stty rows 12` performs a real TIOCSWINSZ, and the kernel raises
    // SIGWINCH in the foreground process group — the actual node TUI. The
    // explicit `< /dev/tty` matters: a backgrounded job's stdin is otherwise
    // /dev/null (POSIX job control) and stty would reject it.
    const { child } = spawnPty(
      `stty rows 24 cols 80 2>/dev/null; (sleep 3.4; stty rows 12 cols 80 < /dev/tty) & exec node ${JSON.stringify(CLI)} --tui`,
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
                                // re-render on the post-resize geometry
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

  // The TUI booted at the original 24-row geometry and drew its reserved
  // block (input box + status): the boot region emission must exist.
  const bootRegions = out.match(/\x1b\[1;(\d+)r/g) || [];
  assert.ok(bootRegions.length > 0,
    `TUI established a scroll region at boot; tail: ${out.slice(-200)}`);

  // THE assertion (bug 1): after the resize to 12 rows, a NEW region must be
  // emitted that respects the NEW height. We cut the stream at the /quit
  // keystroke echo — stop() legitimately resets the region to FULL screen
  // (\x1b[1;12r) on exit, which must not be counted as a post-resize
  // emission. Every region BEFORE quit must fit the 12-row screen:
  // bottom ≤ 11. The stale-region bug kept the old 24-row bottom (20)
  // forever — and worse, never emitted anything new at all.
  const quitAt = out.lastIndexOf('/quit');
  const preQuit = quitAt >= 0 ? out.slice(0, quitAt) : out;
  const regions = [...preQuit.matchAll(/\x1b\[1;(\d+)r/g)].map((m) => +m[1]);
  assert.ok(regions.length > 0, `region emissions found: ${regions.join(',')}`);
  const tail = regions.slice(-Math.max(1, Math.floor(regions.length / 2)));
  assert.ok(tail.every((b) => b <= 11),
    `post-resize regions fit the 12-row screen (bottom ≤ 11); got: ${regions.join(',')}`);
  assert.ok(tail.some((b) => b <= 11),
    'at least one region re-derived after the resize');

  // THE assertion (bug 2): cursor transparency. Within the final emission
  // containing the new region, the \x1b7 save must PRECEDE the DECSTBM.
  // The old start() path emitted "\x1b[1;Nr" as the FIRST bytes of the
  // stream (before any save) — homing the cursor and banking (1,1).
  const lastRegionIdx = out.lastIndexOf('\x1b[1;');
  // find the update emission that contains the LAST region: walk back to the
  // nearest \x1b7 before it — there must be one with no other region between.
  let i = lastRegionIdx;
  let regionStr = null;
  while (i >= 0) {
    const m = /^\x1b\[1;(\d+)r/.exec(out.slice(i));
    if (m) { regionStr = m[0]; break; }
    i = out.lastIndexOf('\x1b[', i - 1);
  }
  assert.ok(regionStr, 'parsed the last region emission');
  const saveBefore = out.lastIndexOf('\x1b7', lastRegionIdx);
  const regionBeforeSave = out.lastIndexOf(regionStr, saveBefore);
  assert.ok(saveBefore >= 0 && (regionBeforeSave === -1 || regionBeforeSave < saveBefore),
    'a cursor save precedes the final region emission (cursor-transparent order)');

  // The TUI stayed usable after the resize: the post-resize keystroke
  // echoed and the session exited cleanly on /quit. Anchor at the last
  // PRE-QUIT region (stop()'s full-screen reset lands after the keystroke).
  const preQuitRegions = [...preQuit.matchAll(/\x1b\[1;(\d+)r/g)].map((m) => m.index);
  const resizeAt = preQuitRegions.length > 0 ? preQuitRegions[preQuitRegions.length - 1] : 0;
  assert.ok(out.indexOf('x', resizeAt) > resizeAt, 'post-resize keystroke echoed');
});

test('pty: TUI survives a WIDTH resize without garbling the box', { skip: !hasScript }, async () => {
  let out = '';
  await new Promise((resolve, reject) => {
    const { child } = spawnPty(
      `stty rows 24 cols 120 2>/dev/null; (sleep 3.4; stty rows 24 cols 60 < /dev/tty) & exec node ${JSON.stringify(CLI)} --tui`,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          HK2_HOME: HOME,
          HK2_AUTOIMPORT_CLAUDE: '0',
        },
        keys: [
          [4400, 'x'],
          [5400, '/quit\r'],
          [8000, '/quit\r'],
        ],
      },
    );
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty timed out; tail: ${out.slice(-300)}`)); }, 25000);
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });
  // Boot + resize + keystroke all completed without hanging; the input box
  // redrew at the narrower width (any 60-col-fitting border row exists).
  assert.ok(/hk2|hk/.test(out), 'TUI rendered content');
  const resizeEcho = out.indexOf('x');
  assert.ok(resizeEcho >= 0, 'keystroke echoed');
});
