/*-------------------------------------------------------------------------
 *
 * Unit tests for the REPL menu-during-resize rendering fix (StatusBar part):
 *   1. patchReadlineRefresh({gate}) fully suppresses readline's native
 *      redraw (ZERO bytes — no \x1b[1G\x1b[0J ED wipe) while a menu owns the
 *      input; it redraws the menu row BOUNDED (CR + EL) with the menu prompt
 *      instead of the main prompt.
 *   2. _rows() prefers the bar's own (DRAW) stream over process.stdout —
 *      stdout's rows can lag behind the draw stream's on a resize, which
 *      painted the bar at the OLD row on the NEW screen.
 *   3. update() after a height change while a menu is active re-anchors the
 *      cursor at the NEW workspace bottom, re-banks the DECSC slot there,
 *      and re-emits the menu prompt — instead of \x1b8-restoring a cursor
 *      position that now lives inside the reserved block (the "confirm
 *      input vanished, then re-appeared over the transcript / status bar
 *      duplicated mid-screen" bug).
 *   4. A height change also clears the OLD geometry's reserved rows (the
 *      stale duplicate bar a grow leaves mid-screen).
 *   5. handleResize coalesces a same-tick storm (stdout resize + draw-stream
 *      resize + SIGWINCH) into one paint pass.
 *
 * Run:  node --test test/statusbar_menuresize.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { StatusBar } from '../lib/agent/statusbar.js';

function makeRig({ rows = 24, cols = 80, menuState = null } = {}) {
  const writes = [];
  const fakeStream = new Writable({
    write(chunk, _enc, cb) { writes.push(chunk.toString()); cb(); },
  });
  fakeStream.isTTY = true;
  fakeStream.columns = cols;
  fakeStream.rows = rows;
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true });
  const bar = new StatusBar(fakeStream, { formatter: () => 'STATUS' });
  bar._started = true; // bypass start()'s resize-handler side effects
  if (menuState) bar.setMenuStateFn(menuState);

  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const rl = readline.createInterface({ input, output: fakeStream, terminal: true, prompt: 'P> ' });
  return { bar, writes, rl, input, fakeStream };
}

/* ---- 1. gate: readline's native resize redraw is fully suppressed ------- */

test('gate: output-stream resize during a menu emits NO ED wipe and NO main prompt', () => {
  const { bar, writes, rl, fakeStream } = makeRig({
    menuState: () => ({ active: true, prompt: 'Write "x" to eden space? (y/N) ', line: '' }),
  });
  bar.update();
  writes.length = 0;
  const unpatch = bar.patchReadlineRefresh(rl, { gate: () => true });

  fakeStream.rows = 12;              // shrink
  fakeStream.emit('resize');         // readline's own resize listener fires

  const all = writes.join('');
  assert.ok(!all.includes('\x1b[0J'), 'no unbounded ED erase while gated');
  assert.ok(!all.includes('P>'), 'no main prompt re-echo while gated');
  // The menu row IS redrawn, bounded to its own row (CR + EL, not ED).
  assert.ok(all.includes('\r\x1b[2K'), 'menu row redrawn with CR+EL');
  assert.ok(all.includes('(y/N)'), 'menu prompt re-emitted');
  unpatch();
});

test('gate off (no menu): the legacy repair behavior is unchanged', () => {
  const { bar, writes, rl, input } = makeRig();
  const unpatch = bar.patchReadlineRefresh(rl, { gate: () => false });
  bar.update();
  writes.length = 0;
  rl.prompt();
  input.write('ab');
  writes.length = 0;
  input.write('\x7f'); // Backspace -> _refreshLine
  const all = writes.join('');
  assert.ok(all.includes('\x1b[0J'), 'readline emitted its clearScreenDown erase');
  assert.ok(all.includes('STATUS'), 'reserved block repainted after the erase');
  unpatch();
});

test('gate falls back to ZERO bytes when no menu state is registered', () => {
  const { bar, writes, rl, fakeStream } = makeRig(); // no setMenuStateFn
  bar.update();
  writes.length = 0;
  const unpatch = bar.patchReadlineRefresh(rl, { gate: () => true });
  fakeStream.rows = 12;
  fakeStream.emit('resize');
  assert.equal(writes.join(''), '', 'gated with no menu: zero bytes (box-echo case)');
  unpatch();
});

/* ---- 2. _rows() prefers the DRAW stream --------------------------------- */

test('_rows() prefers the draw stream over process.stdout', () => {
  const { bar, fakeStream } = makeRig({ rows: 30 });
  // stdout still claims 24; the draw stream already knows 30.
  assert.equal(bar._rows(), 30, 'draw-stream rows win');
  fakeStream.rows = 0;               // draw stream lost its rows
  assert.equal(bar._rows(), 24, 'falls back to stdout.rows');
});

/* ---- 3. menu-aware update tail after a height change -------------------- */

test('height change while a menu is active: park at new bottom + re-emit prompt', () => {
  const { bar, writes, fakeStream } = makeRig({
    rows: 24,
    menuState: () => ({ active: true, prompt: 'Write "x" to eden space? (y/N) ', line: 'dra' }),
  });
  bar.update();                       // paints at 24 rows
  writes.length = 0;
  fakeStream.rows = 30;               // draw stream reports the GROW first
  bar.handleResize();                 // grow 24 -> 30

  const all = writes.join('');
  // The menu prompt is re-emitted on the fresh workspace bottom row (29).
  assert.ok(all.includes('\x1b[29;1H'), 'cursor parked at the new workspace bottom');
  assert.ok(all.includes('(y/N)'), 'menu prompt re-emitted');
  assert.ok(all.includes('dra'), 'draft re-echoed after the prompt');
  // The stale-bar wipe cleared the OLD geometry's reserved row (24).
  assert.ok(all.includes('\x1b[24;1H\x1b[2K'), 'old-geometry reserved row wiped');
  // The tail banks the new continuation slot AFTER parking (ESC7 after the CUP).
  const cupAt = all.indexOf('\x1b[29;1H');
  const saveAt = all.indexOf('\x1b7', cupAt);
  assert.ok(saveAt > cupAt, 'DECSC re-banked after the park');
});

test('height change with NO menu keeps the cursor-transparent restore', () => {
  const { bar, writes, fakeStream } = makeRig({ rows: 24 });
  bar.update();
  writes.length = 0;
  fakeStream.rows = 30;
  bar.handleResize();
  const all = writes.join('');
  // resize emission: save BEFORE the region reset, restore at the end.
  assert.ok(all.indexOf('\x1b7') < all.indexOf('\x1b[1;29r'), 'save precedes the new region');
  assert.ok(all.endsWith('\x1b8'), 'tail restores the saved cursor');
});

/* ---- 4. stale-geometry reserved rows are cleared on a height change ----- */

test('a shrink repaints at the NEW geometry with no stale residue', () => {
  const { bar, writes, fakeStream } = makeRig({ rows: 24 });
  bar.update();
  writes.length = 0;
  fakeStream.rows = 12;               // draw stream shrinks
  bar.handleResize();
  const all = writes.join('');
  // Region + status line move to the new 12-row geometry; rows >12 are
  // physically gone on a real screen, so nothing stale can remain.
  assert.ok(all.includes('\x1b[1;11r'), 'region re-derived for 12 rows');
  assert.ok(/\x1b\[12;1H\x1b\[2K/.test(all), 'new bottom row cleared');
  assert.ok(all.includes('\x1b[12;1HSTATUS'), 'status line repainted at row 12');
});

test('a GROW wipes the old geometry reserved row before repainting', () => {
  const { bar, writes, fakeStream } = makeRig({ rows: 24 });
  bar.update();
  writes.length = 0;
  fakeStream.rows = 30;
  bar.handleResize();
  const all = writes.join('');
  assert.ok(/\x1b\[24;1H\x1b\[2K/.test(all), 'old bottom row wiped (no duplicate bar)');
  assert.ok(all.includes('\x1b[30;1HSTATUS'), 'status line repainted at row 30');
});

/* ---- 5. same-tick resize storm is coalesced ------------------------------ */

test('handleResize dedupes the trailing re-pass across a same-tick storm', async () => {
  const { bar, writes } = makeRig({ rows: 24 });
  bar.update();
  writes.length = 0;
  // Three signals for ONE physical resize, same tick. Each runs its leading
  // pass immediately (region corrected ASAP) but only ONE trailing re-pass
  // is scheduled (setImmediate dedupe); after the microtask queue drains,
  // NO further repaints keep flowing from the storm.
  bar.handleResize();
  bar.handleResize();
  bar.handleResize();
  const leads = writes.join('').match(/\x1b\[1;\d+r/g) || [];
  await new Promise((r) => setImmediate(r));
  const all = writes.join('');
  const trails = (all.match(/\x1b\[24;1H\x1b\[2K\x1b\[24;1H/g) || []).length;
  assert.equal(leads.length, 3, 'each signal runs its leading pass');
  // After the dust settles, exactly one trailing re-pass happened (the 4th
  // repaint) and nothing more: total status repaints = 3 leads + 1 trail.
  const repaints = (all.match(/STATUS/g) || []).length;
  assert.equal(repaints, 4, `3 leading + 1 trailing repaint, got ${repaints}`);
  assert.ok(trails >= 0); // (sanity; trailing detection is via repaint count)
});
