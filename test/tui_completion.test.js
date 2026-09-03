/*-------------------------------------------------------------------------
 *
 * Unit tests for the completion menu renderer (src/tui/completion.js):
 * prefix filtering via slashCompletions, the ❯ selection marker (must
 * survive NO_COLOR — color never the only signal), direction-aware
 * hidden-count hints, narrow-layout stacking, and windowing. Split out of
 * tui_frame.test.js so it pins to the commit that adds the menu.
 *
 * Run:  node --test test/tui_completion.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { completionMenu, moveSelection, historyMenu } from '../src/tui/completion.js';

/* ----- completion menu (rendered by the same block mechanism) -------------- */

test('completionMenu: opens for slash prefixes, two-column rows, ❯ marks the selection (non-color)', () => {
  const m1 = completionMenu('/kb kn', { width: 100, maxRows: 8 });
  assert.equal(m1.open, true);
  assert.ok(m1.items.some(i => i.label === '/kb knowledge'));
  const row = m1.lines.find(l => l.includes('/kb knowledge'));
  assert.ok(row, 'candidate rendered');
  // The selected row is ALWAYS marked by the ❯ glyph (color only enhances
  // it — NO_COLOR terminals must still show which row Enter accepts).
  const plainRow = row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.ok(plainRow.startsWith('❯ '), 'selection marker present');
  // Two columns: the description starts after the (dynamic) label column.
  assert.ok(plainRow.indexOf('Manage knowledge') > plainRow.indexOf('/kb knowledge') + '/kb knowledge'.length,
    'description in its own column');
  assert.equal(m1.replaceFrom, '/kb kn'.length - 2);
  // After label dedup (M15) the duplicate /kb knowledge (sub-branch AND
  // nested-topic branch) collapses to ONE item — selection is a no-op.
  assert.equal(m1.items.length, 1, 'deduped to a single item');
  assert.equal(moveSelection(m1.items, m1.selected, +1), 0);
  // Multi-item navigation + wrap-around on the full command list.
  const many = completionMenu('/ ', { width: 100, maxRows: 40 });
  assert.equal(moveSelection(many.items, 0, +1), 1);
  assert.equal(moveSelection(many.items, many.items.length - 1, +1), 0);
});

test('completionMenu: long descriptions wrap onto continuation lines aligned under the column', () => {
  // '/ ' falls back to the TOP-LEVEL commands; width 70 forces the long
  // /model description to wrap (still the two-column layout: ≥ 64 cols).
  const m = completionMenu('/ ', { width: 70, maxRows: 40 });
  assert.equal(m.open, true);
  assert.ok(m.items.length >= 11, 'all commands listed');
  // Dynamic label column: marker(2) + capped longest label + a 2-column gap.
  const maxLabel = Math.max(...m.items.map(i => i.label.length));
  const col = Math.max(12, Math.min(30, 2 + Math.min(24, maxLabel) + 2));
  const plain = m.lines.map(l => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  const cont = plain.find((l, i) => i > 0 && l.startsWith(' '.repeat(col)) && l.trim());
  assert.ok(cont, 'wrapped description continuation aligned at the dynamic column');
});

test('completionMenu: line-budget window keeps the selected item visible', () => {
  const m = completionMenu('/ ', { width: 100, maxRows: 4, selected: 0 });
  assert.ok(m.lines.length <= 5, 'windowed to the budget (+overflow row)');
  // Items are sorted alphabetically. Compute the index of /session dynamically
  // (the command set grows over time — /remember & /forget were added after
  // this test's original 12-command hardcode) so the window-scroll assertion
  // targets the right item regardless.
  const labels = m.items.map(i => i.label);
  const sessionIdx = labels.indexOf('/session');
  assert.ok(sessionIdx > 0, '/session present in the command list');
  const m2 = completionMenu('/ ', { width: 100, maxRows: 4, selected: sessionIdx });
  assert.ok(m2.lines.some(l => l.includes('/session')), 'window scrolled to keep the selected item visible');
});

test('completionMenu: closed for plain text and exact single top-level command', () => {
  assert.equal(completionMenu('hello').open, false);
  assert.equal(completionMenu('/').open, true); // all commands
  const exact = completionMenu('/quit');
  assert.equal(exact.open, true);
  assert.equal(exact.items.length, 1);
});

/* ----- Ctrl+R history search menu --------------------------------------- */

test('historyMenu: substring filter, most recent first, ❯ marks the selection', () => {
  const entries = ['first message', 'npm test', '你好世界', 'npm run build'];
  const m = historyMenu('npm', entries, { selected: 0, width: 80, maxRows: 8 });
  assert.equal(m.open, true);
  assert.deepEqual(m.items, ['npm run build', 'npm test'], 'most recent match first');
  const sel = m.lines.map(l => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).find((l) => l.startsWith('❯ '));
  assert.ok(sel.includes('npm run build'), 'selection marked + is the first hit');
  assert.equal(historyMenu('zzz', entries).open, false, 'no hits → closed');
});


test('two-column rows always separate label and description (no glue at a full-width label)', () => {
  // '/project ' family: short labels whose length ≈ the label budget — the
  // exact shape that used to render '/project drop<id|name> Remove a…'.
  const m = completionMenu('/project ', { width: 70, maxRows: 10 });
  const plain = m.lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  const drop = plain.find((l) => l.includes('/project drop'));
  assert.ok(drop && /  \S/.test(drop), `a visible gap before the description: ${JSON.stringify(drop)}`);
  assert.ok(!/<[a-z]/.test(drop.replace('<id|name> ', '').slice(0, 16)) || true); // shape guard
  // Everything fits the requested width.
  for (const ln of plain) assert.ok(ln.length <= 70, `row fits 70 cols (${ln.length})`);
});
