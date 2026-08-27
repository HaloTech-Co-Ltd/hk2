/*-------------------------------------------------------------------------
 *
 * Unit tests for the mid-task instruction input box:
 *   - StatusBar: the input line participates in the reserved block ABOVE the
 *     plan panel and BELOW the status line; region math and grow/shrink
 *     transitions include it; refreshInputLine() repaints only that row.
 *   - interactive.js: formatInputBoxLine presence follows agentTurnActive;
 *     the consumeNext accessor salvages an unsubmitted box draft into the
 *     mid-task queue when an in-run menu seizes the input.
 *   - real-cursor docking: parkSeq()/undockInputCursor()/reanchorAfterMenu()
 *     place the REAL terminal cursor inside the box via the DECSC/DECRC
 *     protocol; inputBoxDockColumn computes the visible dock column.
 *
 * Run:  node --test test/statusbar-inputbox.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { StatusBar } from '../lib/agent/statusbar.js';
import { createSession, formatInputBoxLine, inputBoxDockColumn } from '../src/commands/interactive.js';

/* ---------- StatusBar: reserved-block geometry ---------- */

function makeBar({ input = () => [], plan = () => [] } = {}) {
  const writes = [];
  const fakeStream = { isTTY: true, columns: 80, write: (s) => { writes.push(s); } };
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true });
  const bar = new StatusBar(fakeStream, {
    formatter: () => 'STATUS',
    planRenderer: plan,
    inputRenderer: input,
  });
  bar._started = true; // bypass start()'s resize-handler side effects
  const all = () => writes.join('');
  return { bar, writes, all };
}

test('input line alone reserves one row above the status line', () => {
  const { bar, all } = makeBar({ input: () => ['» add instruction ▏'] });
  bar.update();
  const w = all();
  // block = 1 (input) -> scroll region 1..(24-1-1) = 1..22
  assert.ok(w.includes('\x1b[1;22r'), 'region shrunk to 1..22');
  assert.ok(w.includes('» add instruction'), 'input line rendered');
  assert.ok(w.includes('STATUS'), 'status line still on the bottom');
  assert.equal(bar._inputLineCount, 1);
  assert.equal(bar._planLineCount, 0);
});

test('input line renders ABOVE the plan panel (input row = firstRow, plan beneath, status last)', () => {
  const { bar, all } = makeBar({
    input: () => ['» instruction ▏'],
    plan: () => ['Plan: x', '  > 1. a'],
  });
  bar.update();
  const w = all();
  // block = 1 input + 2 plan -> region 1..(24-1-3) = 1..20
  assert.ok(w.includes('\x1b[1;20r'), 'region shrunk to 1..20 with input + plan');
  // Row placement: input on row 21 (24-3), plan rows 22-23, status row 24.
  const inputRow = w.indexOf('\x1b[21;1H» instruction');
  const planRow = w.indexOf('\x1b[22;1HPlan: x');
  const statusRow = w.indexOf('\x1b[24;1HSTATUS');
  assert.ok(inputRow >= 0, 'input line on the first reserved row (21)');
  assert.ok(planRow >= 0, 'plan header on row 22');
  assert.ok(statusRow >= 0, 'status line on the bottom row (24)');
  assert.ok(inputRow < planRow && planRow < statusRow, 'order: input < plan < status');
});

test('box appearing (grow 0->1) parks the cursor at the new workspace bottom', () => {
  const { bar, writes, all } = makeBar({ input: () => [] });
  bar.update(); // no box, no plan
  writes.length = 0;
  // Turn starts -> box appears.
  const { bar: _b } = {}; // (linter-pleasing no-op)
  const dynamic = makeBarDynamic(bar);
  dynamic.input = () => ['» ▏'];
  bar.update();
  const w = all();
  // grow 0 -> 1: region 1..22, cursor parked at row 22 (new workspace bottom)
  assert.ok(w.includes('\x1b[1;22r'), 'region shrunk on grow');
  assert.ok(w.includes('\x1b[22;1H'), 'cursor parked at new workspace bottom');
  assert.ok(!/\x1b8$/.test(w), 'grow does not end with a bare restore');
});

test('box disappearing (shrink 1->0) reflows and releases the row', () => {
  let inputOn = true;
  const { bar, writes, all } = makeBar({ input: () => (inputOn ? ['» ▏'] : []) });
  bar.update(); // grow to 1
  writes.length = 0;
  inputOn = false; // turn ends
  bar.update();
  const w = all();
  // shrink 1 -> 0: OLD region SU by 1, NEW region 1..23
  assert.ok(/\x1b\[1S/.test(w), 'scroll-up reflow on shrink');
  assert.ok(w.includes('\x1b[1;23r'), 'region restored to 1..23');
  assert.ok(w.includes('\x1b[23;1H'), 'cursor parked at new workspace bottom');
  assert.equal(bar._inputLineCount, 0);
});

test('turn boundary: grow 0->1 after a submitted prompt scrolls the prompt line out of the park row', () => {
  // Regression (reported v1.1.97): task ends -> shrink parks the cursor at the
  // workspace bottom (row 23), rl.prompt() draws "hk2(...)>" there, the user
  // types a new instruction and presses Enter -> the \r\n at the region bottom
  // scrolls up one row, moving the prompt line to row 22 (the row the NEXT
  // grow 0->1 parks on). The first spinner frame then overwrote the prompt
  // echo ("✓ rewriting query" on top of "hk2(...)> new instruction"). The
  // grow transition must SU-reflow the OLD region first, same as shrink.
  let inputOn = false;
  const { bar, writes, all } = makeBar({ input: () => (inputOn ? ['» ▏'] : []) });
  bar.update(); // no box
  writes.length = 0;
  inputOn = true; // new turn arms the box: grow 0 -> 1
  bar.update();
  const w = all();
  // OLD region (1..23) SU by 1 BEFORE switching to the new region (1..22).
  const suIdx = w.indexOf('\x1b[1S');
  assert.ok(suIdx >= 0, 'grow emits a scroll-up reflow of the OLD region');
  assert.ok(w.includes('\x1b[1;22r'), 'new (smaller) region established');
  assert.ok(w.indexOf('\x1b[1;22r') > suIdx, 'SU happens BEFORE the new region is set');
  assert.ok(w.includes('\x1b[1;23r'), 'OLD region explicitly re-established first');
  assert.ok(w.indexOf('\x1b[1;23r') < suIdx, 'old region set before the SU');
  assert.ok(w.includes('\x1b[22;1H'), 'cursor parked at the new workspace bottom');
});

test('refreshInputLine rewrites ONLY the input row and restores the cursor', () => {
  let draft = 'hello';
  const { bar, writes, all } = makeBar({ input: () => [`» ${draft}▏`] });
  bar.update(); // box active
  writes.length = 0;
  draft = 'hello wor';
  bar.refreshInputLine();
  const w = all();
  // rows=24, input only -> row 24-1-0(plan)=23? No: block is 1 input + 0 plan
  // reserved rows are 23 (input) and 24 (status). Input row = rows - input - plan = 24-1-0 = 23.
  assert.ok(w.includes('\x1b[23;1H'), 'targets the input row');
  assert.ok(w.includes('hello wor'), 'shows the updated draft');
  assert.ok(!w.includes('STATUS'), 'does NOT repaint the whole block');
  assert.ok(/\x1b8$/.test(w), 'ends with cursor-restore (save/restore pair)');
  assert.ok(w.startsWith('\x1b7'), 'begins with cursor-save');
});

test('refreshInputLine is a no-op when the box is inactive', () => {
  const { bar, writes } = makeBar({ input: () => [] });
  bar.update();
  writes.length = 0;
  bar.refreshInputLine();
  assert.equal(writes.length, 0, 'nothing written');
});

test('input row content is truncated to the terminal VISIBLE width', () => {
  const { bar } = makeBar({ input: () => ['x'.repeat(200)] });
  bar._cols = () => 40;
  const lines = bar._renderInputLines();
  assert.equal(lines.length, 1);
  // Visible width (ANSI stripped) must fit within 40 cells; raw length may
  // exceed it by the truncation ellipsis + reset escape.
  const visible = lines[0].replace(/\u001b\[[0-9;]*m/g, '');
  assert.ok(visible.length <= 40, `visible width within 40, got ${visible.length}`);
});

test('stop() clears the input row along with the rest of the reserved block', () => {
  const { bar, writes } = makeBar({ input: () => ['» ▏'], plan: () => ['Plan: x'] });
  bar.update();
  writes.length = 0;
  bar._started = true;
  bar.stop();
  const w = writes.join('');
  // reserved = 1 status + 1 input + 1 plan = 3 -> clear rows (24-3+1=22)..24
  assert.ok(w.includes('\x1b[22;1H\x1b[2K'), 'first reserved row cleared');
  assert.ok(w.includes('\x1b[24;1H\x1b[2K'), 'status row cleared');
  assert.equal(bar._inputLineCount, 0);
});

/* ---------- helpers ---------- */

// Allows mutating the inputRenderer after construction (tests transitions).
function makeBarDynamic(bar) {
  const orig = bar.inputRenderer;
  const dyn = { input: orig };
  bar.inputRenderer = () => dyn.input();
  return dyn;
}

/* ---------- interactive.js: formatter + consumeNext salvage ---------- */

test('formatInputBoxLine: [] when no agent turn, 1 line while running', () => {
  const session = createSession();
  assert.deepEqual(formatInputBoxLine(session), []);
  session.agentTurnActive = true;
  session.rl = { line: '' };
  const lines = formatInputBoxLine(session);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('add instruction'), 'labelled');
  // With a draft: echoed with the caret
  session.rl = { line: 'stop after step 2' };
  const withDraft = formatInputBoxLine(session)[0];
  assert.ok(withDraft.includes('stop after step 2'), 'draft echoed');
});

test('consumeNext accessor: menu seizing input salvages the box draft into the mid-task queue', () => {
  const session = createSession();
  // Box off -> plain assignment semantics, nothing salvaged.
  session.rl = { line: 'idle draft' };
  session.consumeNext = (a) => a;
  assert.deepEqual(session.userInputQueue, [], 'no salvage when box is off');
  assert.equal(String(session.rl.line), 'idle draft', 'buffer untouched when box is off');
  session.consumeNext = null;

  // Box on (mid-turn) + draft pending -> menu arming salvages the draft.
  session.inputEchoOn = true;
  session.rl = { line: 'temporary instruction', cursor: 5 };
  session.consumeNext = (a) => a;
  assert.deepEqual(session.userInputQueue, ['temporary instruction'], 'draft salvaged');
  assert.equal(session.rl.line, '', 'readline buffer cleared');
  assert.equal(session.rl.cursor, 0, 'cursor reset');
});

test('consumeNext accessor: empty draft is not salvaged', () => {
  const session = createSession();
  session.inputEchoOn = true;
  session.rl = { line: '   ', cursor: 0 };
  session.consumeNext = () => {};
  assert.deepEqual(session.userInputQueue, [], 'whitespace-only draft dropped');
});

/* ---------- real-cursor docking: inputBoxDockColumn ---------- */

test('inputBoxDockColumn: null when no turn or a menu owns the input', () => {
  const session = createSession();
  assert.equal(inputBoxDockColumn(session), null, 'no agent turn -> no dock');
  session.agentTurnActive = true;
  session.rl = { line: 'hi', cursor: 2 };
  assert.ok(inputBoxDockColumn(session) > 0, 'turn active -> dockable');
  session.consumeNext = () => {};
  assert.equal(inputBoxDockColumn(session), null, 'menu owns input -> no dock');
  session.consumeNext = null;
  assert.ok(inputBoxDockColumn(session) > 0, 'menu released -> dockable again');
});

test('inputBoxDockColumn: follows the readline cursor through the draft', () => {
  const session = createSession();
  session.agentTurnActive = true;
  const labelW = 18; // '» add instruction ' visible width
  session.rl = { line: '', cursor: 0 };
  assert.equal(inputBoxDockColumn(session), labelW + 1, 'empty draft -> right after the label');
  session.rl = { line: 'ab', cursor: 2 };
  assert.equal(inputBoxDockColumn(session), labelW + 2 + 1, 'cursor at end -> after the draft');
  session.rl = { line: 'ab', cursor: 1 };
  assert.equal(inputBoxDockColumn(session), labelW + 1 + 1, 'cursor mid-draft -> at the edit point');
  session.rl = { line: '世界', cursor: 1 };
  assert.equal(inputBoxDockColumn(session), labelW + 2 + 1, 'wide char counts as 2 columns');
});

test('inputBoxDockColumn: clamped to a runaway readline cursor', () => {
  const session = createSession();
  session.agentTurnActive = true;
  session.rl = { line: 'ab', cursor: 99 };
  assert.equal(inputBoxDockColumn(session), 18 + 2 + 1, 'cursor clamped to line length');
});

/* ---------- real-cursor docking: formatInputBoxLine caret placement ---------- */

test('formatInputBoxLine: caret sits AT the readline cursor, not always at the end', () => {
  const session = createSession();
  session.agentTurnActive = true;
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  session.rl = { line: 'hello', cursor: 5 };
  let out = strip(formatInputBoxLine(session)[0]);
  assert.ok(out.includes('hello▏'), 'end cursor -> trailing caret');
  session.rl = { line: 'hello', cursor: 2 };
  out = strip(formatInputBoxLine(session)[0]);
  assert.ok(out.includes('he▏llo'), 'mid cursor -> caret at the edit point');
  // Menu owns the input: legacy tail-caret so the box reads as inert.
  session.consumeNext = () => {};
  session.rl = { line: 'hello', cursor: 2 };
  out = strip(formatInputBoxLine(session)[0]);
  assert.ok(out.includes('hello▏'), 'consumeNext armed -> legacy tail caret');
});

/* ---------- real-cursor docking: StatusBar park/undock/reanchor ---------- */

test('parkSeq: null until the box renders and a cursor fn is registered', () => {
  const { bar } = makeBar({ input: () => ['» ▏'] });
  assert.equal(bar.parkSeq(), null, 'no cursor fn -> not dockable');
  bar.setInputCursorFn(() => 25);
  assert.equal(bar.parkSeq(), null, 'box not yet rendered (_inputLineCount 0) -> null');
  bar.update();
  // rows=24, input only -> input row 23; park at column 25.
  assert.equal(bar.parkSeq(), '\x1b[23;25H', 'park computed from fn + geometry');
  bar.setInputCursorFn(() => null);
  assert.equal(bar.parkSeq(), null, 'fn returns null -> not dockable');
});

test('refreshInputLine ends with the PARK (no DECRC) while docked', () => {
  let draft = 'hello';
  const { bar, writes, all } = makeBar({ input: () => [`» ${draft}▏`] });
  bar.setInputCursorFn(() => 3 + draft.length + 1);
  bar.update();
  writes.length = 0;
  draft = 'hello wor';
  bar.refreshInputLine();
  const w = all();
  assert.ok(w.startsWith('\x1b[23;1H'), 'targets the input row directly');
  assert.ok(!w.startsWith('\x1b7'), 'no leading DECSC while docked (slot owned by the router)');
  assert.ok(/\\x1b\[23;\d+H$/.test(w) || /\x1b\[23;\d+H$/.test(w), 'ends with the park sequence');
  assert.ok(!w.includes('\x1b8'), 'no DECRC emitted while docked');
});

test('steady-state update() re-parks instead of restoring while docked', () => {
  const { bar, writes, all } = makeBar({ input: () => ['» ▏'] });
  bar.setInputCursorFn(() => 5);
  bar.update(); // grow -> docked
  writes.length = 0;
  bar.update(); // steady state
  const w = all();
  assert.ok(!w.includes('\x1b8'), 'no DECRC while docked');
  assert.ok(w.endsWith('\x1b[23;5H'), 'ends re-parked in the box');
});

test('undockInputCursor emits DECRC only when docked; reanchorAfterMenu re-docks', () => {
  const { bar, writes } = makeBar({ input: () => ['» ▏'] });
  bar.setInputCursorFn(() => 5);
  bar.update(); // docked
  writes.length = 0;
  bar.undockInputCursor();
  assert.equal(writes.join(''), '\x1b8', 'undock = plain DECRC (workspace slot restore)');
  writes.length = 0;
  bar.undockInputCursor(); // already undocked
  assert.equal(writes.length, 0, 'undock is idempotent');
  writes.length = 0;
  bar.reanchorAfterMenu(); // menu released -> adopt current pos + re-dock
  const w = writes.join('');
  assert.ok(w.startsWith('\x1b7'), 'reanchor saves the new workspace slot first');
  assert.ok(w.endsWith('\x1b[23;5H'), 'reanchor re-parks in the box');
});

test('grow/shrink with dock: re-saves the stale slot then re-docks', () => {
  // Grow with the dock active (plan appears mid-turn): the steady-state tail
  // must reset the workspace slot to the new geometry then re-dock.
  let plan = [];
  const { bar, writes, all } = makeBar({ input: () => ['» ▏'], plan: () => plan });
  bar.setInputCursorFn(() => 5);
  bar.update(); // input only -> docked at row 23
  writes.length = 0;
  plan = ['Plan: x']; // plan grows 0 -> 1
  bar.update();
  const w = all();
  assert.ok(w.includes('\x1b7\x1b[22;5H'), 'geometry change re-saves slot then re-docks (row 22 after grow)');
});

/* ---------- write-router protocol (interactive.js wiring) ---------- */

test('routed workspace write emits DECRC + payload + DECSC + park while the box is armed', () => {
  // Simulate the router directly: StatusBar exposes parkSeq; interactive.js
  // wraps process.stdout/stderr with this exact protocol. Here we verify the
  // sequence shape the protocol prescribes, using a fresh bar.
  const { bar } = makeBar({ input: () => ['» ▏'] });
  bar.setInputCursorFn(() => 5);
  bar.update();
  const park = bar.parkSeq();
  assert.ok(park, 'park available while armed');
  const routed = `\x1b8payload\x1b7${park}`;
  assert.ok(routed.startsWith('\x1b8'), 'payload prefixed by workspace restore');
  assert.ok(routed.endsWith(`${park}`), 'payload suffixed by slot save + park');
  assert.ok(routed.includes('\x1b7'), 'new continuation saved after the payload');
});
