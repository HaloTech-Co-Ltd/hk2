/*-------------------------------------------------------------------------
 *
 * PTY integration test for the REPL per-Backspace flicker fix.
 *
 * Root cause (verified byte-level under a pty): readline's _refreshLine
 * clears with an unbounded ED (\x1b[0J) that ignores the StatusBar's DECSTBM
 * scroll region — every Backspace wiped the reserved bottom block until the
 * 200ms poll repaint restored it, one visible flash per keypress.
 *
 * The fix (StatusBar.patchReadlineRefresh) repaints the reserved block
 * synchronously after each _refreshLine, so the erase and the repair land
 * in the same terminal frame.
 *
 * HOW THIS TEST CAN FAIL ON UNFIXED CODE (deterministically, not by luck):
 * it measures the erase→repair LATENCY from pty chunk arrival timestamps.
 * On unfixed code the only repair is the 200ms poll tick (phase arbitrary),
 * so a repair gap is uniform in (0, 200ms]. The two backspaces are sent
 * exactly 100ms apart — one half poll-interval. Whatever the poll phase,
 * the two gaps (t_repair_i − t_erase_i) satisfy max(gap1, gap2) > 100ms:
 * if both erases precede the same tick, gap1 > 100; if they straddle ticks,
 * gap2 = gap1 + 100 > 100. Asserting BOTH gaps ≤ 60ms therefore fails on
 * unfixed code in every phase alignment, while fixed code measures 0ms
 * (erase and repair arrive in the same chunk, same tick).
 *
 * Erase identification is anchored on the echoed draft 'abc' (which appears
 * exactly once in this isolated-home bare boot), NOT on positional slicing —
 * the later /quit Enter + prompt redraws emit their own \x1b[0J erases.
 *
 * Runs via test/_pty_runner.js (util-linux `script` on Linux, `expect` on
 * macOS). Skipped when neither backend is available.
 * Run: node --test test/repl_backspace_pty.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';
import { ptyAvailable, spawnPty } from './_pty_runner.js';

// HK2_HOME must be pinned BEFORE lib/config/home.js is imported (it freezes
// the path at module load). Isolated per-run home: bare boot, no project.
const HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-bs-pty-'));
process.env.HK2_HOME = HOME;

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, '..', 'bin', 'hk2');
const hasScript = ptyAvailable();

const ERASE = '\x1b[0J';        // readline's unbounded clearScreenDown
const STATUS_ROW = '\x1b[24;1H'; // the bar's repaint addressing row 24
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('pty: Backspace repaints the status bar in the same frame as the erase (no flicker)', { skip: !hasScript }, async () => {
  // Timestamped chunks: every data event records its arrival time so marker
  // offsets can be mapped to wall-clock latencies.
  const chunks = [];
  let out = '';
  const onData = (b) => { const s = b.toString(); chunks.push({ t: Date.now(), s }); out += s; };
  const tAt = (offset) => {
    let acc = 0;
    for (const c of chunks) {
      if (offset < acc + c.s.length) return c.t;
      acc += c.s.length;
    }
    return chunks.length ? chunks[chunks.length - 1].t : 0;
  };

  await new Promise((resolve, reject) => {
    const { child } = spawnPty(
      `stty rows 24 cols 80 2>/dev/null; exec node ${JSON.stringify(CLI)}`,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          HK2_HOME: HOME,
          HK2_AUTOIMPORT_CLAUDE: '0',
        },
        keys: [
          [2500, 'abc'],        // type the draft (readline fast path, no erase)
          [3900, '\x7f'],       // backspace 1: draft abc -> ab
          [4000, '\x7f'],       // backspace 2: draft ab -> a  (100ms after #1:
                                //   both inside ONE 200ms poll interval)
          [5200, '/quit\r'],
          [8000, '/quit\r'],    // in case a prompt consumed the first
        ],
      },
    );
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty timed out; tail: ${out.slice(-300)}`)); }, 25000);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });

  // The status text must exist (bar started on a TTY stderr).
  assert.ok(/idle/.test(out), `status bar rendered; tail: ${stripAnsi(out).slice(-300)}`);

  // ── Anchor the two backspace erases on the echoed draft ──────────────
  // 'abc' is echoed once as plain bytes (fast-path echo has no escapes) and
  // never recurs: the bare boot banner holds no 'abc', and post-backspace
  // redraws only ever show 'ab' / 'a'.
  const echoAt = out.lastIndexOf('abc');
  assert.ok(echoAt >= 0, `draft echo 'abc' found in the pty stream; tail: ${stripAnsi(out).slice(-300)}`);
  // First unbounded erase after the echo is backspace 1's; the next one
  // after that is backspace 2's (nothing else erases between keystrokes).
  const e1 = out.indexOf(ERASE, echoAt + 3);
  assert.ok(e1 >= 0, 'backspace 1 emitted its \\x1b[0J erase');
  const e2 = out.indexOf(ERASE, e1 + ERASE.length);
  assert.ok(e2 >= 0, 'backspace 2 emitted its \\x1b[0J erase');
  // The repair for each erase: the first reserved-row repaint after it.
  const r1 = out.indexOf(STATUS_ROW, e1 + ERASE.length);
  assert.ok(r1 >= 0, 'a status-row repaint followed backspace 1');
  const r2 = out.indexOf(STATUS_ROW, e2 + ERASE.length);
  assert.ok(r2 >= 0, 'a status-row repaint followed backspace 2');

  // ── Latency assertion: repair must be same-tick, not poll-tick ────────
  // Fixed code: erase and repair are written in the same event-loop tick and
  // arrive in the same chunk → 0ms. Unfixed code: repair waits for the 200ms
  // poll; with the backspaces 100ms apart, max(gap1, gap2) > 100ms for every
  // poll phase (see header math), so the 60ms threshold fails deterministically.
  const gap1 = tAt(r1) - tAt(e1);
  const gap2 = tAt(r2) - tAt(e2);
  assert.ok(gap1 <= 60 && gap2 <= 60,
    `erase→repair must be same-tick (≤60ms), got gap1=${gap1}ms gap2=${gap2}ms — `
    + `the status bar was erased and left blank until a poll repaint (flicker regression)`);

  // ── Sanity: the edits actually happened and the REPL stayed alive ─────
  // After backspace 2 the redrawn line shows prompt + draft 'a' (the 'ab'
  // redraw after backspace 1 cannot match: 'a' there is followed by 'b').
  const afterBs2 = stripAnsi(out.slice(e2, e2 + 600));
  assert.ok(/>\s*a\b/.test(afterBs2),
    `post-backspace draft is 'a'; window: ${JSON.stringify(afterBs2.slice(0, 160))}`);
  // A clean interactive exit prints the goodbye hint — proves the REPL was
  // still serving keys (not crashed/hung) through the /quit.
  assert.ok(stripAnsi(out).includes('Goodbye'), 'REPL exited cleanly via /quit');
});
