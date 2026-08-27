/*-------------------------------------------------------------------------
 *
 * Unit tests for the TUI chrome (src/tui/chrome.js) — the Claude Code-style
 * welcome card, open-rules input area, and footer line. Pure strings.
 *
 * Run:  node --test test/tui_chrome.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import * as style from '../lib/agent/style.js';
import { renderWelcome, renderInputChrome, renderRule, renderFooter } from '../src/tui/chrome.js';
import { createSession } from '../src/commands/session_ctx.js';

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/* ----- welcome card ------------------------------------------------------ */

test('welcome: rounded box, left facts + right tips panel with a separator', () => {
  const session = createSession(null);
  session.project = { name: 'demo', sourcePath: '/tmp/demo' };
  session.modelCfg = { ref: 'prov/model-x' };
  session.rt = { knowledgeBySpace: { holy: [], eden: [] } }; // fully configured
  const lines = renderWelcome(session, 96);
  const all = plain(lines.join('\n'));
  assert.ok(lines[0].includes('╭'), 'rounded top border');
  assert.ok(lines[lines.length - 1].includes('╰'), 'rounded bottom border');
  assert.ok(all.includes('hk2 v'), 'version in the title');
  assert.ok(all.includes('Welcome back!'), 'heading on the left (Claude Code shape)');
  assert.ok(all.includes('demo'), 'project fact on the left');
  assert.ok(all.includes('prov/model-x'), 'model fact on the left');
  assert.ok(all.includes('Tips for getting started'), 'tips panel header');
  assert.ok(all.includes('│') && lines.some(l => (plain(l).match(/│/g) || []).length >= 3),
    'left/right separator column inside the box');
  assert.ok(!all.includes('Getting set up'), 'no setup section when everything is configured');
});

test('welcome: incomplete setup renders a Getting-set-up panel, not a warning wall', () => {
  const lines = renderWelcome(createSession(null), 96);
  const all = plain(lines.join('\n'));
  assert.ok(all.includes('Getting set up'));
  assert.ok(all.includes('/project init'));
  assert.ok(all.includes('/model add'));
});

test('welcome rows are width-stable (right border always at the same column)', () => {
  const session = createSession(null);
  session.project = { name: 'demo', sourcePath: '/tmp/demo' };
  session.modelCfg = { ref: 'prov/model-x' };
  const lines = renderWelcome(session, 96);
  for (const ln of lines.slice(1, -1)) {
    // strip ANSI, every body row must end with │ at the same visible column
    const p = plain(ln);
    assert.ok(p.endsWith('│'), `body row ends with the vertical border: ${JSON.stringify(p.slice(-6))}`);
    assert.equal(style.visibleWidth(ln), 96, `row width is exactly 96: ${JSON.stringify(p.slice(0, 20))}…`);
  }
});

/* ----- input chrome -------------------------------------------------------- */

test('input chrome: full-width rules above and below, ❯ prompt on the first row', () => {
  const lines = renderInputChrome(['hello world'], '', 60);
  const p0 = plain(lines[0]);
  const p2 = plain(lines[2]);
  assert.ok(p0.startsWith('─') && p0.trimEnd().length >= 58, 'top rule spans the width');
  assert.ok(p2.startsWith('─'), 'bottom rule');
  assert.ok(plain(lines[1]).startsWith('❯'), 'prompt glyph on the first editable row');
  assert.ok(plain(lines[1]).includes('hello world'));
});

test('input chrome: continuation rows indent under the prompt; placeholder when empty', () => {
  const lines = renderInputChrome(['one', 'two'], '', 60);
  assert.ok(plain(lines[1]).startsWith('❯ one'));
  assert.ok(plain(lines[2]).startsWith('  two'), 'continuation indented, no second prompt glyph');
  const empty = renderInputChrome([], 'Message hk2', 60);
  assert.ok(plain(empty[1]).includes('❯') && plain(empty[1]).includes('Message hk2'));
});

test('renderRule: spans the given width', () => {
  const r = plain(renderRule(40));
  assert.equal(style.visibleWidth(r), 40);
});

/* ----- footer --------------------------------------------------------------- */

test('footer: armed shows the Claude Code exit wording', () => {
  const p = plain(renderFooter(createSession(null), 80, { armed: true }));
  assert.ok(p.includes('Press Ctrl-C again to exit'));
});

test('footer: idle shows hint + model chip; busy shows a spinner phase + usage', () => {
  const s = createSession(null);
  s.modelCfg = { ref: 'prov/m1', maxChars: 1000000 };
  const idle = plain(renderFooter(s, 90, { busy: false }));
  assert.ok(idle.includes('enter send'));
  assert.ok(idle.includes('\\+enter newline'), 'newline hint lives in the footer now');
  assert.ok(idle.includes('prov/m1') && idle.includes('ready'));
  s.phase = 'streaming';
  s.tokens = { loopPeakIn: 1200, loopPeakOut: 300 };
  const busy = plain(renderFooter(s, 90, { busy: true, queued: 2 }));
  assert.ok(busy.includes('esc to interrupt'));
  assert.ok(busy.includes('queued: 2'));
  assert.ok(busy.includes('streaming'));
  assert.ok(busy.includes('↑'));
});

test('footer: narrow width keeps the hint, drops the chip', () => {
  const s = createSession(null);
  s.modelCfg = { ref: 'prov/model-with-a-long-name', maxChars: 1000 };
  const p = plain(renderFooter(s, 24, { busy: false }));
  assert.ok(p.includes('enter send'));
  assert.ok(!p.includes('prov/'), 'chip dropped when it cannot fit');
});
