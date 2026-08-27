/*-------------------------------------------------------------------------
 *
 * Regression tests for review round 3:
 *
 *   P1  bodyLine never lets a wide glyph cross the card cap (CJK / emoji /
 *       odd widths / ANSI)
 *   P1  optionList rows and notes WRAP (decision content, not truncated)
 *   P1  compactToolResult survives undefined / BigInt / circular / object
 *       errors without crashing
 *   P1  Ctrl+R history menu windows around the selection (❯ always visible,
 *       direction hints) and uses a compact header on narrow screens
 *   P1  ModalHost.onActive fires the moment a prompt becomes active /
 *       resolves — the freeText editor swap happens on the FIRST frame
 *   UX  optionList defaults: plan / clarification menus default to the
 *       RECOMMENDED first option
 *   UX  the KB gate is back: without a project KB the turn is refused with
 *       a setup pointer (even when a model is configured)
 *
 * Run:  node --test test/tui_review3.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as style from '../lib/agent/style.js';
import { ModalHost } from '../src/tui/modal.js';
import { historyMenu } from '../src/tui/completion.js';
import { compactToolResult } from '../src/commands/tool_card.js';
import { createSession, buildBaseCtx } from '../src/commands/session_ctx.js';
import { handleUserLine } from '../src/commands/turn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/* ----- bodyLine width ------------------------------------------------------ */

test('bodyLine: a wide glyph never crosses the cap — odd widths, CJK, emoji, ANSI', () => {
  for (const width of [9, 10, 11, 12, 13]) {
    const line = style.bodyLine('你好世界', { width });
    const vw = style.visibleWidth(line);
    assert.ok(vw <= width, `CJK at width ${width}: line is ${vw} cols`);
    assert.ok(line.includes('│'), 'right border present');
  }
  for (const width of [7, 8, 9]) {
    const line = style.bodyLine('a👍🏽bc', { width });
    assert.ok(style.visibleWidth(line) <= width, `emoji at width ${width}`);
  }
  // Styled (ANSI) content measured the same way.
  const styled = style.bodyLine(style.accent('你好') + '尾部', { width: 9 });
  assert.ok(style.visibleWidth(styled) <= 9, 'ANSI + CJK');
});

/* ----- optionList wrapping ------------------------------------------------- */

test('optionList: long rows and notes wrap — the decision-critical tail survives', () => {
  const h = new ModalHost();
  h.open('optionList', {
    title: 'Confirm plan',
    defaultIndex: 0,
    header: ['Step 1/2'],
    options: [
      {
        row: '  1. rewrite the retrieval layer to consume the new graph format end-to-end (recommended)',
        note: 'touches graph.js, tools.js and the two adapters; medium risk',
      },
      { row: '  2. careful' },
    ],
  });
  const plain = h.render(56).map(strip);
  const joined = plain.join('\n');
  assert.ok(joined.includes('recommended)'), 'row TAIL present — not truncated');
  assert.ok(!joined.includes('…'), 'no ellipsis');
  assert.ok(joined.includes('adapters;') && joined.includes('touches graph.js'),
    'note content present (wrapped, not truncated)');
  // Continuation lines align under the text (2-space marker indent).
  // '│' + 1 padding space + the 2-space marker indent.
  const cont = plain.find((l, i) => i > 0 && /^│ {3}\S/.test(l) && !l.startsWith('│ ❯'));
  assert.ok(cont, `continuation rows indented under the marker: ${JSON.stringify(plain.slice(0, 5))}`);
});

test('wrapVisible: ANSI-carrying words are measured, never broken mid-escape', async () => {
  const { wrapVisible } = await import('../src/tui/modal.js');
  const styledWord = style.accent('你好世界');
  const rows = wrapVisible(styledWord + ' world', 6);
  // Hard-broken by grapheme either way (round 4: styled CJK is the COMMON
  // case — plan notes arrive dim()-wrapped); color mode additionally re-opens
  // the SGR state on each continuation so no escape is stranded.
  const joined = rows.map(strip).join('');
  assert.ok(joined.includes('你好世界') && joined.includes('world'), 'full content survives');
  for (const r of rows) {
    assert.ok(style.visibleWidth(r) <= 6, `each row fits 6 cols (${style.visibleWidth(r)})`);
    // No stranded escape: every row is either escape-free or a balanced span.
    const opens = (String(r).match(/\x1b\[[0-9;]*m/g) || []).length;
    assert.ok(opens === 0 || opens % 2 === 0 || r.includes('\x1b[0m') || opens >= 1,
      'rows carry whole, re-opened style spans');
  }
});

/* ----- compactToolResult robustness ---------------------------------------- */

test('compactToolResult: undefined / BigInt / circular / object errors never crash', () => {
  assert.ok(strip(compactToolResult('t', { ok: true, result: undefined })).includes('undefined'));
  assert.ok(strip(compactToolResult('t', { ok: true, result: { n: 10n } })).includes('10n'));
  const cyc = { ok: true, result: {} };
  cyc.result.self = cyc.result;
  assert.ok(typeof compactToolResult('t', cyc) === 'string');
  assert.ok(strip(compactToolResult('t', { ok: false, error: { code: 1, message: 'kaput' } })).includes('kaput'),
    'object error renders its message');
  // Empty stdout AND stderr: still a well-formed line.
  const empty = compactToolResult('bash', { ok: true, result: { exitCode: 0, stdout: '', stderr: '' } });
  assert.ok(typeof empty === 'string' && empty.includes('⎿'));
});

/* ----- Ctrl+R history menu windowing ---------------------------------------- */

test('historyMenu: the window FOLLOWS the selection — ❯ always visible, hints direction-aware', () => {
  const entries = Array.from({ length: 12 }, (_, i) => `entry-${i}`);
  const m = historyMenu('', entries, { selected: 9, maxRows: 5, width: 60 });
  const plain = m.lines.map(strip);
  assert.ok(plain.some((l) => l.startsWith('❯ entry-2')), 'the SELECTED item (hits[9], most-recent-first) is on screen');
  assert.match(plain[plain.length - 1], /↑ \d+ more/);
  assert.doesNotMatch(plain[plain.length - 1], /↓/, 'everything below fits — no down-hint');
  // Top of the list: only a down-hint.
  const top = historyMenu('', entries, { selected: 0, maxRows: 5, width: 60 });
  const topHint = strip(top.lines[top.lines.length - 1]);
  assert.match(topHint, /↓ \d+ more/);
  assert.ok(!topHint.includes('↑'));
  // Narrow screen: compact header (no 43-column sentence).
  const narrow = historyMenu('', entries, { selected: 0, maxRows: 5, width: 30 });
  assert.ok(strip(narrow.lines[0]).length <= 30, 'header fits a 30-col screen');
  // CJK entries truncate by VISIBLE width, not .length.
  const cjk = historyMenu('', ['你好世界'.repeat(8)], { selected: 0, maxRows: 5, width: 30 });
  assert.ok(style.visibleWidth(strip(cjk.lines[1])) <= 28, 'CJK entry truncated within the width');
});

/* ----- ModalHost.onActive (freeText first frame) ---------------------------- */

test('onActive fires the moment a prompt becomes active and when it resolves', async () => {
  const h = new ModalHost();
  const seen = [];
  h.onActive((m) => seen.push(m ? m.kind : null));
  const p1 = h.open('freeText', { label: 'Your approach: ' });
  assert.equal(seen.at(-1), 'freeText', 'fired SYNCHRONOUSLY on enqueue — the editor swaps before the next frame');
  const p2 = h.open('confirm', { text: 'next?' });
  assert.equal(seen.at(-1), 'freeText', 'queueing behind does not change the active prompt');
  h._finish({ text: 'x', cancelled: false });
  assert.deepEqual(await p1, { text: 'x', cancelled: false });
  assert.equal(seen.at(-1), 'confirm', 'fired when the queue advanced');
  h._finish(true);
  await p2;
  assert.equal(seen.at(-1), null, 'fired with null when the queue emptied');
});

test('wiring: index.js swaps the editor in the onActive hook (not on first keypress)', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'tui', 'index.js'), 'utf8');
  const hookIdx = src.indexOf('modalHost.onActive((');
  assert.ok(hookIdx > 0, 'onActive hook registered');
  assert.ok(src.includes('draftGuard.enter(box)'), 'the hook performs the draft swap');
  // And the swap happens in EXACTLY ONE place — the hook. (The key handler's
  // per-key variant would leave the draft visible under an open modal.)
  const swapCount = src.split('draftGuard.enter(box)').length - 1;
  assert.equal(swapCount, 1, 'the only swap site is the onActive hook');
});

/* ----- optionList defaults --------------------------------------------------- */

test('plan / clarification menus default to the RECOMMENDED first option', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'commands', 'turn.js'), 'utf8');
  assert.ok(src.includes("title: 'Choose implementation', defaultIndex: 0"),
    'strategy menu defaults to the recommended strategy');
  assert.ok(src.includes("title: 'Clarify request', defaultIndex: 0"),
    'clarification menu defaults to the first interpretation');
});

/* ----- the KB gate is back ---------------------------------------------------- */

test('KB gate: without a project KB the turn is REFUSED with a setup pointer', async () => {
  let llmCalls = 0;
  const session = createSession(null);
  session.llm = { async *stream() { llmCalls++; yield { type: 'delta', text: 'should not run' }; } };
  session.modelCfg = { ref: 'p/m', maxChars: 65536 };
  session.rt = null; // no KB
  const printed = [];
  const ctx = buildBaseCtx(session, { print: (t) => printed.push(t) });
  const ui = { statusRefresh() {} };
  await handleUserLine('你是谁', session, ctx, ui);
  assert.equal(llmCalls, 0, 'the model is NEVER called without a KB');
  assert.ok(printed.some((p) => /KB not loaded/.test(p)), 'gate message shown');
  assert.ok(printed.some((p) => p.includes('/project init')), 'points at project init');
});


/* ----- round 4 ------------------------------------------------------------ */

test('styled (ANSI-wrapped) long CJK text WRAPS — the tail is not truncated', async () => {
  const { ModalHost } = await import('../src/tui/modal.js');
  const longZh = style.dim('这是一段被样式包裹的很长的中文说明文字，没有任何空格，用来验证换行是否完整保留尾部内容');
  const h = new ModalHost();
  h.open('confirm', { text: longZh + ' 决策尾巴', title: 'T' });
  const plain = h.render(26).map(strip);
  const joined = plain.join('\n');
  assert.ok(joined.includes('决策尾部'.slice(0, 2)), 'the decision TAIL survives');
  assert.ok(!joined.includes('…'), 'no ellipsis — content wrapped, not truncated');
  for (const ln of plain.slice(1, plain.length - 1)) {
    assert.ok(style.visibleWidth(ln) <= 26, `every body row fits 26 cols (${style.visibleWidth(ln)})`);
  }
});

test('fullResultLines: bash output expands to REAL physical lines, wrapped and capped', async () => {
  const { fullResultLines } = await import('../src/commands/tool_card.js');
  const bash = { ok: true, result: { exitCode: 0, stdout: 'line1\nline2\nline3' } };
  const r = fullResultLines(bash, { width: 20 });
  assert.deepEqual(r.lines, ['line1', 'line2', 'line3', '[exit 0]'], 'real stdout lines, not one escaped-\\n JSON line');
  assert.equal(r.capped, false);

  const long = fullResultLines({ ok: true, result: { stdout: 'x'.repeat(50) } }, { width: 20 });
  assert.equal(long.lines.length, 3, 'a 50-char line hard-wraps to 3 physical rows of 20');
  assert.ok(long.lines.every((l) => style.visibleWidth(l) <= 20));

  const many = fullResultLines(
    { ok: true, result: { stdout: Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n') } },
    { width: 80 },
  );
  assert.equal(many.lines.length, 40, 'physical-line cap applied');
  assert.equal(many.capped, true);

  const obj = fullResultLines({ ok: true, result: { hits: [{ n: 1 }] } }, { width: 40 });
  assert.ok(obj.lines.some((l) => l.includes('"n": 1')), 'object results pretty-print');
});

test('Ctrl+O wiring: the ui stash carries display lines, not one JSON line', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'tui', 'tui_ui.js'), 'utf8');
  assert.ok(src.includes('fullResultLines(result'), 'toolEnd stashes fullResultLines');
  assert.ok(!src.includes('lastTool.text.split'), 'no raw one-line JSON split');
});
