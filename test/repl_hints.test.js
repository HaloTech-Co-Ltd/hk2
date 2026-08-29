/*-------------------------------------------------------------------------*/

/**
 * Integration tests for the REPL live slash-command hint menu
 * (src/commands/repl_hints.js).
 *
 * These drive a REAL readline Interface in terminal mode over a PassThrough
 * pair — readline's private-surface machinery (_ttyWrite dispatch, keypress
 * decoding, cursor geometry, deferred wrap) only exists in terminal mode,
 * and the hint menu rides exactly that surface.
 *
 * Driving convention: bytes go through `input.write(...)` so they pass the
 * SAME emitKeypressEvents decoder a real TTY uses — rl.write() pushes raw
 * chars straight into _ttyWrite without decoding control sequences, which
 * is not how a terminal delivers keys. The lone-ESC case emits the decoded
 * 'keypress' event directly to skip the parser's 500ms escape timeout.
 *
 * Assertion convention: the output stream is CUMULATIVE and every menu row
 * carries ANSI styling between the '❯' marker and the label, so assertions
 * run on ANSI-STRIPPED text, scoped to the segment emitted since a mark
 * taken before the action under test.
 */
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { createReplHints } from '../src/commands/repl_hints.js';
import { SLASH_COMMANDS } from '../src/slash/index.js';
import { completionMenu } from '../src/tui/completion.js';
import { visibleWidth } from '../lib/agent/style.js';

const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * Minimal VT100 cursor simulator: replays the CUMULATIVE output stream and
 * tracks the PHYSICAL caret — the quantity neither the byte-wise assertions
 * above nor the pty e2e ever checked (which is exactly how the "caret parks at
 * the tail of the suggestion list" defect survived an all-green suite).
 * Supports the sequences this code path actually emits: printable text with
 * deferred (pending) wrap, CR, LF (with bottom scroll), CUU/CUD/CUF/CUB, CHA
 * (readline's absolute-column repaint), and EL 0/1/2.
 */
function vt(rows, cols) {
  const screen = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let r = 0, c = 0, wrap = false;
  const scrollUp = () => { screen.shift(); screen.push(Array(cols).fill(' ')); };
  const put = (ch) => {
    if (wrap) { r++; c = 0; wrap = false; if (r >= rows) { scrollUp(); r = rows - 1; } }
    screen[r][c] = ch;
    if (c === cols - 1) wrap = true; else c++;
  };
  const feed = (data) => {
    const s = typeof data === 'string' ? data : data.toString();
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i));
        if (!m) { i += 2; continue; }            // unknown escape: skip
        const arg = m[1].replace(/\?/g, '');
        const n = Math.max(1, parseInt(arg || '1', 10) || 1);
        switch (m[2]) {
          case 'A': r = Math.max(0, r - n); wrap = false; break;
          case 'B': r = Math.min(rows - 1, r + n); wrap = false; break;
          case 'C': c = Math.min(cols - 1, c + n); wrap = false; break;
          case 'D': c = Math.max(0, c - n); wrap = false; break;
          case 'G': c = Math.min(cols - 1, Math.max(0, n - 1)); wrap = false; break;
          case 'K': {
            const mode = parseInt(arg || '0', 10) || 0;
            const from = mode === 1 ? 0 : c;
            const to = mode === 0 ? cols - 1 : (mode === 1 ? c : cols - 1);
            for (let x = from; x <= to; x++) screen[r][x] = ' ';
            break;                                // EL never moves the caret
          }
          default: break;                          // H/J/etc: not on this path
        }
        i += m[0].length;
        continue;
      }
      if (ch === '\r') { c = 0; wrap = false; }
      else if (ch === '\n') { if (r === rows - 1) scrollUp(); else r++; wrap = false; }
      else if (ch === '\x08') { c = Math.max(0, c - 1); }
      else if (ch >= ' ') put(ch);
      i++;
    }
  };
  return {
    feed,
    cursor: () => ({ r, c, wrap }),
    rows: () => rows,
    rowText: (n) => screen[n].join('').replace(/\s+$/, ''),
  };
}

/** The edit position the caret must rest at: prompt + line[..cursor], wrapped
 *  — with the deferred-wrap parking rule (a exactly-full last row parks at
 *  that row's last column, since (row+1, 0) does not exist on screen yet).
 *  The block anchor is the LAST row on screen that starts with the prompt:
 *  after a submit the app re-prompts one row lower, so row 0 is stale. */
function editPos(h, sim, cols) {
  const prompt = String(h.rl._prompt ?? '');
  const anchor = prompt.replace(/\s+$/, '');   // rowText() strips trailing blanks
  let promptRow = 0;
  for (let r = sim.rows() - 1; r >= 0; r--) {
    if (sim.rowText(r).startsWith(anchor)) { promptRow = r; break; }
  }
  const line = String(h.rl.line ?? '');
  const c = Math.max(0, Math.min(h.rl.cursor ?? 0, line.length));
  const w = visibleWidth(prompt) + visibleWidth(line.slice(0, c));
  const row = Math.floor(w / cols);
  const col = w % cols;
  const pending = w > 0 && w % cols === 0;
  return pending
    ? { r: promptRow + row - 1, c: cols - 1 }
    : { r: promptRow + row, c: col };
}

/** Build a terminal-mode readline pair with the hint menu installed. */
function harness({ prompt = 'P> ', columns = 80, rows = 40, session = null } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = readline.createInterface({
    input, output, terminal: true, prompt,
    // Production wires makeCompleter here; Tab with zero candidates must
    // then be a no-op (matches interactive.js behaviour).
    completer: (line, cb) => cb(null, [[], line]),
  });
  rl.on('line', () => { /* drain */ });
  output.columns = columns; // rl.columns delegates here (read-only on rl)
  output.rows = rows;       // menu row budget derives from this
  const hints = createReplHints({ rl, session, stream: output });
  const bytes = [];
  output.on('data', (b) => bytes.push(b.toString()));
  const out = () => bytes.join('');
  const mark = () => out().length;
  const seg = (m) => strip(out().slice(m));
  const key = (name, extra = {}) => input.emit('keypress', extra.seq ?? '', { name, ...extra });
  return { rl, hints, out, strip, mark, seg, input, output, key, close: () => { hints.dispose(); rl.close(); } };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('menu opens on / and lists the visible commands; typing filters it live', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    let m = h.mark();
    h.input.write('/');
    await tick();
    // The pure call tells us exactly which labels the row budget can show
    // (15 commands window to 14 lines — parse the RENDERED rows, not the
    // item list, so a wrapped-away tail item can never fail the test).
    const visible = [...completionMenu('/', { width: 80, maxRows: 14, dyn: {} }).lines]
      .map(strip).join('\n').match(/\/(\w+)/g) || [];
    assert.ok(visible.length >= 10, 'sanity: most commands visible');
    for (const label of visible) {
      assert.ok(h.seg(m).includes(label), `menu lists ${label}`);
    }

    m = h.mark();
    h.input.write('se');
    await tick();
    const rows = [...h.seg(m).matchAll(/❯\s*\S+/g)].map((x) => x[0]);
    assert.ok(rows.length >= 1, 'a menu row is painted');
    assert.ok(rows.every((r) => r.includes('/session')), '/se keeps only /session');
    assert.equal(h.rl.line, '/se');
  } finally { h.close(); }
});

test('typing a non-slash line never opens the menu', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    const m = h.mark();
    h.input.write('hello world');
    await tick();
    assert.ok(!h.seg(m).includes('❯'), 'no menu rows for plain text');
    assert.ok(!h.seg(m).includes('more'), 'no hidden-count hint either');
  } finally { h.close(); }
});

test('navigation moves the selection and redraws', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    h.input.write('/c'); // → /clear, /compact (2 items, alphabetical)
    await tick();
    // The last '❯' row of the current paint is the selection.
    const selRows = () => [...h.strip(h.out()).matchAll(/❯ (\S+)/g)].map((x) => x[1]);
    assert.equal(selRows().at(-1), '/clear', 'row 0 selected initially');
    h.input.write('\x1b[B'); // down
    await tick();
    assert.equal(selRows().at(-1), '/compact', 'down moves the selection');
    h.input.write('\x1b[A'); // up
    await tick();
    assert.equal(selRows().at(-1), '/clear', 'up restores the selection');
    h.input.write('\x1b[6~'); // pagedown (jumps 5, clamps to the last item)
    await tick();
    assert.equal(selRows().at(-1), '/compact', 'pagedown lands on the last item');
  } finally { h.close(); }
});

test('Tab accepts the highlighted item into the input buffer', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    h.input.write('/mod');
    await tick();
    const m = h.mark();
    h.input.write('\t');
    await tick();
    assert.equal(h.rl.line, '/model ', 'label inserted with trailing space');
    assert.ok(h.strip(h.out()).includes('/model'), 'menu still shown after accept');
    // Issue-1 regression guard: a single-row block (g.row === 0) must NEVER
    // emit \x1b[0A in the accept repaint — xterm reads it as CUU 1 and draws
    // the input row one line ABOVE the prompt (over the transcript).
    assert.ok(!h.out().slice(m).includes('\x1b[0A'), 'no zero-parameter CUU in accept repaint');
  } finally { h.close(); }
});

test('Enter accepts unless the line is a single exact match (then submits)', async () => {
  const h = harness();
  try {
    const lines = [];
    h.rl.on('line', (l) => lines.push(l));
    h.rl.prompt();
    h.input.write('/mod');
    await tick();
    h.input.write('\r');
    await tick();
    assert.equal(h.rl.line, '/model ', 'ambiguous prefix: Enter accepts row 0');
    assert.equal(lines.length, 0, 'no line submitted on ambiguous Enter');

    h.input.write('u');
    await tick();
    h.input.write('\r');
    await tick();
    assert.ok(h.rl.line.startsWith('/model '), `accepted subcommand row: ${JSON.stringify(h.rl.line)}`);
    assert.equal(lines.length, 0, 'still no submit while navigating the menu');
  } finally { h.close(); }
});

test('exact-match Enter submits the line through readline', async () => {
  const h = harness();
  try {
    const lines = [];
    h.rl.on('line', (l) => lines.push(l));
    h.rl.prompt();
    h.input.write('/quit');
    await tick();
    h.input.write('\r');
    await tick();
    assert.deepEqual(lines, ['/quit'], 'exact match submits');
    assert.equal(h.rl.line, '', 'readline cleared the buffer after submit');
  } finally { h.close(); }
});

test('Esc dismisses the menu until the text changes', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    h.input.write('/mod');
    await tick();
    assert.ok(h.strip(h.out()).includes('❯ /model'), 'menu open');
    const m = h.mark();
    // Lone ESC: emit the decoded keypress directly (the parser waits 500ms
    // to decide ESC stands alone — see emitKeypressEvents escapeCodeTimeout).
    h.key('escape', { seq: '\x1b' });
    await tick();
    assert.ok(!h.seg(m).includes('❯'), 'menu closed by Esc');
    h.input.write('e');
    await tick();
    assert.ok(h.seg(m).includes('❯ /model'), 'text change reopens the menu');
  } finally { h.close(); }
});

test('backspace editing keeps the screen consistent and reopens', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    h.input.write('/model');
    await tick();
    h.input.write('\x7f');
    await tick();
    assert.equal(h.rl.line, '/mode');
    assert.ok(h.strip(h.out()).includes('❯ /model'), 'menu still offers /model for /mode');
    // The FINAL state (empty line) must show no menu: take the mark AFTER
    // the intermediate keystrokes and assert on the last segment only —
    // earlier backspaces legitimately paint menus for their own prefixes.
    for (let i = 0; i < 4; i++) h.input.write('\x7f');
    await tick();
    assert.equal(h.rl.line, '/');
    const m = h.mark();
    h.input.write('\x7f');
    await tick();
    assert.equal(h.rl.line, '');
    assert.ok(!h.seg(m).includes('❯'), 'menu closed once the line lost its slash');
  } finally { h.close(); }
});

test('Tab with no candidates is a plain passthrough (no crash)', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    h.input.write('/model use ');
    await tick();
    h.input.write('\t');
    await tick();
    assert.equal(h.rl.line, '/model use ', 'no candidates → Tab inserts nothing');
  } finally { h.close(); }
});

test('a long wrapped input line still anchors the menu correctly', async () => {
  // REAL wrap: prompt 'P> ' (3) + '/model set' (10) = 13 visible columns
  // against columns:12 → the block spans TWO screen rows (g.row reaches 1),
  // so every multi-row geometry path (toEdit CUU, openVisual CUD-from-caret,
  // repaintInput clear loop) is actually exercised. (The old columns:20
  // variant never wrapped: 15 < 20, g.row stayed 0 — the multi-row bugs it
  // claimed to cover were unreachable.)
  const h = harness({ columns: 12 });
  try {
    h.rl.prompt();
    h.input.write('/model');
    await tick();
    let m = h.mark();
    h.input.write(' set');
    await tick();
    // 3 + 10 = 13 > 12 → genuinely wrapped now.
    assert.equal(h.rl.line, '/model set');
    assert.ok(/❯\s*\/model\s*set/.test(h.seg(m)), 'menu renders below the wrapped block');
    // Edit on the WRAPPED block (caret on block row 1): backspace must keep
    // the menu anchored — no zero-parameter CUU, no stray CUD past the caret.
    m = h.mark();
    h.input.write('\x7f');
    await tick();
    assert.equal(h.rl.line, '/model se');
    const segRaw = h.out().slice(m);
    assert.ok(!segRaw.includes('\x1b[0A'), 'no zero-parameter CUU while editing a wrapped block');
    assert.ok(/❯\s*\/model\s*set/.test(h.seg(m)), 'menu re-renders after editing a wrapped line');
    // Accept on the WRAPPED block: the clear loop runs (old block = 2 rows)
    // and the caret must land back on the caret's row, not below it.
    m = h.mark();
    h.input.write('\t');
    await tick();
    assert.equal(h.rl.line, '/model set ');
    assert.ok(!h.out().slice(m).includes('\x1b[0A'), 'no zero-parameter CUU in wrapped accept');
  } finally { h.close(); }
});

test('gating: while an agent turn runs the menu never opens', async () => {
  const session = { agentTurnActive: true, multilineBuf: null };
  const h = harness({ session });
  try {
    h.rl.prompt();
    const m = h.mark();
    h.input.write('/mod');
    await tick();
    assert.ok(!h.seg(m).includes('❯'), 'no menu while the turn runs');
    session.agentTurnActive = false;
    h.input.write('e');
    await tick();
    assert.ok(h.seg(m).includes('❯ /model'), 'menu back after the turn');
  } finally { h.close(); }
});

test('HK2_REPL_HINTS=0 disables the feature entirely', { concurrency: false }, async () => {
  const before = process.env.HK2_REPL_HINTS;
  process.env.HK2_REPL_HINTS = '0';
  try {
    const h = harness();
    try {
      h.rl.prompt();
      const m = h.mark();
      h.input.write('/mod');
      await tick();
      assert.ok(!h.seg(m).includes('❯'), 'no menu bytes when disabled');
      assert.equal(h.rl.line, '/mod', 'typing still works');
    } finally { h.close(); }
  } finally {
    if (before === undefined) delete process.env.HK2_REPL_HINTS;
    else process.env.HK2_REPL_HINTS = before;
  }
});

test('fail-open catch never re-dispatches an already applied key', async () => {
  // Issue-4 regression: if the post-pass redraw/gated check throws, the
  // catch must NOT hand the same key to readline again — a char would be
  // inserted twice (or an Enter would submit twice). We sabotage gated()
  // via a session proxy whose 'processing' getter throws on the Nth read:
  //   throw #1 — before pass (edit branch evaluates gated() first? no: with
  //     the menu OPEN the 'edit' branch reads gated only AFTER pass, so
  //     read #1 is that post-pass call) → keyApplied must save us.
  //   A separate armed-at-branch-entry variant covers the pre-pass throw.
  const makeSession = (throwAt) => {
    let armed = false;
    let reads = 0;
    return {
      session: new Proxy({}, {
        get(t, k) {
          if (k === 'processing') {
            if (armed && ++reads === throwAt) throw new Error('boom');
            return false;
          }
          if (k === 'multilineBuf') return null;
          return undefined;
        },
      }),
      arm() { armed = true; },
    };
  };

  // Variant A: gated() throws AFTER the key was applied (edit branch's
  // post-pass gate read). Pre-fix this double-inserted the character.
  {
    const s = makeSession(1);
    const h = harness({ session: s.session });
    try {
      h.rl.prompt();
      h.input.write('/mod');
      await tick();
      assert.ok(h.out().includes('❯'), 'menu open');
      s.arm();
      h.input.write('x');   // '/modx' — no candidates, but the edit branch ran
      await tick();
      assert.equal(h.rl.line, '/modx', 'char applied exactly once despite the throw');
    } finally { h.close(); }
  }

  // Variant B: gated() throws BEFORE any dispatch (passthrough branch on a
  // CLOSED menu) — fail-open must still deliver the key exactly once.
  {
    const s = makeSession(1);
    const h = harness({ session: s.session });
    try {
      h.rl.prompt();
      h.input.write('/mo');
      await tick();
      // Close the menu via Esc so the next key takes the passthrough branch.
      h.key('escape', { seq: '\x1b' });
      await tick();
      s.arm();
      h.input.write('d');
      await tick();
      assert.equal(h.rl.line, '/mod', 'char delivered exactly once via fail-open redispatch');
    } finally { h.close(); }
  }
});

test('dispose restores readline behaviour and erases an open menu', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    h.input.write('/mod');
    await tick();
    assert.ok(h.strip(h.out()).includes('❯ /model'));
    const m = h.mark();
    h.hints.dispose();
    await tick();
    assert.ok(!h.seg(m).includes('❯ /model'), 'dispose erased the menu rows');
    h.input.write('el');
    await tick();
    assert.equal(h.rl.line, '/model', 'editing works after dispose');
    const m2 = h.mark();
    h.input.write('\x7f');
    await tick();
    assert.ok(!/\x1b\[1A/.test(h.out().slice(m2)), 'no hint choreography after dispose');
  } finally { h.close(); }
});

test('subcommand and nested-topic positions complete live', async () => {
  const h = harness();
  try {
    h.rl.prompt();
    let m = h.mark();
    h.input.write('/model se');
    await tick();
    assert.ok(h.seg(m).includes('set-default'), '/model se offers set-default');
    m = h.mark();
    h.input.write('t');
    await tick();
    assert.ok(h.seg(m).includes('set-default'), '/model set narrows correctly');
    // Clear the whole line, then a nested topic position.
    h.input.write('\x15'); // ctrl+u: kill to line start
    await tick();
    assert.equal(h.rl.line, '');
    m = h.mark();
    h.input.write('/kb kn');
    await tick();
    assert.ok(h.seg(m).includes('knowledge'), '/kb kn offers the knowledge topic');
  } finally { h.close(); }
});

// ---- physical-cursor regression suite (VT100 cursor simulation) ------------
// The defect this guards against: while the live hint menu is open, the
// physical caret must rest at the EDIT position (right after the typed
// command), NEVER parked at the tail of the suggestion list. Byte-wise
// assertions cannot see this — only replaying the output stream through a
// cursor simulator can. Pre-fix, openVisual() ended its draw at P_PARK and
// only the next keystroke's closeVisual() incidentally corrected the caret.
{
  const COLS = 80;
  /** Drive a scenario, replay the CUMULATIVE stream, assert the caret. */
  const cursorScenario = async ({ keys, columns = COLS, reprompt = false }) => {
    const h = harness({ columns });
    try {
      h.rl.prompt();
      for (const k of keys) { h.input.write(k); await tick(); }
      // Production re-prompts after each completed line (interactive.js);
      // without it the stream ends right after readline's \r\n.
      if (reprompt) h.rl.prompt();
      const sim = vt(40, columns);
      sim.feed(h.out());
      return { sim, edit: editPos(h, sim, columns) };
    } finally { h.close(); }
  };
  const assertCaretAtEdit = (sim, edit, note) => {
    const cur = sim.cursor();
    assert.ok(
      cur.r === edit.r && cur.c === edit.c,
      `${note}: caret at (${cur.r},${cur.c}), expected edit pos (${edit.r},${edit.c})`,
    );
  };

  test('VT100: menu open — caret rests at the edit position, not the list tail', async () => {
    for (const keys of [['/'], ['/m'], ['/mo'], ['/mod']]) {
      const { sim, edit } = await cursorScenario({ keys });
      assertCaretAtEdit(sim, edit, `typing ${JSON.stringify(keys.at(-1))}`);
    }
  });

  test('VT100: filter+nav+edit keep the caret at the edit position', async () => {
    {
      const { sim, edit } = await cursorScenario({ keys: ['/', 'm'] });
      assertCaretAtEdit(sim, edit, "'/m' menu open");
    }
    {
      const { sim, edit } = await cursorScenario({ keys: ['/', 'm', '\x1b[B', '\x1b[B', '\x1b[A'] });
      assertCaretAtEdit(sim, edit, 'arrow nav across the menu');
    }
    {
      const { sim, edit } = await cursorScenario({ keys: ['/', 'c'] });
      assertCaretAtEdit(sim, edit, "'/c' two-row menu");
    }
    {
      const { sim, edit } = await cursorScenario({ keys: ['/', 'm', 'o'] });
      assertCaretAtEdit(sim, edit, "'/mo' narrow");
    }
    {
      // backspace redraw: '/mo' -> backspace -> '/m'
      const { sim, edit } = await cursorScenario({ keys: ['/', 'm', 'o', '\x7f'] });
      assertCaretAtEdit(sim, edit, 'backspace redraw');
    }
    {
      const { sim, edit } = await cursorScenario({ keys: ['/', 'm', '\x1b[6~'] });
      assertCaretAtEdit(sim, edit, 'pagedown');
    }
  });

  test('VT100: accept repaints the block IN PLACE — prompt row fixed, transcript intact', async () => {
    // repaintInput regression (code-review issues 2+3): seed a transcript row
    // ABOVE the prompt, accept on a multi-row (wrapped) / deferred-wrap
    // (pending) block, and assert ABSOLUTE screen structure. editPos()-style
    // caret checks alone cannot catch a drift: they anchor to the LAST prompt
    // row dynamically, so a block that slid down takes the expectation with
    // it. Structure can: the prompt must stay on its seeded row and the
    // transcript row must survive byte-for-byte.
    const run = async (typedKeys) => {
      const h = harness({ columns: 20 });
      try {
        h.output.write('TRANSCRIPT\r\n');   // screen row 0: transcript
        h.rl.prompt();                        // screen row 1: block row 0
        await tick();
        for (const k of typedKeys) { h.input.write(k); await tick(); }
        h.input.write('\t');                  // accept → repaintInput path
        await tick();
        const sim = vt(40, 20);
        sim.feed(h.out());
        return { h, sim };
      } finally { h.close(); }
    };
    {
      // wrapped 2-row block ('/model set-default' = 3+18 = 21 > 20): pre-fix,
      // the prompt was repainted on the block's LAST row — one row lower on
      // every accept. Post-accept buffer '/model set-default ' closes the
      // menu (no candidates after the trailing space), so no menu bytes muddy
      // the structure. Assert the EXACT 2-row block: row 1 starts the buffer,
      // row 2 carries its wrap; row 3 must be BLANK (a block painted on its
      // last row leaves the wrap one row lower + a stale fragment above).
      const { h, sim } = await run(['/model set-default'.slice(0, 1), ...'/model set-default'.slice(1)]);
      assert.equal(h.rl.line, '/model set-default ', 'Tab accepted the wrapped line');
      assert.equal(sim.rowText(0), 'TRANSCRIPT', 'transcript row intact');
      assert.ok(sim.rowText(1).startsWith('P> /model set-'), `block starts on its seeded row (got: ${JSON.stringify(sim.rowText(1))})`);
      assert.equal(sim.rowText(2), 't', `wrap row carries the buffer tail (got: ${JSON.stringify(sim.rowText(2))})`);
      assert.equal(sim.rowText(3), '', `row below the block stays blank — no drift (got: ${JSON.stringify(sim.rowText(3))})`);
      assertCaretAtEdit(sim, editPos(h, sim, 20), 'wrapped accept');
    }
    {
      // deferred-wrap pending ('/model set-defaul' = 3+17 = 20 exactly fills
      // the row): pre-fix, CUU(g.row) went one row ABOVE the block and painted
      // over the transcript; physRow(g) must keep the repaint inside the
      // block. Same exact-structure assertions.
      const { h, sim } = await run(['/model set-defaul'.slice(0, 1), ...'/model set-defaul'.slice(1)]);
      assert.equal(h.rl.line, '/model set-default ', 'Tab accepted the pending line');
      assert.equal(sim.rowText(0), 'TRANSCRIPT', `transcript row intact (got: ${JSON.stringify(sim.rowText(0))})`);
      assert.ok(sim.rowText(1).startsWith('P> /model set-'), `block starts on its seeded row (got: ${JSON.stringify(sim.rowText(1))})`);
      assert.equal(sim.rowText(2), 't', `wrap row carries the buffer tail (got: ${JSON.stringify(sim.rowText(2))})`);
      assert.equal(sim.rowText(3), '', `row below the block stays blank — no drift (got: ${JSON.stringify(sim.rowText(3))})`);
      assertCaretAtEdit(sim, editPos(h, sim, 20), 'pending accept');
    }
  });

  test('VT100: Tab accept / Esc close / submit all land back at the edit position', async () => {
    {
      const { sim, edit } = await cursorScenario({ keys: ['/', 'm', 'o', 'd', '\t'] });
      assertCaretAtEdit(sim, edit, 'Tab accept');
    }
    {
      const { sim, edit } = await cursorScenario({ keys: ['/', 'm', '\x1b'] });
      assertCaretAtEdit(sim, edit, 'Esc close');
    }
    {
      // unique exact match submits: readline clears the buffer and emits \r\n;
      // the app then re-prompts — the caret must land at the fresh prompt end.
      const { sim, edit } = await cursorScenario({ keys: ['/', 'q', 'u', 'i', 't', '\r'], reprompt: true });
      assertCaretAtEdit(sim, edit, 'exact-match submit');
    }
    {
      // wrapped multi-row input block (3 + '/project' = 11 > 10 cols) — every
      // multi-row geometry path (CUU from menu tail, CUD in closeVisual, CUF
      // parking) is exercised. cols=10 keeps menu lines unwrapped (widest row
      // '  /project' is exactly 10); at truly pathological widths the menu
      // labels themselves wrap, which is a separate completionMenu limitation,
      // not a cursor-anchor defect.
      const { sim, edit } = await cursorScenario({ keys: ['/', 'p', 'r', 'o', 'j', 'e', 'c', 't'], columns: 10 });
      assertCaretAtEdit(sim, edit, 'wrapped block');
    }
    {
      // '/projec' (3 + 7 = 10) exactly fills the block's single row — the
      // deferred-wrap PENDING case. Node readline's own redraw materializes
      // the next row (trailing-space workaround), so the caret legitimately
      // rests on the materialized row (same column, edit row +1); our parking
      // convention keeps (physRow, cols-1) because repaintInput's path never
      // materializes that row — LF-parking there could SCROLL. Assert column
      // EXACTLY and row within the edit/materialized pair, never the menu.
      const { sim, edit } = await cursorScenario({ keys: ['/', 'p', 'r', 'o', 'j', 'e', 'c'], columns: 10 });
      const cur = sim.cursor();
      assert.equal(cur.c, edit.c, `pending: column must be the text-end column (got ${cur.c}, want ${edit.c})`);
      assert.ok(
        cur.r === edit.r || cur.r === edit.r + 1,
        `pending: caret row ${cur.r} must be the edit/materialized row (${edit.r}±1), not the menu tail`,
      );
    }
  });
}

