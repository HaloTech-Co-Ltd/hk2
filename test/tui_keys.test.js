/*-------------------------------------------------------------------------
 *
 * Unit tests for key normalization (src/tui/keys.js) — the closed vocabulary
 * every TUI component switches on.
 *
 * Run:  node --test test/tui_keys.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeKey } from '../src/tui/keys.js';

test('printable chars (incl. CJK and surrogate pairs) map to char', () => {
  assert.deepEqual(normalizeKey('a', { name: 'a' }), { type: 'char', text: 'a' });
  assert.deepEqual(normalizeKey('你', {}), { type: 'char', text: '你' });
  assert.deepEqual(normalizeKey('👍', {}), { type: 'char', text: '👍' });
});

test('ctrl+letter uses the decoded NAME, not the raw control byte', () => {
  // readline reports ctrl+c as sequence '\x03' with name 'c' — the letter
  // must come from the name (the byte is a control character, not a letter).
  assert.deepEqual(normalizeKey('\x03', { name: 'c', ctrl: true }), { type: 'ctrl', ch: 'c' });
  assert.deepEqual(normalizeKey('\x04', { name: 'd', ctrl: true }), { type: 'ctrl', ch: 'd' });
  assert.deepEqual(normalizeKey('\x15', { name: 'u', ctrl: true }), { type: 'ctrl', ch: 'u' });
});

test('ctrl+p/n/b/f alias to arrows (readline conventions)', () => {
  assert.equal(normalizeKey('\x10', { name: 'p', ctrl: true }).type, 'up');
  assert.equal(normalizeKey('\x0e', { name: 'n', ctrl: true }).type, 'down');
  assert.equal(normalizeKey('\x02', { name: 'b', ctrl: true }).type, 'left');
  assert.equal(normalizeKey('\x06', { name: 'f', ctrl: true }).type, 'right');
});

test('enter/newline family', () => {
  assert.equal(normalizeKey('\r', { name: 'return' }).type, 'enter');
  assert.equal(normalizeKey('\r', { name: 'return', meta: true }).type, 'newline'); // alt+enter
  assert.equal(normalizeKey('\n', { name: 'enter', ctrl: true }).type, 'newline'); // ctrl+j
});

test('backspace / alt-backspace / delete / tab / escape', () => {
  assert.equal(normalizeKey('\x7f', { name: 'backspace' }).type, 'backspace');
  assert.equal(normalizeKey('\x7f', { name: '', meta: true }).type, 'alt-backspace');
  assert.equal(normalizeKey('\x1b[3~', { name: 'delete' }).type, 'delete');
  assert.equal(normalizeKey('\t', { name: 'tab' }).type, 'tab');
  assert.equal(normalizeKey('\x1b', { name: 'escape' }).type, 'escape');
});

test('bracketed paste markers pass through', () => {
  assert.equal(normalizeKey('', { name: 'paste-start' }).type, 'paste-start');
  assert.equal(normalizeKey('', { name: 'paste-end' }).type, 'paste-end');
});

test('control-only bytes without a name are unknown', () => {
  assert.equal(normalizeKey('\x01', { ctrl: true }).type, 'unknown');
  assert.equal(normalizeKey('\x00', {}).type, 'unknown');
});
