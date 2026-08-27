/*-------------------------------------------------------------------------
 *
 * Unit tests for the mid-task instruction input box:
 *   - StatusBar: the input line participates in the reserved block ABOVE the
 *     plan panel and BELOW the status line; region math and grow/shrink
 *     transitions include it; refreshInputLine() repaints only that row.
 *   - interactive.js: formatInputBoxLine presence follows agentTurnActive;
 *     the consumeNext accessor salvages an unsubmitted box draft into the
 *     mid-task queue when an in-run menu seizes the input.
 *
 * Run:  node --test test/statusbar-inputbox.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { StatusBar } from '../lib/agent/statusbar.js';
import { createSession, formatInputBoxLine } from '../src/commands/interactive.js';

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
