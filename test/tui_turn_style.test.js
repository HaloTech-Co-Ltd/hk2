/*-------------------------------------------------------------------------
 *
 * Unit tests for the Claude Code-style TURN rendering in the TUI: compact
 * tool lines (tool_card.js) and the tui_ui stream/usage behaviors.
 *
 * Run:  node --test test/tui_turn_style.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { compactToolHeader, compactToolResult } from '../src/commands/tool_card.js';
import { makeTuiUi } from '../src/tui/tui_ui.js';
import { createSession } from '../src/commands/session_ctx.js';

const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/* ----- compact tool lines ---------------------------------------------- */

test('compactToolHeader: ● + TitleCase tool + (arg), per-tool argument picking', () => {
  assert.ok(plain(compactToolHeader('bash', { command: 'echo hi' })).includes('● Bash(echo hi)'));
  assert.ok(plain(compactToolHeader('read', { path: '/a/b.js' })).includes('● Read(/a/b.js)'));
  // Display names map internal ids to user-facing labels (review §5.5).
  assert.ok(plain(compactToolHeader('kb_search', { query: 'tokenize' })).includes('● KB Search(tokenize)'));
  assert.ok(plain(compactToolHeader('plan_step', {})).includes('● Plan Step'));
  assert.ok(plain(compactToolHeader('mcp__github__create_issue', {})).includes('● MCP: github/create_issue'));
  const long = compactToolHeader('bash', { command: 'x'.repeat(80) });
  assert.ok(plain(long).includes('…'), 'long argument truncated');
});

test('compactToolResult: bash stdout first line + "+N lines" hint', () => {
  const r = compactToolResult('bash', { ok: true, result: { exitCode: 0, stdout: 'line1\nline2\nline3', stderr: '' } });
  const p = plain(r);
  assert.ok(p.includes('⎿'), 'hook glyph');
  assert.ok(p.includes('line1'), 'first stdout line');
  assert.ok(p.includes('+2 lines'), 'remaining lines hinted');
});

test('compactToolResult: generic results render their JSON first line; errors in error color', () => {
  const g = plain(compactToolResult('kb_search', { ok: true, result: { hits: [{ n: 'x' }] } }));
  assert.ok(g.includes('⎿') && g.includes('hits'));
  const e = compactToolResult('bash', { ok: false, error: 'boom' });
  assert.ok(plain(e).includes('Error: boom'), 'error text always present');
  // Color mode is environment-dependent (NO_COLOR/TERM=dumb → none, 256-color
  // terminals → quantized). Assert SEMANTICALLY: styled output differs from
  // the plain text in a color-capable environment, equals it when disabled.
  if (!process.env.NO_COLOR && !process.env.HK2_NO_COLOR && process.env.TERM !== 'dumb') {
    assert.notEqual(e.includes('\x1b['), -1, 'some ANSI styling in color mode');
  }
});

/* ----- tui_ui stream: response opener + collapsed thinking -------------- */

function fakeFrame() {
  const out = [];
  return {
    out,
    write: (s) => out.push(s),
    writeLine: (s = '') => out.push(s + '\n'),
    requestRender: () => {},
  };
}

test('tui_ui.stream: answers render as PLAIN text — no bullet opener (M18)', () => {
  const frame = fakeFrame();
  const ui = makeTuiUi(frame, createSession(null), { open: () => {} });
  ui.stream.reset();
  ui.stream.delta('Hello');          // buffered (no source newline yet)
  ui.stream.flushMarkdown();         // flush output renders too
  const joined = plain(frame.out.join(''));
  assert.ok(joined.includes('Hello'), 'answer text rendered');
  assert.ok(!joined.includes('●'), 'NO bullet on prose answers');
  // A second window is equally plain.
  frame.out.length = 0;
  ui.stream.reset();
  ui.stream.delta('second\n');
  const j2 = plain(frame.out.join(''));
  assert.ok(j2.includes('second') && !j2.includes('●'));
});

test('tui_ui.stream: thinking = live preview block + one collapsed summary (M23)', () => {
  delete process.env.HK2_HIDE_THINKING;
  const frame = fakeFrame();
  const ui = makeTuiUi(frame, createSession(null), { open: () => {} });
  ui.stream.reset();
  // Reasoning NEVER renders live (M28: hidden — the footer phase spinner is
  // the only signal); deltas just mark/times the window.
  ui.stream.reasoning('The user asks');
  ui.stream.reasoning(' a simple comparison');
  ui.stream.reasoning(' and more thinking\nline two\nline three');
  const st = ui.uiState.thinking;
  assert.equal(st.active, true, 'window active while thinking');
  assert.equal(plain(frame.out.join('')).trim(), '', 'transcript untouched during thinking');
  // Flush collapses to ONE dim summary line; second flush is a no-op.
  frame.out.length = 0;
  const out = ui.stream.flushReasoning();
  assert.ok(plain(out).includes('Thought for'), `summary line: ${plain(out)}`);
  assert.equal(st.active, false, 'window cleared');
  frame.out.length = 0;
  ui.stream.flushReasoning();
  assert.equal(frame.out.length, 0, 'no duplicate flush output');
});

test('tui_ui.usageLine: appends the turn duration', () => {
  const frame = fakeFrame();
  const session = createSession(null);
  session.turnStart = Date.now() - 2500;
  const ui = makeTuiUi(frame, session, { open: () => {} });
  ui.usageLine('✓ usage · ↑1k ↓10');
  const p = plain(frame.out.join(''));
  assert.ok(/[12]\.[0-9]s/.test(p), `duration appended: ${p}`);
});

test('tui_ui.toolStart/toolEnd: blank line + compact header, then the ⎿ result', () => {
  const frame = fakeFrame();
  const ui = makeTuiUi(frame, createSession(null), { open: () => {} });
  ui.toolStart({ name: 'bash' }, { command: 'echo hi' });
  ui.toolEnd({ name: 'bash' }, { ok: true, result: { exitCode: 0, stdout: 'hi', stderr: '' } });
  const p = plain(frame.out.join(''));
  assert.ok(p.includes('● Bash(echo hi)'));
  assert.ok(p.includes('⎿') && p.includes('hi'));
});

/* ----- tui_io: the ctx prompt primitives over modals --------------------- */

test('tui_io: print routes to frame; choose maps modal result to 1-based, cancel → last', async () => {
  const out = [];
  const frame = { write: () => {}, writeLine: (s = '') => out.push(s), requestRender: () => {} };
  const { makeTuiIo } = await import('../src/tui/tui_io.js');
  const { ModalHost } = await import('../src/tui/modal.js');
  const host = new ModalHost();
  const io = makeTuiIo(frame, host);
  io.print('hello');
  assert.equal(out[0], 'hello');

  // choose: open the modal, answer option 2 via applyKey
  const p = io.choose('Pick:', ['a', 'b', 'c']);
  setImmediate(() => host.applyKey({ type: 'char', text: '2' }));
  assert.equal(await p, 2, '1-based index');
  // cancel (Esc) → last option (conservative skip, replIo contract)
  const p2 = io.choose('Pick:', ['a', 'b']);
  setImmediate(() => host.applyKey({ type: 'escape' }));
  assert.equal(await p2, 2, 'cancel → last');
  // empty options → null without opening
  assert.equal(await io.choose('x', []), null);
});

test('tui_io: confirm resolves boolean; confirmThreeWay resolves "eden"', async () => {
  const frame = { write: () => {}, writeLine: () => {}, requestRender: () => {} };
  const { makeTuiIo } = await import('../src/tui/tui_io.js');
  const { ModalHost } = await import('../src/tui/modal.js');
  const host = new ModalHost();
  const io = makeTuiIo(frame, host);
  const p = io.confirm('go?');
  setImmediate(() => host.applyKey({ type: 'char', text: 'y' }));
  assert.equal(await p, true);
  const p2 = io.confirmThreeWay('holy?');
  setImmediate(() => host.applyKey({ type: 'char', text: 'e' }));
  assert.equal(await p2, 'eden');
});
