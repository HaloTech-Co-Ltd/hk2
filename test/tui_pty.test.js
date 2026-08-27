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
 * Skipped entirely when `script` is unavailable (non-Linux CI).
 *
 * Run:  node --test test/tui_pty.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'hk2'); // self-invoking entry point

const hasScript = spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0
  || spawnSync('which', ['script'], { stdio: 'ignore' }).status === 0;

/**
 * Run `hk2 --tui` under a pty at the given size; resolve when the process
 * exits with { code, output }.
 */
function runTuiPty({ cols = 80, rows = 24, keys = [], timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'hk2-pty-home-'));
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'hk2-pty-cwd-'));
    const child = spawn('script', [
      '-qec',
      `stty rows ${rows} cols ${cols} 2>/dev/null; exec node ${JSON.stringify(CLI)} --tui`,
      '/dev/null',
    ], {
      cwd,
      env: {
        ...process.env,
        HK2_HOME: home,
        TERM: 'xterm-256color',
        HK2_AUTOIMPORT_CLAUDE: '0', // deterministic boot: no user-config import
        NO_COLOR: '',               // colors on — we assert on glyphs, not hues
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    // Boot, then feed the keystrokes with a small gap so the key loop sees
    // them as separate events (not one bracketed burst).
    let i = 0;
    const feed = () => {
      if (i >= keys.length) return;
      const k = keys[i++];
      child.stdin.write(k);
      setTimeout(feed, k.length > 4 ? 150 : 350);
    };
    setTimeout(feed, 1500);
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
    const child = spawn('script', [
      '-qec',
      `stty -g > /tmp/hk2-stty-before.$$; node ${JSON.stringify(CLI)} --tui --resume definitely-missing; code=$?; stty -g > /tmp/hk2-stty-after.$$; cat /tmp/hk2-stty-before.$$ /tmp/hk2-stty-after.$$; echo EXIT=$code; rm -f /tmp/hk2-stty-before.$$ /tmp/hk2-stty-after.$$`,
      '/dev/null',
    ], {
      cwd: os.tmpdir(),
      env: { ...process.env, HK2_HOME: home, TERM: 'xterm-256color', HK2_AUTOIMPORT_CLAUDE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('pty timed out')); }, 20000);
    child.stdout.on('data', (b) => { buf += b.toString(); });
    child.stderr.on('data', (b) => { buf += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
  });
  // The bracketed-paste disable escape lands on the SAME line as the first
  // snapshot — strip ANSI before matching.
  const plainOut = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const hashes = [...plainOut.matchAll(/^([0-9a-f:;]+)\r?$/gm)].map((m) => m[1]);
  const exitCode = /EXIT=(\d+)/.exec(out)?.[1];
  assert.equal(exitCode, '2', 'resume failure exits 2');
  assert.ok(hashes.length >= 2, `two stty -g snapshots captured (${hashes.length})`);
  assert.equal(hashes[0], hashes[1], 'terminal termios identical before and after — raw mode restored');
});
