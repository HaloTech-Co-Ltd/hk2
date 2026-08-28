/*-------------------------------------------------------------------------
 *
 * PTY smoke tests for the inline TUI: boot the REAL `hk2 --tui` under a
 * pseudo-terminal (via `script`), drive it with keystrokes on its stdin,
 * and assert on the process outcome. This is the automated version of the
 * manual pty checks from the review rounds — headless byte tests can lie
 * about what a terminal actually does with the escape stream.
 *
 *   boot + /quit at 40/80/120 cols → exit 0, welcome + resume hint seen
 *
 * Runs via test/_pty_runner.js: util-linux `script -qec` on Linux, system
 * `expect` on macOS (BSD script has no -c and rejects pipe stdin).
 * Skipped entirely when neither backend is available.
 *
 * Run:  node --test test/tui_pty.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ptyAvailable, spawnPty } from './_pty_runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'hk2'); // self-invoking entry point

const hasScript = ptyAvailable(); // util-linux script OR macOS expect

/**
 * Run `hk2 --tui` under a pty at the given size; resolve when the process
 * exits with { code, output }.
 */
function runTuiPty({ cols = 80, rows = 24, keys = [], timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'hk2-pty-home-'));
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'hk2-pty-cwd-'));
    const { child } = spawnPty(
      `stty rows ${rows} cols ${cols} 2>/dev/null; exec node ${JSON.stringify(CLI)} --tui`,
      {
        cwd,
        env: {
          ...process.env,
          HK2_HOME: home,
          TERM: 'xterm-256color',
          HK2_AUTOIMPORT_CLAUDE: '0', // deterministic boot: no user-config import
          NO_COLOR: '',               // colors on — we assert on glyphs, not hues
        },
        // Boot, then feed the keystrokes with a small gap so the key loop sees
        // them as separate events (not one bracketed burst). Delays are from
        // spawn; the runner turns them into timed sends on either backend.
        keys: keys.map((k, i) => [1500 + i * (k.length > 4 ? 150 : 350), k]),
      },
    );
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pty run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out });
    });
  });
}

test('pty: boot + /quit exits cleanly at 40 / 80 / 120 cols', { skip: !hasScript }, async (t) => {
  for (const cols of [40, 80, 120]) {
    await t.test(`cols=${cols}`, async () => {
      const { code, output } = await runTuiPty({ cols, keys: ['/quit', '\r'] });
      assert.equal(code, 0, `clean exit (got ${code})\n--- output tail ---\n${output.slice(-600)}`);
      assert.match(output, /hk2 v/, 'welcome card rendered');
      // Clean teardown: bracketed paste OFF and the scroll region reset to
      // the full screen (projectless boot has no transcript → no resume id,
      // so the resume hint is not asserted here).
      assert.ok(output.includes('\x1b[?2004l'), 'bracketed paste disabled on exit');
      assert.ok(output.includes('\x1b[1;24r'), 'scroll region reset to the full screen');
    });
  }
});


test('pty: failed --resume restores the terminal (raw mode off, stty unchanged)', { skip: !hasScript }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hk2-pty-res-'));
  // Inside the pty: snapshot termios, run the failing resume, snapshot again.
  // If raw mode leaked, the second stty -g differs (and/or echo is dead).
  const out = await new Promise((resolve, reject) => {
    const { child } = spawnPty(
      `stty -g > /tmp/hk2-stty-before.$$; node ${JSON.stringify(CLI)} --tui --resume definitely-missing; code=$?; stty -g > /tmp/hk2-stty-after.$$; cat /tmp/hk2-stty-before.$$ /tmp/hk2-stty-after.$$; echo EXIT=$code; rm -f /tmp/hk2-stty-before.$$ /tmp/hk2-stty-after.$$`,
      {
        cwd: os.tmpdir(),
        env: { ...process.env, HK2_HOME: home, TERM: 'xterm-256color', HK2_AUTOIMPORT_CLAUDE: '0' },
      },
    ); // non-interactive: the command self-terminates
    let buf = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('pty timed out')); }, 20000);
    child.stdout.on('data', (b) => { buf += b.toString(); });
    child.stderr.on('data', (b) => { buf += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
  });
  // The bracketed-paste disable escape lands on the SAME line as the first
  // snapshot — strip ANSI before matching. Snapshot formats differ by
  // platform: Linux stty -g emits a bare hex:colon string, BSD stty -g emits
  // gfmt1:cflag=4b00:iflag=... — accept a whole-line match of either shape.
  const plainOut = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const hashes = [...plainOut.matchAll(/^((?:[0-9a-f:;]+|gfmt1:\S+))\r?$/gm)].map((m) => m[1]);
  const exitCode = /EXIT=(\d+)/.exec(out)?.[1];
  assert.equal(exitCode, '2', 'resume failure exits 2');
  assert.ok(hashes.length >= 2, `two stty -g snapshots captured (${hashes.length})`);
  assert.equal(hashes[0], hashes[1], 'terminal termios identical before and after — raw mode restored');
});
