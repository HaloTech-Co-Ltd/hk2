/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 *-------------------------------------------------------------------------
 * Regression tests for REPL input EDITING with non-keystroke-shaped input:
 * bracketed paste and multi-char IME commit chunks.
 *
 * Two root causes locked down here:
 *
 * 1. Node's readline inserts chars received between the 200~/201~ markers
 * at END of the edit line regardless of the cursor, and PasteHandler's
 * paste-end handler used to force `rl.cursor = rl.line.length` on top.
 * Terminals that wrap IME commits as bracketed pastes (Windows Terminal
 * with a CJK IME, several SSH clients) therefore sent every committed
 * Chinese character to end-of-line during mid-line edits. Fixed in
 * lib/agent/paste.js via a paste-start snapshot repair.
 *
 * 2. Node's emitKeypressEvents replays every character of a multi-char
 * data chunk — exactly what an IME commit looks like: 继续开始R1 with the
 * cursor mid-line, then 推进 arrives as ONE chunk — with
 * isCompletionEnabled=false except for the LAST char, so all but the last
 * are APPENDED at end-of-line: 推 to EOL, 进 spliced at cursor+1 →
 * 继续开始R进1推 instead of 继续开始推进R1 (verified against the v24.10
 * embedded source and the user's strace byte capture). Fixed in
 * lib/agent/burst_insert.js via a per-burst at-cursor repair.
 *
 * Run:  node --test test/repl_input_edit.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { PasteHandler } from '../lib/agent/paste.js';
import { repairBurstInserts } from '../lib/agent/burst_insert.js';

/**
 * A real readline.Interface over PassThrough streams with the SAME listener
 * wiring as interactive.js: createInterface first (readline's internal
 * keypress listener), then PasteHandler.start(), then repairBurstInserts().
 */
function rig() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  const rl = readline.createInterface({ input, output, prompt: '> ', terminal: true });
  const handler = new PasteHandler(output, input, rl);
  handler.start();
  const unrepair = repairBurstInserts(rl);
  output.read(); // drain echoes
  return { rl, handler, input, output, unrepair };
}

/** Let the burst repair's process.nextTick run before asserting. */
const tick = () => new Promise((r) => setImmediate(r));

const wrap = (t) => `\x1b[200~${t}\x1b[201~`;

test('IME-style paste-wrapped commits edit MID-LINE correctly (the 中文错乱 bug)', () => {
  const { rl, input } = rig();
  // Type 你好世界 via single-char bracketed commits (one per IME commit),
  // move the cursor back two chars, backspace 好 away, type the correction.
  for (const c of '你好世界') input.write(wrap(c));
  input.write('\x1b[D');   // left
  input.write('\x1b[D');   // left  → cursor between 好 and 世
  input.write('\x7f');     // backspace deletes 好
  assert.equal(rl.line, '你世界');
  assert.equal(rl.cursor, 1);
  input.write(wrap('时'));
  input.write(wrap('间'));
  assert.equal(rl.line, '你时间世界', 'correction lands at the cursor, not at EOL');
  assert.equal(rl.cursor, 3, 'cursor sits right after the corrected text');
});

test('plain single-line paste at a MID-LINE cursor inserts at the cursor', () => {
  const { rl, input } = rig();
  input.write('abcdef');
  input.write('\x1b[D\x1b[D\x1b[D'); // cursor=3
  input.write(wrap('XY'));
  assert.equal(rl.line, 'abcXYdef');
  assert.equal(rl.cursor, 5);
});

test('paste at END of line still appends (unchanged behavior)', () => {
  const { rl, input } = rig();
  input.write('hi');
  input.write(wrap('XY'));
  assert.equal(rl.line, 'hiXY');
  assert.equal(rl.cursor, 4);
});

test('multi-line paste still stashes a pendingDraft and clears the line', () => {
  const { rl, handler, input } = rig();
  input.write(wrap('first\nsecond\n'));
  assert.equal(handler.pendingDraft, 'first\nsecond');
  assert.equal(rl.line, '');
});

test('typing continues at the cursor after a mid-line paste', () => {
  const { rl, input } = rig();
  input.write('abcdef');
  input.write('\x1b[D\x1b[D\x1b[D'); // cursor=3
  input.write(wrap('XY'));
  input.write('Z');                   // plain keypress, no paste wrapper
  assert.equal(rl.line, 'abcXYZdef');
  assert.equal(rl.cursor, 6);
});

/* ------------------------------------------------------------------ */
/* Multi-char IME commit chunks (no paste markers — the strace shape)  */

test('IME multi-char chunk edits MID-LINE correctly (the 继续开始R进1推 bug)', async () => {
  const { rl, input } = rig();
  // The user's REAL byte sequence (strace-verified): each IME commit is one
  // multi-char data chunk; arrows and ASCII are single-key chunks.
  input.write('继续'); await tick();
  input.write('开始'); await tick();
  input.write('R'); input.write('1'); await tick();
  assert.equal(rl.line, '继续开始R1');
  input.write('\x1b[D'); input.write('\x1b[D'); await tick();
  assert.equal(rl.cursor, 4, 'cursor sits before R1');
  input.write('推进'); await tick();
  assert.equal(rl.line, '继续开始推进R1', 'chunk splices at the cursor, not scattered to EOL');
  assert.equal(rl.cursor, 6);
});

test('ASCII multi-char chunk at a MID-LINE cursor splices at the cursor', async () => {
  const { rl, input } = rig();
  input.write('abcdef'); await tick();
  input.write('\x1b[D\x1b[D\x1b[D'); await tick();
  assert.equal(rl.cursor, 3);
  input.write('XY'); await tick();
  assert.equal(rl.line, 'abcXYdef');
  assert.equal(rl.cursor, 5);
});

test('multi-char chunk at END of line keeps the append fast path', async () => {
  const { rl, input } = rig();
  input.write('ab'); await tick();
  input.write('cd'); await tick();
  assert.equal(rl.line, 'abcd');
  assert.equal(rl.cursor, 4);
});

test('plain typing continues at the cursor after a repaired chunk', async () => {
  const { rl, input } = rig();
  input.write('abcdef'); await tick();
  input.write('\x1b[D\x1b[D\x1b[D'); await tick();
  input.write('XY'); await tick();
  input.write('Z'); await tick();
  assert.equal(rl.line, 'abcXYZdef');
});

test('burst repair never fires when the burst contains named keys', async () => {
  const { rl, input } = rig();
  input.write('ab'); await tick();
  // Arrow embedded in the same chunk as text: tainted burst → readline's own
  // (correct) single-char handling stands; the repair must not rewrite it.
  input.write('c\x1b[D'); await tick();
  assert.equal([...rl.line].sort().join(''), 'abc');
  assert.ok(rl.cursor >= 0 && rl.cursor <= rl.line.length);
});
