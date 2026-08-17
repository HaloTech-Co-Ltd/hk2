/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/agent/markdown.js — streaming markdown renderer,
 * focusing on GFM table rendering: terminal-fit column shrinking and
 * multi-line cell wrapping (long content wraps instead of overflowing
 * the terminal; frame and alignment stay correct; nothing truncated).
 *
 * Run:  node --test test/markdown_table.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { MarkdownStream, renderTable, wrapStyled } from '../lib/agent/markdown.js';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const strip = (s) => String(s).replace(ANSI, '');

/** Visible width (CJK-aware), matching markdown.js `cellWidth`. */
function visW(s) {
  let w = 0;
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x1100 && (
      (cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF)
    ) ? 2 : 1;
  }
  return w;
}

/** Extract grid cells from a rendered (stripped) table: data[rowIdx][colIdx]. */
function extractCells(rendered) {
  const lines = strip(rendered).split('\n').filter(l => l.includes('│'));
  return lines.map(l => l.split('│').slice(1, -1).map(c => c.trim()));
}

/* ------------------------------------------------------------------ */
/* wrapStyled                                                          */
/* ------------------------------------------------------------------ */

test('wrapStyled wraps plain text at word boundaries', () => {
  const out = wrapStyled('The quick brown fox jumps over the lazy dog', 10);
  assert.deepEqual(out, ['The quick', 'brown fox', 'jumps over', 'the lazy', 'dog']);
});

test('wrapStyled hard-breaks unbreakable tokens (URLs)', () => {
  const out = wrapStyled('https://example.com/very/long/path', 8);
  for (const frag of out) {
    assert.ok(visW(frag) <= 8, `fragment too wide: ${JSON.stringify(frag)}`);
  }
  // Content preserved: concatenation equals the original (no chars lost).
  assert.equal(out.join(''), 'https://example.com/very/long/path');
});

test('wrapStyled preserves CJK content across hard breaks', () => {
  const text = '这是一个很长的中文句子需要被强制换行处理';
  const out = wrapStyled(text, 6);
  assert.equal(out.join(''), text);
  for (const frag of out) assert.ok(visW(frag) <= 6);
});

test('wrapStyled keeps ANSI state across line boundaries', () => {
  const bold = '\x1b[1mbold text spanning multiple lines here\x1b[0m';
  const out = wrapStyled(bold, 10);
  assert.ok(out.length > 1);
  for (const frag of out) {
    // Every emitted fragment must be style-balanced: opens with SGR and
    // closes with reset, so padding/borders never inherit the style.
    assert.ok(frag.startsWith('\x1b[1m'), `continuation lost style: ${JSON.stringify(frag)}`);
    assert.ok(frag.endsWith('\x1b[0m'), `continuation not reset: ${JSON.stringify(frag)}`);
  }
  // Word-boundary wrapping drops the breaking space — acceptable; every
  // non-space character must survive.
  assert.equal(out.map(strip).join('').replace(/ /g, ''), 'boldtextspanningmultiplelineshere');
});

test('wrapStyled keeps multiple stacked SGR styles reopened correctly', () => {
  const s = '\x1b[1m\x1b[38;2;107;114;128mbold colored text that wraps\x1b[0m';
  const out = wrapStyled(s, 8);
  assert.ok(out.length > 1);
  for (const frag of out) {
    assert.ok(frag.startsWith('\x1b[1m\x1b[38;2;107;114;128m'));
    assert.ok(frag.endsWith('\x1b[0m'));
  }
});

test('wrapStyled returns short text unwrapped', () => {
  assert.deepEqual(wrapStyled('short', 10), ['short']);
  assert.deepEqual(wrapStyled('', 10), ['']);
});

test('wrapStyled single glyph wider than width still emitted', () => {
  // A CJK char (width 2) with width 1: must not be dropped or split.
  const out = wrapStyled('汉字', 1);
  assert.equal(out.join(''), '汉字');
});

/* ------------------------------------------------------------------ */
/* renderTable — fitting / wrapping                                    */
/* ------------------------------------------------------------------ */

const WIDE_TABLE = [
  '| 命令 | 说明 |',
  '|---|---|',
  '| /kb search | 在知识库中检索符号，支持自然语言查询和精确名称匹配 |',
  '| /kb stats | 显示当前项目知识库的统计信息，包括文件数、符号数和索引状态 |',
];

test('renderTable: table narrower than terminal keeps single-line rows (no regression)', () => {
  const out = renderTable(WIDE_TABLE, { width: 200 });
  const dataLines = strip(out).split('\n').filter(l => l.includes('│'));
  // header + 2 data rows = 3 framed lines, each single-line.
  assert.equal(dataLines.length, 3);
  const last = strip(dataLines[1]);
  assert.ok(last.includes('/kb search') || last.includes('kb') && last.includes('search'), `row missing: ${last}`);
  assert.ok(last.includes('在知识库中检索符号，支持自然语言查询和精确名称匹配'));
});

test('renderTable: overflowing table wraps and never exceeds the terminal width', () => {
  const out = renderTable(WIDE_TABLE, { width: 40 });
  for (const line of out.split('\n')) {
    assert.ok(visW(line) <= 40, `line too wide (${visW(line)}): ${JSON.stringify(strip(line))}`);
  }
});

test('renderTable: wrapped table preserves every character of every cell', () => {
  const out = renderTable(WIDE_TABLE, { width: 40 });
  const cells = extractCells(out);
  // header row: 1 line; data rows: variable height. Reconstruct per column.
  const colA = cells.slice(1).map(r => r[0]).join('');
  const colB = cells.slice(1).map(r => r[1]).join('');
  assert.ok(colA.includes('kbsearch'), `col A incomplete: ${JSON.stringify(colA)}`);
  assert.ok(colB.includes('在知识库中检索符号，支持自然语言查询和精确名称匹配'));
  assert.ok(colB.includes('显示当前项目知识库的统计信息，包括文件数、符号数和索引状态'));
});

test('renderTable: wrapped rows stay rectangular (equal-height cells per row)', () => {
  const out = renderTable(WIDE_TABLE, { width: 40 });
  const lines = strip(out).split('\n').filter(l => l.includes('│'));
  const sepCount = out.split('\n').filter(l => strip(l).includes('┼')).length;
  assert.equal(sepCount, 1); // exactly one header separator
  // Every framed line has the same visible structure: 2 columns => 3 borders.
  for (const l of lines) {
    assert.equal((l.match(/│/g) || []).length, 3);
  }
});

test('renderTable: alignment markers honoured on wrapped rows', () => {
  const rows = [
    '| name | value |',
    '|---|---:|',
    '| alpha | 12345678901234567890 |',
  ];
  const out = renderTable(rows, { width: 30 });
  const dataLines = strip(out).split('\n').filter(l => l.includes('│') && !l.includes('name'));
  // Right-aligned column: continuation line "0" hugs the right border.
  assert.ok(dataLines.some(l => /\│\s+0\s*│\s*$/.test(l.replace(/\x1b\[[0-9;?]*m/g, '')) || /│\s+0 │/.test(l)), `right-align continuation missing: ${dataLines.map(strip)}`);
});

test('renderTable: single-column table wraps within width', () => {
  const rows = [
    '| very long single column of text that goes on and on |',
    '|---|',
    '| aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee |',
  ];
  const out = renderTable(rows, { width: 25 });
  for (const line of out.split('\n')) assert.ok(visW(line) <= 25);
  const cells = extractCells(out);
  const joined = cells.slice(1).map(r => r[0]).join(' ').replace(/\s+/g, ' ');
  assert.ok(joined.includes('aaaaaaaaaa bbbbbbbbbb'));
  assert.ok(joined.includes('cccccccccc dddddddddd'));
  assert.ok(joined.endsWith('eeeeeeeeee'));
});

/* ------------------------------------------------------------------ */
/* MarkdownStream end-to-end                                           */
/* ------------------------------------------------------------------ */

test('MarkdownStream renders a wide table with wrapping via opts/env width', () => {
  const md = new MarkdownStream({ width: 40 });
  const out = md.feed(WIDE_TABLE.join('\n') + '\n\nafter\n');
  const flushed = md.flush();
  const full = out + flushed;
  // Table content preserved — extract cells so wrapped fragments of one
  // logical cell can be re-joined (columns interleave across physical lines).
  const cells = extractCells(full);
  const colB = cells.map(r => r[1] || '').join('').replace(/\s+/g, '');
  const colA = cells.map(r => r[0] || '').join('').replace(/\s+/g, '');
  assert.ok(colB.includes('在知识库中检索符号，支持自然语言查询和精确名称匹配'), `col B incomplete: ${colB}`);
  assert.ok(colB.includes('显示当前项目知识库的统计信息，包括文件数、符号数和索引状态'));
  assert.ok(colA.includes('kbsearch'));
  // ...and stays within the width budget.
  for (const line of full.split('\n')) {
    assert.ok(visW(line) <= 40, `too wide: ${JSON.stringify(strip(line))}`);
  }
});

/* ------------------------------------------------------------------ */
/* tableWidth fallback: non-TTY (piped) stdout keeps natural layout    */
/* ------------------------------------------------------------------ */

test('renderTable with no width and unknown stdout.columns keeps natural single-line rows', () => {
  const saved = process.stdout.columns;
  const savedErr = process.stderr.columns;
  try {
    process.stdout.columns = undefined;
    process.stderr.columns = undefined;
    const out = renderTable(WIDE_TABLE);
    const dataLines = strip(out).split('\n').filter(l => l.includes('│'));
    assert.equal(dataLines.length, 3); // header + 2 rows, single-line each
  } finally {
    process.stdout.columns = saved;
    process.stderr.columns = savedErr;
  }
});
