/*-------------------------------------------------------------------------
 *
 * Unit tests for the TUI ModalHost (src/tui/modal.js) — FIFO prompt queue,
 * confirm / three-way / option-list semantics, rendering.
 *
 * Run:  node --test test/tui_modal.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import { ModalHost } from '../src/tui/modal.js';

const enter = { type: 'enter' };
const esc = { type: 'escape' };
const up = { type: 'up' };
const down = { type: 'down' };
const ch = (t) => ({ type: 'char', text: t });

/* ----- confirm ------------------------------------------------------------ */

test('confirm: y → true, n → false, Esc → false (decline default)', async () => {
  let h = new ModalHost();
  let p = h.open('confirm', { text: 'Run it?' });
  h.applyKey(ch('y'));
  assert.equal(await p, true);

  h = new ModalHost();
  p = h.open('confirm', { text: 'Run it?' });
  h.applyKey(ch('n'));
  assert.equal(await p, false);

  h = new ModalHost();
  p = h.open('confirm', { text: 'Run it?' });
  h.applyKey(esc);
  assert.equal(await p, false);
});

test('confirm: Enter accepts the preselected No (conservative), arrows + Enter pick Yes', async () => {
  let h = new ModalHost();
  let p = h.open('confirm', { text: 'Run it?' });
  h.applyKey(enter);
  assert.equal(await p, false, 'No is preselected');

  h = new ModalHost();
  p = h.open('confirm', { text: 'Run it?' });
  h.applyKey(up); // No(1) → Yes(0)
  h.applyKey(enter);
  assert.equal(await p, true);
});

test('three-way confirm: e → eden', async () => {
  const h = new ModalHost();
  const p = h.open('confirm', { text: 'Write to Holy?', threeWay: true });
  h.applyKey(ch('e'));
  assert.equal(await p, 'eden');
});

/* ----- option list ---------------------------------------------------------- */

const spec = {
  header: ['', 'Pick a strategy:'],
  options: [
    { row: '  1. fast (recommend)', note: '     quick and dirty' },
    { row: '  2. careful' },
    { row: '  3. something else' },
  ],
};

test('optionList: number key jumps + accepts; Esc → null', async () => {
  let h = new ModalHost();
  let p = h.open('optionList', spec);
  h.applyKey(ch('2'));
  assert.deepEqual(await p, { index: 1 });

  h = new ModalHost();
  p = h.open('optionList', spec);
  h.applyKey(esc);
  assert.equal(await p, null);
});

test('optionList: default selection is the LAST option (the conservative skip)', async () => {
  const h = new ModalHost();
  const p = h.open('optionList', spec);
  h.applyKey(enter);
  assert.deepEqual(await p, { index: 2 }, 'Enter without navigation → last option');
});

test('optionList: arrows move, note shown under the selected row', async () => {
  let h = new ModalHost();
  let p = h.open('optionList', spec);
  h.applyKey(up);   // 2 → 1
  h.applyKey(up);   // 1 → 0
  h.applyKey(down); // 0 → 1
  h.applyKey(enter);
  assert.deepEqual(await p, { index: 1 });

  h = new ModalHost();
  h.open('optionList', spec);
  h.applyKey(up);
  h.applyKey(up); // selection at the fast row
  const lines = h.render(60).join('\n');
  assert.ok(lines.includes('Pick a strategy:'));
  assert.ok(lines.includes('❯'), 'selection marker rendered');
  assert.ok(lines.includes('quick and dirty'), "selected row's note rendered");
});

/* ----- FIFO ------------------------------------------------------------------ */

test('FIFO: overlapping prompts resolve in order', async () => {
  const h = new ModalHost();
  const p1 = h.open('confirm', { text: 'first?' });
  const p2 = h.open('confirm', { text: 'second?' });
  assert.equal(h.active().spec.text, 'first?');
  h.applyKey(ch('y'));
  assert.equal(await p1, true);
  assert.equal(h.active().spec.text, 'second?', 'queue advanced');
  h.applyKey(ch('n'));
  assert.equal(await p2, false);
  assert.equal(h.active(), null);
});

/* ----- freeText + key swallowing ---------------------------------------------- */

test('freeText: isFreeText flag; the modal swallows keys (shell drives the InputBox)', async () => {
  const h = new ModalHost();
  const p = h.open('freeText', { label: '  Your approach: ' });
  assert.equal(h.isFreeText(), true);
  assert.equal(h.applyKey(down), true, 'keys consumed, not forwarded');
  assert.equal(h.applyKey(ch('x')), true);
  // shell resolves freeText itself
  h._finish({ text: 'do it', cancelled: false });
  assert.deepEqual(await p, { text: 'do it', cancelled: false });
  assert.equal(h.isFreeText(), false);
});

test('applyKey returns false when no modal is open', () => {
  const h = new ModalHost();
  assert.equal(h.applyKey(enter), false);
});
