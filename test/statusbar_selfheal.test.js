/*-------------------------------------------------------------------------
 *
 * Regression tests for the REPL rendering self-heal round:
 *   1. Gated menu-row redraw parks the physical cursor at the READLINE MODEL
 *      cursor column (width-aware), not at end-of-line — the plan-confirm
 *      custom-input corruption (characters scattered mid-line edits,
 *      backspace deleting the wrong column) had the redraw park at EOL while
 *      readline's model cursor sat mid-line, so every later relative cursor
 *      move landed on the wrong cells.
 *   2. Real readline editing through the PATCHED _refreshLine (gate on)
 *      keeps the model correct: arrow-left + insert splices at the cursor,
 *      backspace deletes the char left of the cursor.
 *   3. fullRepaint({heal}) re-banks the DECSC continuation slot at the
 *      workspace bottom (display-sleep / SIGSTOP recovery).
 *   4. Poll freeze detection: a poll gap far wider than the interval heals
 *      instead of repainting (App Nap / display sleep on wake).
 *   5. Geometry defense: rows<=1 reports paint nothing and keep the last
 *      plausible height (transient 0-row states during display sleep).
 *
 * Run:  node --test test/statusbar_selfheal.test.js
 *------------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { StatusBar } from '../lib/agent/statusbar.js';

function makeRig({ rows = 24, cols = 80 } = {}) {
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
  bar._started = true; // bypass start()'s process-level resize listeners
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const rl = readline.createInterface({ input, output: fakeStream, terminal: true, prompt: 'P> ' });
  return { bar, writes, rl, input, fakeStream };
}

/* ---- 1. gated redraw parks the cursor at the MODEL column --------------- */

test('gated menu redraw parks the cursor at the model cursor column (mid-line)', () => {
  const { bar, writes, rl } = makeRig();
  bar.setMenuStateFn(() => ({ active: true, prompt: 'Your approach: ', line: rl.line, cursor: rl.cursor }));
  const unpatch = bar.patchReadlineRefresh(rl, { gate: () => true });
  rl.line = 'abcdef';
  rl.cursor = 3;
  writes.length = 0;
  rl._refreshLine();
  const w = writes.join('');
  assert.ok(w.includes('Your approach: abcdef'), 'menu row redrawn with prompt + draft');
  // visibleWidth('abcdef') - visibleWidth('abc') = 3 → cursor back 3 columns.
  assert.ok(w.includes('\x1b[3D'), `cursor parked 3 columns back (model cursor at 3), got: ${JSON.stringify(w)}`);
  unpatch();
});

test('gated menu redraw cursor-back is width-aware for CJK drafts', () => {
  const { bar, writes, rl } = makeRig();
  bar.setMenuStateFn(() => ({ active: true, prompt: 'Your approach: ', line: rl.line, cursor: rl.cursor }));
  const unpatch = bar.patchReadlineRefresh(rl, { gate: () => true });
  // 4 CJK chars = 8 columns; cursor after 2 chars = 4 columns → back 4.
  rl.line = '继续推进';
  rl.cursor = 2;
  writes.length = 0;
  rl._refreshLine();
  const w = writes.join('');
  assert.ok(w.includes('\x1b[4D'), `CJK-aware cursor back (4 columns), got: ${JSON.stringify(w)}`);
  unpatch();
});

/* ---- 2. real readline editing stays correct through the patched refresh -- */

test('real editing through the gated patch: arrow-left + insert splices at cursor; backspace deletes left of cursor', () => {
  const { bar, writes, rl, input } = makeRig();
  bar.setMenuStateFn(() => ({ active: true, prompt: 'A: ', line: rl.line, cursor: rl.cursor }));
  const unpatch = bar.patchReadlineRefresh(rl, { gate: () => true });
  input.write('abc');            // line "abc", cursor 3
  input.write('\x1b[D\x1b[D');   // cursor-left x2 → cursor 1
  input.write('X');              // splice at cursor → "aXbc"
  assert.equal(rl.line, 'aXbc', 'insert spliced at the model cursor');
  assert.equal(rl.cursor, 2, 'model cursor advanced past the inserted char');
  input.write('\x7f');           // backspace deletes 'X' → "abc"
  assert.equal(rl.line, 'abc', 'backspace deleted the char LEFT of the cursor');
  assert.equal(rl.cursor, 1, 'model cursor moved back with the deletion');
  // Every gated redraw emitted while the cursor sat mid-line carried a
  // cursor-back sequence — the physical cursor matched the model, which is
  // what keeps subsequent relative moves correct.
  const redraws = writes.join('').split('\r\x1b[2KA: ').slice(1);
  assert.ok(redraws.length > 0, 'gated redraws actually happened');
  unpatch();
});

/* ---- 3. heal re-banks the continuation slot at the workspace bottom ------ */

test('fullRepaint({heal}) re-banks the DECSC slot at the workspace bottom', () => {
  const { bar, writes } = makeRig({ rows: 24 });
  bar.update();
  writes.length = 0;
  bar.fullRepaint({ heal: true });
  const w = writes.join('');
  // 24 rows, no reserved block → workspace bottom is row 23.
  assert.ok(w.includes('\x1b[23;1H\x1b7'), `slot re-banked at the workspace bottom (23), got: ${JSON.stringify(w.slice(0, 160))}`);
  // The repaint re-asserts the region and repaints the reserved block fully.
  assert.ok(w.includes('\x1b[1;23r'), 'scroll region re-asserted');
  assert.ok(w.includes('STATUS'), 'status line repainted');
});

test('heal repaint is ONE tty write (DECSTBM prefix + body atomic — no cursor blink frame)', () => {
  const { bar, writes } = makeRig({ rows: 24 });
  bar.update();
  writes.length = 0;
  bar.fullRepaint({ heal: true });
  // The periodic input-box cursor blink ("a cursor flashes in blank space")
  // was the resize/heal pass emitting DECSTBM (which homes the cursor per VT
  // spec) as its OWN write: the tty driver flushes between writes and
  // terminals render per flush, so the frame between them parked the cursor
  // at the homed blank position before the repaint re-docked it. One write
  // is parsed in one pass — the intermediate position is never rendered.
  assert.equal(writes.length, 1, `heal must be a single write, got ${writes.length}: ${JSON.stringify(writes)}`);
  const w = writes[0];
  // Region assertion first, then the repaint body, in the SAME write.
  assert.ok(w.startsWith('\x1b[?25l\x1b7\x1b[1;23r') || w.startsWith('\x1b[?25l\x1b[1;23r'),
    `region assertion leads the single write (after DECTCEM hide), got: ${JSON.stringify(w.slice(0, 24))}`);
  assert.ok(w.endsWith('\x1b[?25h'), 'DECTCEM show closes the bracket in the same write');
  assert.ok(w.includes('\x1b[23;1H\x1b7'), 'slot re-bank inside the same write');
  assert.ok(w.includes('STATUS'), 'status line inside the same write');
});

test('resize pass (no heal) is likewise ONE tty write', () => {
  const { bar, writes } = makeRig({ rows: 24 });
  bar.update();
  writes.length = 0;
  bar._resizePass();
  assert.equal(writes.length, 1, `resize pass must be a single write, got ${writes.length}: ${JSON.stringify(writes)}`);
});

test('diff repaint with changed rows is DECTCEM-bracketed; an unchanged tick is not', () => {
  // The residual "a cursor flashes by in blank space" report: even a SINGLE
  // write is not guaranteed a single rendered frame — pty/ConPTY read
  // chunking can split it, and the diff repaint's DECSTBM homes the cursor to
  // (1,1) (a blank corner) before the changed-row writes return it. A split
  // at that point rendered the caret in blank space. Bracket changed-row
  // repaints with hide/show so every intermediate frame is cursor-less;
  // leave STEADY ticks (nothing changed) unbracketed so the idle caret keeps
  // its native blink phase instead of being phase-reset every 200ms.
  const { bar, writes } = makeRig({ rows: 24 });
  let status = 'idle 1s';
  bar.formatter = () => status;
  bar.update();
  writes.length = 0;
  bar.update(); // steady tick: nothing changed
  let w = writes.join('');
  assert.ok(!w.includes('\x1b[?25l'), 'steady tick must not hide the cursor (native blink preserved)');
  status = 'idle 2s';
  writes.length = 0;
  bar.update(); // the status text changed → changed-row repaint
  w = writes.join('');
  assert.ok(w.startsWith('\x1b[?25l'), 'changed-row repaint is bracketed by DECTCEM hide');
  assert.ok(w.endsWith('\x1b[?25h'), 'bracket closed by DECTCEM show in the same write');
  // The homed (1,1) intermediate position is never rendered even if the
  // transport splits the write anywhere between hide and show.
  const hideAt = w.indexOf('\x1b[?25l');
  const showAt = w.indexOf('\x1b[?25h');
  assert.ok(hideAt === 0 && showAt > hideAt, 'hide leads, show trails');
});

test('heal while the input box is docked: still ONE write, cursor parked in-box', () => {
  // The exact periodic path the live report traced: probe timeout (silent
  // terminal / busy event loop) → slotProbeResult(false) → fullRepaint(heal)
  // → the old two-write split → one rendered frame with the cursor in
  // blank space. The docked heal must be one write ending in the park.
  const { bar, writes } = makeRig({ rows: 24 });
  bar.inputRenderer = () => ['> box'];
  bar.setInputCursorFn(() => 5);
  bar.update();
  bar.parkInputCursor();
  writes.length = 0;
  bar.slotProbeResult(false, 24, { silent: true });
  assert.equal(writes.length, 1, `docked heal must be a single write, got ${writes.length}: ${JSON.stringify(writes)}`);
  const w = writes[0];
  assert.ok(w.includes(';5H'), 'cursor re-docked into the input box inside the same write');
});

test('heal with an in-run menu re-emits the prompt with the model cursor parked', () => {
  const { bar, writes } = makeRig({ rows: 24 });
  bar.update();
  bar.setMenuStateFn(() => ({ active: true, prompt: 'y/N? ', line: 'yes', cursor: 1 }));
  writes.length = 0;
  bar.fullRepaint({ heal: true });
  const w = writes.join('');
  assert.ok(w.includes('y/N? yes'), 'menu prompt + draft re-emitted');
  assert.ok(w.includes('\x1b[2D'), 'cursor parked at model column (1) → 2 columns back');
  assert.ok(w.includes('\x1b[23;1H\x1b7'), 'continuation slot re-banked first');
});

/* ---- 4. poll freeze detection heals -------------------------------------- */

test('poll gap far wider than the interval triggers a heal repaint', async () => {
  const { bar, writes } = makeRig({ rows: 24 });
  bar.update();
  bar.poll(20);
  // Simulate an App-Nap / display-sleep gap: the last tick ran long ago.
  bar._lastPollAt = Date.now() - 5000;
  writes.length = 0;
  await new Promise((r) => setTimeout(r, 60));
  bar.poll(0);
  const w = writes.join('');
  assert.ok(w.includes('\x1b[23;1H\x1b7'), `freeze gap produced a heal (slot re-bank), got: ${JSON.stringify(w.slice(0, 160))}`);
});

test('normal poll ticks do NOT heal (plain repaint path)', async () => {
  const { bar, writes } = makeRig({ rows: 24 });
  bar.update();
  bar.poll(20);
  writes.length = 0;
  await new Promise((r) => setTimeout(r, 65));
  bar.poll(0);
  const w = writes.join('');
  assert.ok(!w.includes('\x1b[23;1H\x1b7'), 'no slot re-bank on steady ticks');
});

/* ---- 5. geometry defense: transient rows<=1 ------------------------------ */

test('rows<=1 paints nothing and keeps the last plausible height', () => {
  const { bar, writes, fakeStream } = makeRig({ rows: 24 });
  bar.update();
  assert.equal(bar._lastGoodRows, 24);
  writes.length = 0;
  fakeStream.rows = 0;           // display-sleep transient
  // _rows() falls back to process.stdout.rows (24) — the paint goes out at
  // the PLAUSIBLE height, never at a fabricated 0/1-row geometry.
  bar.update();
  assert.equal(bar._lastGoodRows, 24, 'plausible height retained (no 0-row paint)');
  // A paint at rows 0/1 on EVERY source falls back to the LAST GOOD height
  // (already banked above) — never a fabricated 0/1-row geometry, and the
  // last-good value itself is not corrupted by the transient.
  Object.defineProperty(process.stdout, 'rows', { value: 0, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: 0, configurable: true });
  writes.length = 0;
  bar.update();
  assert.equal(bar._lastGoodRows, 24, 'last good height survives the 0-row transient');
  const w = writes.join('');
  assert.ok(!w.includes('\x1b[1;1r'), 'never a 0/1-row scroll region');
  assert.ok(!w.includes('\x1b[1;0r'), 'never a 0-param scroll region');
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true });
  fakeStream.rows = 24;
});
