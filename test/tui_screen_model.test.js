/*-------------------------------------------------------------------------
 *
 * Screen-model regression tests for the TUI Frame (src/tui/frame.js).
 *
 * HISTORY: two visual regressions (the boot card erasing itself line by
 * line; a stale input rule gluing in front of streamed text) shipped
 * because the ad-hoc verification replayed byte streams through an
 * approximate VT emulator and a dump that ignored no-content clears. These
 * tests instead replay the Frame's OWN output through a minimal but
 * FAITHFUL model — cursor addressing (H), row erase (2K), save/restore
 * cursor (\x1b7/\x1b8), scroll region (r) + scroll-up (S), column-aware
 * writes, newlines — where the LAST operation on each row wins, exactly
 * like a real terminal. If the Frame emits a sequence that erases content
 * it just wrote, leaves stale block pixels on a row that content takes
 * over, or scrolls when nothing should move, the model sees it.
 *
 * Run:  node --test test/tui_screen_model.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { Frame } from '../src/tui/frame.js';
import { renderWelcome, renderInputChrome, renderFooter } from '../src/tui/chrome.js';

const ROWS = 43, COLS = 100;

/**
 * Replay a byte stream into a last-op-wins ROW model. Named alternatives
 * keep the indices stable: CH(2) | 2K | SAVE | RESTORE | REGION(2) | SU(1)
 * | OTHER | TEXT | NL.
 */
function replayBuf(buf, rows) {
  const screen = new Array(rows + 1).fill('');
  let cur = [1, 1];
  let saved = [1, 1];
  let rtop = 1;
  let rbot = rows;
  const re = new RegExp(
    '\\x1b\\[(\\d+);(\\d+)H' // 1,2: cursor position
    + '|\\x1b\\[2K'
    + '|\\x1b\\[K'
    + '|\\x1b7|\\x1b8'
    + '|\\x1b\\[(\\d+);(\\d+)r' // 3,4: scroll region
    + '|\\x1b\\[(\\d+)S' // 5: scroll up
    + '|(\\x1b\\[[0-9;?]*[A-Za-z])' // 6: other escapes
    + '|([^\\x1b\\n\\r]+)' // 7: text
    + '|(\\n)', 'g');
  let m;
  while ((m = re.exec(buf))) {
    if (m[1]) cur = [parseInt(m[1], 10), parseInt(m[2], 10)];
    else if (m[0] === '\x1b[2K') screen[cur[0]] = '';
    else if (m[0] === '\x1b[K') screen[cur[0]] = (screen[cur[0]] || '').slice(0, cur[1] - 1);
    else if (m[0] === '\x1b7') saved = [...cur];
    else if (m[0] === '\x1b8') cur = [...saved];
    else if (m[3] !== undefined) {
      rtop = parseInt(m[3], 10);
      rbot = parseInt(m[4], 10);
    } else if (m[5] !== undefined) {
      const k = parseInt(m[5], 10);
      screen.splice(rtop, k);
      for (let i = 0; i < k; i++) screen.splice(rbot, 0, '');
    } else if (m[7]) {
      const col = cur[1] - 1;
      const line = screen[cur[0]];
      if (line.length <= col) screen[cur[0]] = line + ' '.repeat(col - line.length) + m[7];
      else screen[cur[0]] = line.slice(0, col) + m[7] + line.slice(col + m[7].length);
      cur[1] += m[7].length;
    } else if (m[8]) {
      // LF scrolls ONLY at the region's bottom margin (xterm semantics).
      if (cur[0] === rbot) {
        screen.splice(rtop, 1);
        screen.splice(rbot, 0, '');
      } else {
        cur[0] = Math.min(rows, cur[0] + 1);
      }
      cur[1] = 1;
    }
  }
  return screen;
}

const replay = (ops) => replayBuf(Array.isArray(ops) ? ops.join('') : ops, ROWS);
const replay30 = (ops) => replayBuf(Array.isArray(ops) ? ops.join('') : ops, 30);

function makeFrame() {
  const ops = [];
  const stream = { isTTY: true, columns: COLS, write: (s) => ops.push(s) };
  const frame = new Frame(stream, {
    blocks: [
      { name: 'input', render: () => renderInputChrome([], 'ph', COLS), cursor: () => ({ row: 1, col: 2 }) },
      { name: 'footer', render: () => [renderFooter({ tokens: {} }, COLS, {})] },
    ],
    rows: ROWS, cols: COLS,
  });
  frame._started = true;
  return { frame, ops };
}

test('boot: the welcome card survives line-by-line writing (no self-erasure)', () => {
  const { frame, ops } = makeFrame();
  frame.start();
  frame.cursorHome();
  const card = renderWelcome({ project: null, rt: null, modelCfg: null }, COLS);
  for (const ln of card) frame.writeLine(ln);
  frame.writeLine('');
  frame.writeLine('');
  const screen = replay(ops);
  let body = 0;
  for (let r = 2; r <= card.length - 1; r++) {
    if ((screen[r] || '').includes('│')) body++;
  }
  assert.equal(body, card.length - 2, `all ${card.length - 2} card body rows visible (got ${body})`);
  assert.ok((screen[card.length] || '').includes('╰'), 'bottom border visible');
  assert.ok((screen[card.length + 3] || '').includes('─'), 'input top rule right below the card + 2 blanks');
});

test('streaming: a parked write on the block row takes full ownership (no rule glue)', () => {
  const ops = [];
  const stream = { isTTY: true, columns: COLS, write: (s) => ops.push(s) };
  const frame = new Frame(stream, {
    blocks: [{ name: 'input', render: () => ['─RULE─', '❯ x', '─RULE2─'], cursor: () => ({ row: 1, col: 2 }) }],
    rows: ROWS, cols: COLS,
  });
  frame._started = true;
  frame.start();
  frame.cursorHome();
  for (let i = 1; i <= 5; i++) frame.writeLine('content-' + i);
  frame.write('partial answer'); // a flush with no trailing newline
  frame.write('\n');             // finishStream's bare newline
  frame.writeLine('✓ usage');
  const screen = replay(ops);
  assert.equal(screen[6], 'partial answer', 'row 6 is exactly the answer — no stale rule glued');
  assert.ok((screen[7] || '').includes('usage'));
  assert.ok((screen[8] || '').startsWith('─RULE─'), 'fresh block below the content');
  assert.ok(!(screen[5] || '').includes('RULE'), 'content row untouched');
});

test('model sanity: erase-then-write and save/restore cursor are modeled', () => {
  const screen = replay(['\x1b[2;1Hold-text', '\x1b[2;1H\x1b[2Knew']);
  assert.equal(screen[2], 'new', 'last op wins');
  const screen2 = replay(['\x1b[3;5H\x1b7\x1b[9;9Hxx\x1b8yy']);
  assert.equal(screen2[3], '    yy', 'restore-cursor returns to the saved cell');
});

test('type a long command (menu grows to pin), then clear it: content pushed up on grow, nothing moves on clear', () => {
  const ops = [];
  const stream = { isTTY: true, columns: COLS, write: (s) => ops.push(s) };
  let inputRows = ['❯ '];
  let menuRows = [];
  const frame = new Frame(stream, {
    blocks: [
      { name: 'input', render: () => inputRows, cursor: () => ({ row: 0, col: 2 }) },
      { name: 'menu', render: () => menuRows },
    ],
    rows: 30, cols: COLS,
  });
  frame._started = true;
  frame.start();
  frame.cursorHome();
  for (let i = 1; i <= 20; i++) frame.writeLine('content-' + i);
  // The user types a long slash command: the input wraps to 2 rows and the
  // completion menu opens below (10 rows) — the stack grows to 12 rows.
  inputRows = ['❯ /kb knowledge list --space=holy --', '  more-text-here'];
  menuRows = Array.from({ length: 10 }, (_, i) => '  item-' + i);
  frame.update();
  const afterGrow = ops.join('');
  const sus = afterGrow.match(/\x1b\[(\d+)S/g) || [];
  assert.deepEqual(sus, ['\x1b[2S'], 'grow pushed the transcript up by exactly the overflow (2 rows)');
  // Clear (ctrl+c): the menu closes, the stack shrinks back — NO scroll.
  inputRows = ['❯ '];
  menuRows = [];
  frame.update();
  const buf = ops.join('');
  const susAll = buf.match(/\x1b\[(\d+)S/g) || [];
  assert.deepEqual(susAll, ['\x1b[2S'], 'clearing scrolled NOTHING');
  const screen = replay30(buf);
  // Content intact, pushed up 2: rows 1..18 hold content-1..content-20's
  // tail — the LAST content row (content-20) is at row 18.
  assert.ok((screen[18] || '').includes('content-20'), `row 18 keeps content-20 (got ${JSON.stringify(screen[18])})`);
  assert.ok((screen[1] || '').includes('content-3'), 'the oldest rows scrolled off (content-3 now first)');
  // Input sits right under the content; no stale ❯ rows above it.
  assert.ok((screen[19] || '').startsWith('❯'), `input directly under the content (row 19: ${JSON.stringify(screen[19])})`);
  for (let r = 1; r <= 18; r++) {
    assert.ok(!(screen[r] || '').includes('❯'), `no stale prompt row at ${r}`);
  }
});

test('multi-line writes erase every row they enter (no ghost ❯ on paragraph blanks)', () => {
  const ops = [];
  const stream = { isTTY: true, columns: COLS, write: (s) => ops.push(s) };
  const frame = new Frame(stream, {
    blocks: [{ name: 'input', render: () => ['─RULE─', '❯ ', '─RULE2─'], cursor: () => ({ row: 1, col: 2 }) }],
    rows: 24, cols: COLS,
  });
  frame._started = true;
  frame.start();
  frame.cursorHome();
  frame.writeLine('❯ 你是');
  frame.write('  Thought for 3s\n');
  frame.write('您好！您的消息似乎没有输入完整。\n\n');  // paragraph blank
  frame.write('我是 hk2，一个助手。\n\n');              // paragraph blank
  frame.write('• 代码探索\n');
  const screen = replayBuf(Array.isArray(ops) ? ops.join('') : ops, 24);
  // Paragraph blanks must be BLANK — not ghost input prompts.
  assert.ok(!screen[4].includes('❯'), `row 4 blank, got ${JSON.stringify(screen[4])}`);
  assert.ok(!screen[6].includes('❯'), `row 6 blank, got ${JSON.stringify(screen[6])}`);
  assert.ok(screen[3].includes('您好'), 'paragraph 1 in place');
  assert.ok(screen[5].includes('我是'), 'paragraph 2 in place');
  assert.ok(screen[7].includes('代码探索'), 'bullet line in place');
});
