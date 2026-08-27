/*-------------------------------------------------------------------------
 *
 * Unit tests for the pure InputBox widget (src/tui/input_box.js) — editing,
 * surrogate pairs, CJK wrap/cursor math, history, backslash continuation,
 * and render basics. No TTY required anywhere.
 *
 * Run:  node --test test/tui_input_box.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import {
  initialState, applyKey, setText, text, layout, layoutLine,
  cursorScreen, render,
} from '../src/tui/input_box.js';

const ch = (c) => ({ type: 'char', text: c });
const type = (st, s, opts) => {
  let cur = st;
  let out = { state: st };
  for (const c of Array.from(s)) {
    out = applyKey(cur, ch(c), opts);
    cur = out.state;
  }
  return { state: cur, ...out };
};

/* ----- basic editing --------------------------------------------------- */

test('typing accumulates; text() joins lines', () => {
  const { state } = type(initialState({}), 'hello');
  assert.equal(text(state), 'hello');
});

test('backspace at BOL joins lines; delete at EOL joins lines', () => {
  let st = setText(initialState({}), 'ab\ncd');
  st = applyKey(st, { type: 'home' }).state;      // cursor at 'a' of line 0? home → col0 row0
  st = applyKey(st, { type: 'down' }).state;       // row 1 col 0
  st = applyKey(st, { type: 'backspace' }).state;  // join
  assert.equal(text(st), 'abcd');
  st = setText(st, 'ab\ncd');
  st = applyKey(st, { type: 'up' }).state;         // row 0 (multi-line: visual move)
  st = applyKey(st, { type: 'end' }).state;        // end of 'ab'
  st = applyKey(st, { type: 'delete' }).state;     // join forward
  assert.equal(text(st), 'abcd');
});

test('surrogate pairs: emoji inserts and deletes as ONE character', () => {
  let st = type(initialState({}), 'a👍b').state;
  assert.equal(text(st), 'a👍b');
  st = applyKey(st, { type: 'home' }).state;
  st = applyKey(st, { type: 'right' }).state;   // after 'a'
  st = applyKey(st, { type: 'right' }).state;   // after 👍 (one step)
  st = applyKey(st, { type: 'backspace' }).state; // deletes the whole pair
  assert.equal(text(st), 'ab');
});

/* ----- wrap / cursor math ------------------------------------------------ */

test('layoutLine: CJK wraps by display width, wide glyph never split', () => {
  const { rows } = layoutLine('你好你', 4);
  assert.deepEqual(rows.map(r => r.text), ['你好', '你']);
  const { rows: r2 } = layoutLine('ab你', 3);
  assert.deepEqual(r2.map(r => r.text), ['ab', '你'], 'wide glyph moved whole to the next row');
});

test('cursorScreen: CJK cursor at end of wrapped first row', () => {
  // '你好你' at width 4: cursor after the 2nd char sits at visual row 0, col 4.
  let st = type(initialState({ width: 4 }), '你好').state;
  assert.deepEqual(cursorScreen(st), { row: 0, col: 4 });
  st = applyKey(st, ch('你')).state; // now wraps to a second visual row
  assert.deepEqual(cursorScreen(st), { row: 1, col: 2 }, 'cursor after a 2-wide glyph on row 1');
});

test('up/down move one VISUAL row within a wrapped logical line', () => {
  let st = type(initialState({ width: 4 }), '你好你').state; // rows: 你好 | 你, cursor end
  st = applyKey(st, { type: 'up' }).state;   // visual row 0, snap near col 4 → after 2nd char
  const c = cursorScreen(st);
  assert.equal(c.row, 0);
  assert.ok(c.col <= 4);
  st = applyKey(st, { type: 'down' }).state;
  assert.equal(cursorScreen(st).row, 1);
});

/* ----- enter semantics ---------------------------------------------------- */

test('enter submits the joined buffer and resets; empty buffer never submits', () => {
  const { state: st } = type(initialState({}), 'one\ntwo'.replace('\\n', '') ? 'one' : '');
  const two = applyKey(st, { type: 'newline' }).state;
  const done = type(two, 'two');
  const out = applyKey(done.state, { type: 'enter' });
  assert.equal(out.submitted, 'one\ntwo');
  assert.equal(text(out.state), '');
});

test('empty buffer: enter is a no-op', () => {
  const out = applyKey(initialState({}), { type: 'enter' });
  assert.equal(out.submitted, undefined);
});

test('backslash + enter continues the line (strips the backslash)', () => {
  const { state: st } = type(initialState({}), 'part one \\');
  assert.equal(text(st), 'part one \\');
  const out = applyKey(st, { type: 'enter' });
  assert.equal(out.submitted, undefined, 'not submitted');
  assert.deepEqual(out.state.lines, ['part one ', '']);
  assert.equal(out.state.row, 1, 'cursor on the continuation line');
});

test('slash command ending in backslash SUBMITS (no continuation for commands)', () => {
  const { state: st } = type(initialState({}), '/kb init \\');
  const out = applyKey(st, { type: 'enter' });
  assert.equal(out.submitted, '/kb init \\');
});

test('alt-enter inserts a real newline', () => {
  const { state: st } = type(initialState({}), 'aa');
  const out = applyKey(st, { type: 'newline' });
  const done = type(out.state, 'bb');
  assert.equal(text(done.state), 'aa\nbb');
});

/* ----- line ops ----------------------------------------------------------- */

test('home/end/ctrl+a/e, ctrl+k (kill to EOL), ctrl+u (kill to BOL)', () => {
  let st = type(initialState({}), 'hello').state;
  st = applyKey(st, { type: 'ctrl', ch: 'a' }).state;
  assert.equal(st.col, 0);
  st = applyKey(st, { type: 'ctrl', ch: 'e' }).state;
  assert.equal(st.col, 5);
  // ctrl+k at col 2 removes 'llo'
  st = applyKey(st, { type: 'left' }).state;
  st = applyKey(st, { type: 'left' }).state;
  st = applyKey(st, { type: 'left' }).state;
  st = applyKey(st, { type: 'ctrl', ch: 'k' }).state;
  assert.equal(text(st), 'he');
  // ctrl+u at the END of the line removes everything before the cursor → empty
  st = applyKey(st, { type: 'ctrl', ch: 'u' }).state;
  assert.equal(text(st), '');
});

test('ctrl+w deletes the word before the cursor', () => {
  const { state: st } = type(initialState({}), 'one two ');
  const out = applyKey(st, { type: 'ctrl', ch: 'w' });
  assert.equal(text(out.state), 'one ');
  const out2 = applyKey(out.state, { type: 'ctrl', ch: 'w' });
  assert.equal(text(out2.state), '');
});

/* ----- ctrl+d -------------------------------------------------------------- */

test('ctrl+d: exit signal on empty buffer, forward-delete otherwise', () => {
  const out = applyKey(initialState({}), { type: 'ctrl', ch: 'd' });
  assert.equal(out.exit, true);
  const { state: st } = type(initialState({}), 'abc');
  const out2 = applyKey(st, { type: 'home' }).state ? applyKey(applyKey(st, { type: 'home' }).state, { type: 'ctrl', ch: 'd' }) : null;
  assert.equal(text(out2.state), 'bc');
});

/* ----- history ------------------------------------------------------------- */

test('history: up walks back, down walks forward, draft restored past newest', () => {
  const history = ['first', 'second', 'third'];
  const { state: st } = type(initialState({}), 'draf');
  const up1 = applyKey(st, { type: 'up' }, { history }).state;
  assert.equal(text(up1), 'third');
  const up2 = applyKey(up1, { type: 'up' }, { history }).state;
  assert.equal(text(up2), 'second');
  const down1 = applyKey(up2, { type: 'down' }, { history }).state;
  assert.equal(text(down1), 'third');
  const down2 = applyKey(down1, { type: 'down' }, { history }).state;
  assert.equal(text(down2), 'draf', 'typed draft restored after the newest entry');
});

test('history: clamped at the oldest entry; up without history is a no-op', () => {
  const history = ['only'];
  const up1 = applyKey(initialState({}), { type: 'up' }, { history }).state;
  const up2 = applyKey(up1, { type: 'up' }, { history }).state;
  assert.equal(text(up2), 'only');
  const none = applyKey(initialState({}), { type: 'up' }, { history: [] }).state;
  assert.equal(text(none), '');
});

test('history navigation only from a single-line buffer at visual row 0', () => {
  // Multi-line buffer: up moves within the text, never history.
  const history = ['past'];
  let st = type(initialState({ width: 20 }), 'aaaa\nbbbb').state;
  st = applyKey(st, { type: 'up' }, { history }).state;
  assert.equal(st.row, 0, 'moved to the previous logical line, not history');
  assert.equal(text(st), 'aaaa\nbbbb');
});

/* ----- windowing & render --------------------------------------------------- */

test('maxVisibleRows windowing: scrollTop keeps the cursor visible', () => {
  const st0 = initialState({ width: 4, maxVisibleRows: 2 });
  const { state: st } = type(st0, 'a\nb\nc\nd\ne');
  // 5 logical lines, cursor at row 4; window of 2 → scrollTop 3.
  assert.equal(st.scrollTop, 3);
  const back = applyKey(st, { type: 'up' }).state;
  assert.ok(back.scrollTop <= 3);
  const rendered = render(back, 30);
  // box = top border + ≤maxVisibleRows rows + bottom border
  assert.ok(rendered.length <= 2 + 2 + 1);
});

test('render: placeholder when empty, N-lines tag when multi-line', () => {
  const lines = render(initialState({ placeholder: 'ask anything', width: 20 }), 40);
  const plain = lines.join('');
  assert.ok(plain.includes('ask anything'), 'placeholder rendered');
  const multi = render(setText(initialState({ width: 20 }), 'a\nb'), 40);
  assert.ok(multi[0].includes('2 lines'), 'multi-line tag in the top border');
});

/* ----- grapheme cluster editing (review P2) ------------------------------ */

test('combining sequence (e + U+0301) edits as ONE character, width 1', () => {
  const eAcute = 'é';
  let st = type(initialState({}), 'a' + eAcute + 'b').state;
  assert.equal(text(st), 'a' + eAcute + 'b');
  // cursor before the cluster, right passes it in one step
  st = applyKey(st, { type: 'home' }).state;
  st = applyKey(st, { type: 'right' }).state;  // after 'a'
  st = applyKey(st, { type: 'right' }).state;  // after é (ONE step)
  st = applyKey(st, { type: 'backspace' }).state; // deletes the whole cluster
  assert.equal(text(st), 'ab');
});

test('ZWJ emoji family edits as ONE character, never splits', () => {
  const family = '👨‍👩‍👧‍👦';
  let st = type(initialState({}), 'x' + family + 'y').state;
  assert.equal(text(st), 'x' + family + 'y');
  st = applyKey(st, { type: 'home' }).state;
  st = applyKey(st, { type: 'right' }).state;    // after x
  st = applyKey(st, { type: 'right' }).state;    // after family (ONE step)
  st = applyKey(st, { type: 'backspace' }).state; // whole family gone
  assert.equal(text(st), 'xy');
});

test('skin-tone modifier edits with its base emoji', () => {
  const thumbs = '👍🏽';
  let st = type(initialState({}), thumbs).state;
  st = applyKey(st, { type: 'backspace' }).state;
  assert.equal(text(st), '');
});

test('layoutLine wraps families whole (no mid-cluster break)', async () => {
  const { layoutLine } = await import('../src/tui/input_box.js');
  const family = '👨‍👩‍👧‍👦';
  // 6 families = 12 cols; at width 5 → rows of 2+2+2 (never split)
  const six = family.repeat(6);
  const { rows } = layoutLine(six, 5);
  // Every row is a whole number of family clusters (2 per 5-col row).
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal((r.text.match(/👨/g) || []).length, (r.text.match(/👧/g) || []).length,
      'each row holds whole family clusters');
    assert.ok(r.width <= 5, 'row fits the wrap width');
  }
});
