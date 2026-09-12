/*-------------------------------------------------------------------------
 *
 * Byte-level unit tests for the TUI Frame (src/tui/frame.js) — the
 * reserved-bottom-region manager generalizing the StatusBar scroll-region
 * algorithm to a block stack. Uses the same fake-TTY harness as
 * test/statusbar-plan.test.js.
 *
 * Run:  node --test test/tui_frame.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { Frame } from '../src/tui/frame.js';

function makeFrame(blocks, { rows = 24, cols = 80 } = {}) {
  const writes = [];
  const fakeStream = { isTTY: true, columns: cols, write: (s) => { writes.push(s); } };
  const frame = new Frame(fakeStream, { blocks, rows, cols });
  frame._started = true; // bypass start()'s resize-handler side effects
  return { frame, writes, all: () => writes.join('') };
}

const statusBlock = (text = 'STATUS') => ({ name: 'status', render: () => [text] });
const inputBlock = (lines, cursor) => ({
  name: 'input',
  render: () => lines,
  ...(cursor ? { cursor: () => cursor } : {}),
});

/* ----- region geometry -------------------------------------------------- */

test('single status block: region 1..rows-1, status on the last row, steady cursor restored', () => {
  const { frame, all } = makeFrame([statusBlock('STATUS')]);
  frame.update();
  const w = all();
  assert.ok(w.includes('\x1b[1;23r'), 'scroll region is 1..23 (24 rows, 1 reserved)');
  assert.ok(w.includes('\x1b[24;1HSTATUS'), 'status drawn on the bottom row');
  assert.ok(w.endsWith('\x1b8'), 'steady state restores the saved cursor');
  assert.equal(frame._total, 1);
});

test('grow: input box appears → region shrinks, all rows drawn, cursor parked', () => {
  let inputLines = []; // box hidden at first
  const { frame, all } = makeFrame([
    { name: 'input', render: () => inputLines },
    statusBlock('STATUS'),
  ]);
  frame.update(); // only the status line
  frame._prevTotal = frame._total;
  inputLines = ['╭─ hk2 ─╮', '│ a    │', '╰──────╯'];
  frame.blocks[0] = { name: 'input', render: () => inputLines };
  frame.update();
  const w = all();
  assert.ok(w.includes('\x1b[1;20r'), 'region shrunk to 1..20 (4 reserved rows)');
  assert.ok(w.includes('\x1b[21;1H╭─ hk2 ─╮'), 'box top border drawn on row 21');
  assert.ok(w.includes('\x1b[24;1HSTATUS'), 'status still on the bottom row');
  assert.ok(!w.endsWith('\x1b8'), 'transition parks the cursor (no stale restore)');
});

test('shrink: box collapses → NO scroll, larger region, stale rows cleared', () => {
  let inputLines = ['╭╮', '││', '╰╯'];
  const { frame, all } = makeFrame([
    { name: 'input', render: () => inputLines },
    statusBlock('STATUS'),
  ]);
  frame.update(); // 4 reserved
  frame._prevTotal = frame._total;
  inputLines = [];
  frame.update();
  const w = all();
  assert.ok(!/\x1b\[\d+S/.test(w), 'clearing scrolls NOTHING (content stays put)');
  assert.ok(w.includes('\x1b[1;23r'), 'new larger region 1..23');
  assert.ok(w.includes('\x1b[21;1H\x1b[2K'), 'stale reserved rows cleared');
});

/* ----- the single-writer invariant --------------------------------------- */

test('write() parks UNDER the content (Claude Code geometry), at the region bottom when full', () => {
  const cursorCell = { row: 1, col: 2 };
  const mk = () => makeFrame([
    inputBlock(['╭─╮', '│ab│', '╰─╯'], cursorCell),
    statusBlock('STATUS'),
  ]);
  // With content above (12 rows): park right under it (row 13).
  {
    const { frame, writes } = mk();
    frame.update();
    frame._contentRows = 12;
    frame._cursorIn = 'input';
    writes.length = 0;
    frame.write('x\n');
    assert.ok(writes.join('').startsWith('\x1b[13;1H'), 'parks under the content');
  }
  // Empty workspace (boot): park at the TOP — content flows from the top.
  {
    const { frame, writes } = mk();
    frame.update();
    frame._cursorIn = 'input';
    writes.length = 0;
    frame.write('x\n');
    assert.ok(writes.join('').startsWith('\x1b[1;1H'), 'parks at the top when there is no content');
  }
  // Full workspace: park at the region bottom (classic pinned streaming).
  {
    const { frame, writes } = mk();
    frame.update();
    frame._contentRows = 20; // region bottom for total=4 at 24 rows
    frame._cursorIn = 'input';
    writes.length = 0;
    frame.write('x\n');
    assert.ok(writes.join('').startsWith('\x1b[20;1H'), 'parks at the workspace bottom when full');
  }
});

test('write() with newlines relocates the unpinned block synchronously under the content', () => {
  const { frame, writes } = makeFrame([statusBlock('STATUS')]);
  frame.update();
  writes.length = 0;
  frame._contentRows = 0;
  frame._cursorIn = 'workspace';
  frame.write('hello\nworld\n');
  const w = writes.join('');
  // Interior newlines now carry an erase (M17: no ghost prompts on blank
  // lines), so the byte string is 'hello\n\x1b[2Kworld\n\x1b[2K'.
  assert.ok(w.includes('hello\n\x1b[2Kworld\n\x1b[2K'));
  assert.equal(frame._contentRows, 2);
  // Block moved down: the status is drawn at row 3 (content 2 rows + 1).
  assert.ok(w.includes('\x1b[3;1HSTATUS'), 'reserved block drawn under the new content');
});

test('write() from workspace state emits no park prefix', () => {
  const { frame, writes } = makeFrame([statusBlock()]);
  frame.update();
  assert.equal(frame._cursorIn, 'workspace');
  writes.length = 0;
  frame.write('x');
  assert.equal(writes.join(''), 'x');
});

/* ----- clipping ----------------------------------------------------------- */

test('oversized stack clips TOP lines; the status line always survives', () => {
  const tall = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  const { frame, all } = makeFrame([
    { name: 'modal', render: () => tall },
    statusBlock('STATUS'),
  ]);
  frame.update();
  const w = all();
  assert.ok(!w.includes('line-0'), 'topmost clipped lines not drawn');
  assert.ok(w.includes('STATUS'), 'status line survives clipping');
  assert.equal(frame._total, 23, 'reserved capped at rows-1');
});

/* ----- lifecycle ------------------------------------------------------------ */

test('stop(): reset region, clear reserved rows, cursor to bottom', () => {
  const { frame, all } = makeFrame([inputBlock(['│x│', '╰─╯'], { row: 0, col: 1 }), statusBlock()]);
  frame.update();
  frame.stop();
  const w = all();
  assert.ok(w.includes('\x1b[?25h'), 'cursor made visible again');
  assert.ok(w.includes('\x1b[1;24r'), 'scroll region reset to full screen');
  assert.ok(w.includes('\x1b[22;1H\x1b[2K'), 'reserved row cleared');
});

test('requestRender(): bursts coalesce into one update per tick', async () => {
  const { frame } = makeFrame([statusBlock()]);
  frame.update();
  frame._prevTotal = frame._total;
  const before = frame._prevTotal;
  let updates = 0;
  const orig = frame.update.bind(frame);
  frame.update = () => { updates += 1; orig(); };
  frame.requestRender();
  frame.requestRender();
  frame.requestRender();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(updates, 1, 'three requests → one redraw');
  assert.equal(before, frame._prevTotal);
  frame.stop();
});

test('resize invariant: a stale over-counted contentRows is clamped to the workspace height', () => {
  const { frame } = makeFrame([statusBlock('STATUS')]); // total 1
  frame.update();
  // Simulate content written in a LARGER window, then the window shunk to 24:
  frame._contentRows = 60;
  frame.update();
  assert.equal(frame._contentRows, 23, 'clamped to rows - total');
  // Input follows content up to the clamp — block pinned at the bottom row.
  const { frame: f2 } = makeFrame([statusBlock('STATUS')]);
  f2.update();
  f2._contentRows = 10;
  f2.update();
  assert.equal(f2._lastTop, 11, 'unpinned: block right under the content');
});

function makeResizeFrame(blocks) {
  // No opts rows: _rows() falls back to process.stdout.rows so the test can
  // redefine it to simulate a terminal resize.
  const writes = [];
  const fakeStream = { isTTY: true, columns: 80, write: (s) => { writes.push(s); } };
  const frame = new Frame(fakeStream, { blocks });
  frame._started = true;
  return { frame, all: () => writes.join('') };
}

/* ----- terminal resize: region re-derivation + cursor transparency ------- */

test('pure-height resize re-derives the DECSTBM region (stack height unchanged)', () => {
  // Regression: update() only re-emitted the region when the STACK height
  // changed. A pure height resize (input box + status heights don't depend
  // on the window) kept the STALE region reaching past the new screen
  // bottom while the block repainted at the new bottom — streaming output
  // then scrolled over the input box / status line.
  const { frame, all } = makeResizeFrame([
    { name: 'input', render: () => ['+--box--+', '| hi |', '+------+'] },
    statusBlock('STATUS'),
  ]);
  frame.update(); // 24 rows, total 4 → region 1..20
  assert.ok(all().includes('\x1b[1;20r'), 'precondition: 24-row region 1..20');
  // Resize 24 → 12 rows. Stack height unchanged (still 4).
  Object.defineProperty(process.stdout, 'rows', { value: 12, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: 12, configurable: true });
  try {
    frame.update();
    const w = all();
    assert.ok(w.includes('\x1b[1;8r'),
      'region re-derived for the new height (12 - 4 = 8)');
    // The region emission must sit AFTER the cursor save: DECSTBM homes the
    // cursor to (1,1); saving after it would bank the homed position.
    const i = w.lastIndexOf('\x1b[1;8r');
    const save = w.lastIndexOf('\x1b7', i);
    assert.ok(save >= 0 && save < i, 'new region emitted after the \\x1b7 save');
    // Steady state after the resize: no further region emission on the next
    // update (rows unchanged now).
    const before = w.length;
    frame.update();
    assert.ok(!all().slice(before).includes('\x1b[1;8r'),
      'steady state after resize does not re-emit the region');
  } finally {
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true });
  }
});

test('resize grows the window: region follows the new height too', () => {
  const { frame, all } = makeResizeFrame([statusBlock('STATUS')]);
  frame.update(); // 24 rows, total 1 → region 1..23
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: 40, configurable: true });
  try {
    frame.update();
    assert.ok(all().includes('\x1b[1;39r'), 'region re-derived for 40 rows (1..39)');
  } finally {
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true });
  }
});
