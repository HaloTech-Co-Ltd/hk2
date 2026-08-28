/*-------------------------------------------------------------------------
 *
 * Unit tests for StatusBar.patchReadlineRefresh — the per-Backspace flicker
 * fix. Root cause: readline's private _refreshLine() ends in
 * clearScreenDown (\x1b[0J), an UNBOUNDED erase that ignores the DECSTBM
 * scroll region and blanks the reserved status block until the next poll
 * repaint (up to 200ms later) — one visible flash per editing keystroke.
 *
 * The patch repaints the reserved block synchronously after every
 * _refreshLine call, in the same tick, so erase + repair land in one
 * terminal frame. These tests verify the byte-level contract without a
 * real terminal; test/repl_backspace_pty.test.js replays the whole REPL
 * under a pty.
 *
 * Run:  node --test test/statusbar_rlpatch.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { StatusBar } from '../lib/agent/statusbar.js';

function makeRig() {
  // ONE stream for BOTH the StatusBar and readline — mirrors production,
  // where the bar and rl.output both draw on process.stderr. All assertions
  // run against this merged byte stream.
  const writes = [];
  const fakeStream = new Writable({
    write(chunk, _enc, cb) { writes.push(chunk.toString()); cb(); },
  });
  fakeStream.isTTY = true;
  fakeStream.columns = 80;
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true });
  const bar = new StatusBar(fakeStream, { formatter: () => 'STATUS' });
  bar._started = true; // bypass start()'s resize-handler side effects

  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const rl = readline.createInterface({ input, output: fakeStream, terminal: true, prompt: 'P> ' });
  return { bar, writes, rl, input };
}

test('patchReadlineRefresh repaints the reserved block synchronously after a Backspace', () => {
  const { bar, writes, rl, input } = makeRig();
  bar.update();
  writes.length = 0; // isolate post-patch traffic

  const unpatch = bar.patchReadlineRefresh(rl);
  assert.equal(typeof unpatch, 'function');

  rl.prompt();
  input.write('ab');
  writes.length = 0;
  input.write('\x7f'); // Backspace

  const all = writes.join('');
  // The unbounded erase from readline's native refresh IS present...
  assert.ok(all.includes('\x1b[0J'), 'readline emitted its clearScreenDown erase');
  // ...but a full reserved-block repaint follows IN THE SAME TICK: the
  // status line is rewritten right after the erase, not 200ms later.
  const eraseAt = all.indexOf('\x1b[0J');
  const statusAt = all.indexOf('STATUS');
  assert.ok(statusAt > eraseAt, `reserved block repainted after the erase (erase@${eraseAt}, status@${statusAt})`);
  // Absolute addressing onto the bottom reserved row is part of the repair.
  assert.ok(/\x1b\[24;1H/.test(all), 'repaint addresses the bottom status row');
});

test('unpatch restores the original _refreshLine', () => {
  const { bar, rl, input, writes } = makeRig();
  const unpatch = bar.patchReadlineRefresh(rl);
  // Behavior check (identity is useless across .bind): while patched, a
  // Backspace triggers a reserved-block repaint.
  rl.prompt();
  input.write('ab');
  writes.length = 0;
  input.write('\x7f'); // line 'ab' -> 'a': refresh fires, repaint follows
  assert.ok(writes.join('').includes('STATUS'), 'patch active: repaint followed the erase');

  unpatch();
  // After unpatch a Backspace still erases (readline's own behavior) but NO
  // reserved-block repaint follows. Line 'a' -> '' still fires _refreshLine.
  writes.length = 0;
  input.write('\x7f');
  const all = writes.join('');
  assert.ok(all.includes('\x1b[0J'), 'readline still erases on its own');
  assert.ok(!all.includes('STATUS'), 'no reserved-block repaint without the patch');
});

test('fails open: no-op on disabled bar or readline without the private method', () => {
  const fakeStream = { isTTY: true, columns: 80, write: () => {} };
  const off = new StatusBar(fakeStream, { formatter: () => 'S' });
  const un1 = off.patchReadlineRefresh({ _refreshLine() {} });
  assert.equal(typeof un1, 'function');
  const started = new StatusBar(fakeStream, { formatter: () => 'S' });
  started._started = true;
  const un2 = started.patchReadlineRefresh({});
  assert.equal(typeof un2, 'function');
  // Neither threw; uninstalls are callable no-ops.
  un1();
  un2();
});

test('editing traffic via the patch still ends with the status line intact', () => {
  const { bar, rl, input, writes } = makeRig();
  bar.update();
  const unpatch = bar.patchReadlineRefresh(rl);
  rl.prompt();
  input.write('xyz');
  input.write('\x7f');
  input.write('\x7f');
  const all = writes.join('');
  // Two backspaces -> two erases -> two repairs; final state shows the
  // status row written LAST (after the final repair).
  const lastStatus = all.lastIndexOf('STATUS');
  const lastErase = all.lastIndexOf('\x1b[0J');
  assert.ok(lastStatus > lastErase, 'final repair follows the final erase');
  unpatch();
});
