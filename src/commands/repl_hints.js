/*-------------------------------------------------------------------------*/

/**
 * REPL live slash-command hint menu.
 *
 * While the user types a `/`-prefixed line in the interactive readline REPL,
 * a completion menu (the SAME completionMenu() the TUI renders) appears LIVE
 * below the prompt: every keystroke re-filters the list, ↑/↓ (and
 * pageup/pagedown) move the selection, Tab / Enter accept it into the input
 * buffer, Esc / Ctrl+G dismiss it until the text changes again. Semantics
 * mirror the TUI front-end exactly (src/tui/index.js), including the
 * single-exact-match Enter rule (an exact match submits, anything else
 * accepts the highlighted row).
 *
 * HOW THIS RIDES READLINE — one private-surface patch, fail-open (same
 * contract as the _writeToOutput wrapper in interactive.js; if a future
 * Node renames the method, the feature silently turns off and the REPL
 * behaves exactly as before):
 *
 *   rl._ttyWrite is wrapped to intercept keys BEFORE readline processes
 *   them. readline registers its own keypress handler first (it IS the
 *   interface); that handler dispatches every decoded key through
 *   this._ttyWrite — dynamic dispatch, so the wrapper runs first and either
 *   swallows the key (menu navigation / accept / dismiss / submit) or lets
 *   readline edit the buffer, then re-renders the menu.
 *
 * DRAWING MODEL — the menu occupies rows DIRECTLY below the prompt+line
 * block, using ONLY relative cursor motion (LF, CUU/CUD/CUF, CR, EL):
 *
 *   - Space for the menu rows is made with LFs EMITTED FROM THE INPUT
 *     BLOCK'S LAST ROW: every LF either walks one row down or (at the
 *     scroll-region bottom) scrolls the region by one — in BOTH cases the
 *     cursor ends up exactly N rows lower. That invariant keeps the menu
 *     glued to the prompt through any terminal scrolling, with zero
 *     absolute-row bookkeeping (readline itself repaints with absolute
 *     columns like `\x1b[37G`, but always relative ROWS — after its redraw
 *     the caret sits on the correct row, which is all our relative moves
 *     need).
 *
 *   - Every visible transition is closeVisual() then openVisual() in the
 *     SAME event-loop tick — both byte strings land in one terminal frame,
 *     so erase+repaint never flickers.
 *
 * Anchor positions (all relative to wherever the caret physically is):
 *   P_EDIT — the editing position (prompt + line[..cursor], wrapped)
 *   P_END  — column 1 of the input block's LAST row
 *   P_MENU0— column 1 of the menu's first row (== one row below P_END)
 *   P_PARK — end of the menu's last painted row (a transient mid-draw
 *            position only — never where the caret is left resting)
 *
 * INVARIANT: whenever the hint layer is steady — menu open OR closed — the
 * physical caret rests at P_EDIT. openVisual() paints the menu rows (passing
 * through P_PARK) and then relocates back to P_EDIT; every other transition
 * already ended at P_EDIT. This is what makes the caret follow the typed
 * command instead of sitting at the tail of the suggestion list.
 *
 * Gating: the menu only runs while the line-REPL owns the input — never
 * during an agent turn (inputEchoOn), an in-run option menu (consumeNext),
 * the backslash-continuation prompt (multilineBuf), a pending paste draft,
 * or non-terminal (piped) mode. HK2_REPL_HINTS=0 disables it entirely.
 */
import readline from 'node:readline';
import { completionMenu } from '../tui/completion.js';
import {
  dynamicContextKey, fetchDynamicItems, currentDynamicSnapshot,
} from '../slash/completions.js';
import * as style from '../../lib/agent/style.js';

/** Visible-width of a (possibly ANSI-wrapped) string. */
const vw = (s) => style.visibleWidth(s);

/**
 * Install the live hint menu on a readline interface.
 *
 * @param {object} opts
 *   rl       — the readline Interface (must be terminal mode)
 *   session  — the REPL session (gating flags; optional in tests)
 *   stream   — output stream to draw on (defaults rl.output)
 *   getProjectId — () => string for dynamic session-id candidates
 * @returns {{dispose(): void, refresh(): void}} uninstall helper
 */
export function createReplHints({ rl, session = null, stream = null, getProjectId = null } = {}) {
  const out = stream || rl.output || process.stderr;
  if (!(rl && typeof rl._ttyWrite === 'function' && rl.terminal)
    || process.env.HK2_REPL_HINTS === '0') {
    return { dispose() {}, refresh() {} };
  }
  const origTtyWrite = rl._ttyWrite.bind(rl);

  // ---- menu state ------------------------------------------------------
  let open = false;        // a menu is currently drawn on screen
  let dismissed = false;   // user pressed Esc — stay closed until text changes
  let selected = 0;
  let prevRows = 0;        // rows the CURRENT on-screen menu occupies
  let submitting = false;  // reentry guard for the Enter-submit injection
  let dynKind = null;      // dynamic data kind last requested for this line
  let disposed = false;
  // Re-dispatch guard: true once the CURRENT key has been handed to
  // readline. The fail-open catch must never re-dispatch an applied key —
  // a char would be inserted twice and an Enter would submit twice.
  let keyApplied = false;

  const cols = () => rl.columns || out.columns || 80;
  const rowBudget = () => {
    const rows = out.rows || process.stdout.rows || process.stderr.rows || 24;
    return Math.max(3, Math.min(14, rows - 10));
  };

  /** True when another owner has the input and the menu must not run. */
  const gated = () => !!(session && (
    session.inputEchoOn || session.consumeNext
    || session.processing || session.agentTurnActive
    || session.multilineBuf != null
    || session.paste?.isPasting?.()));

  // ---- geometry (visible-width based — matches what the terminal renders,
  // unlike readline's byte-based internal math for CJK input) -------------
  const lineText = () => String(rl.line ?? '');
  const promptText = () => String(rl._prompt ?? '');

  /** Row-offset / column of the editing cursor within the input block. */
  const cursorGeom = () => {
    const c = Math.max(0, Math.min(rl.cursor ?? 0, lineText().length));
    const w = vw(promptText()) + vw(lineText().slice(0, c));
    const C = cols();
    return { row: Math.floor(w / C), col: w % C, pending: w > 0 && w % C === 0 };
  };
  /** Visible rows the prompt+line block currently occupies (>= 1). */
  const inputRows = () => {
    const t = vw(promptText()) + vw(lineText());
    return Math.max(1, Math.ceil(t / cols()));
  };

  // ---- draw primitives ---------------------------------------------------
  const write = (s) => { try { out.write(s); } catch { /* best effort */ } };

  /** P_END -> P_EDIT (caller must ensure the caret is at P_END). */
  const toEdit = () => {
    const g = cursorGeom();
    const endRow = blockRows(g) - 1;
    // CUU lands on the caret's row; CR then resets ONLY THE COLUMN (it does
    // NOT move to row 0) — so after CUU+CR the caret is already at
    // (g.row, 1) and only CUF(g.col) remains. A CUD(g.row) here would double
    // the row offset and park the caret g.row rows BELOW the edit position.
    const up = endRow - g.row;
    if (up > 0) write(`\x1b[${up}A`);
    write('\r');
    if (g.pending) {
      // Buffer exactly fills its row: node readline's own redraw MATERIALIZED
      // the next row (trailing-space workaround) and left the caret at its
      // start — park at that row's LAST column, the text-end column.
      write(`\x1b[${Math.max(1, cols() - 1)}C`);
    } else {
      if (g.col > 0) write(`\x1b[${g.col}C`);
    }
  };

  /**
   * Screen rows the input block currently occupies. In the deferred-wrap
   * (pending) case node readline's redraw MATERIALIZED the next row (its
   * trailing-space workaround), so the block spans g.row + 1 rows and the
   * caret rests ON row g.row — logical row g.row exists on screen.
   */
  const blockRows = (g) => (g.pending ? g.row + 1 : inputRows());

  /**
   * Erase the on-screen menu and park at P_EDIT. No-op when closed.
   * (The caret rests at P_EDIT — the steady-state invariant above — so first
   * CUD down to the menu's LAST row (CUD never scrolls), then erase-up to
   * P_MENU0, one row up to P_END, then P_EDIT.)
   */
  const closeVisual = () => {
    if (!open || prevRows <= 0) { open = false; prevRows = 0; return; }
    const g = cursorGeom();
    const endRow = blockRows(g) - 1;
    let seq = '';
    const down = endRow + prevRows - g.row;   // edit row -> last menu row
    if (down > 0) seq += `\x1b[${down}B`;
    seq += '\r\x1b[2K';
    for (let i = 1; i < prevRows; i++) seq += '\x1b[1A\r\x1b[2K';
    seq += '\x1b[1A';            // P_MENU0 -> P_END (col already 1)
    write(seq);
    open = false;
    prevRows = 0;
    toEdit();
  };

  /**
   * Create n blank rows below the input block and repaint the menu there.
   * P_EDIT -> (P_PARK mid-draw) -> P_EDIT. The input rows themselves are
   * untouched (the text has not changed; only its below-screen space grows).
   * LFs emitted from the block's last row walk-or-scroll — either way the
   * caret ends n rows down. After painting row n-1 the caret transiently sits
   * at P_PARK; the trailing relocation then walks it back to P_EDIT so the
   * caret keeps following the typed command while the menu is open (all
   * relative motion, so this is scroll-safe by construction).
   */
  const openVisual = (menuLines) => {
    const g = cursorGeom();
    const endRow = blockRows(g) - 1;
    const C = cols();
    // PHYSICAL height of the menu: a menu line wider than the terminal
    // wraps, so the menu can occupy MORE screen rows than it has logical
    // lines. All row math here (walk-down budget, back-up, final relocation,
    // and prevRows for closeVisual) must use the PHYSICAL count — a
    // logical-count CUU under-shoots and parks the caret below the edit row,
    // drifting the block down on every keystroke.
    const spanOf = (l) => { const w = vw(l); return w === 0 ? 1 : Math.ceil(w / C); };
    let n = 0;
    for (const l of menuLines) n += spanOf(l);
    let seq = '';
    const down = endRow - g.row;
    if (down > 0) seq += `\x1b[${down}B`;
    seq += '\r';                 // P_END, col 1
    seq += '\n'.repeat(n);       // walk (or scroll) n PHYSICAL rows down
    if (n > 1) seq += `\x1b[${n - 1}A`;  // back up to menu row 0 (n=1: already there)
    seq += '\r';               // P_MENU0, col 1
    for (let i = 0; i < menuLines.length; i++) {
      seq += (i === 0 ? '' : '\r\n') + '\x1b[2K' + menuLines[i];
    }
    // P_PARK -> P_EDIT: the menu's last PHYSICAL row sits (endRow + n) rows
    // below the block's row 0; the edit position is on the caret's PHYSICAL
    // row (pending: the deferred-wrap parking row, g.row - 1). Up >= 1
    // whenever a menu is painted (n >= 1), but stay zero-guarded anyway —
    // xterm reads \x1b[0A as CUU 1.
    const up = endRow + n - g.row;
    if (up > 0) seq += `\x1b[${up}A`;
    seq += '\r';
    if (g.pending) {
      // Mirror toEdit()'s deferred-wrap parking (buffer exactly fills its
      // last row): (row+1, col 0) does not exist on screen yet.
      seq += `\x1b[${Math.max(1, cols() - 1)}C`;
    } else if (g.col > 0) {
      seq += `\x1b[${g.col}C`;
    }
    write(seq);
    open = true;
    prevRows = n;
  };

  /**
   * Replace the input buffer with `text`, repainting the whole input block
   * from its first row. Expects the menu already erased (caret anywhere on
   * the block's rows); leaves the caret at P_EDIT (cursor is always placed
   * at the buffer end by callers).
   */
  const repaintInput = (text) => {
    const g = cursorGeom();      // geometry of the OLD buffer
    const endRow = blockRows(g) - 1;  // last row of the OLD block (incl. materialized)
    rl.line = text;
    rl.cursor = text.length;
    // Clear the OLD block top-down (its row count), RETURN TO ITS FIRST ROW,
    // then paint the new buffer and let the terminal wrap it across rows.
    // The initial CUU uses the caret's row g.row (the materialized row in
    // the pending case) — CUU past it would repaint over the transcript.
    // Every CUU is ZERO-GUARDED: xterm reads \x1b[0A as CUU 1, which would
    // clear/repaint the row above the prompt (single-row block — the common
    // Tab-accept case).
    let seq = (g.row > 0 ? `\x1b[${g.row}A` : '') + '\r';  // block row 0, col 1
    for (let i = 0; i < endRow; i++) seq += '\x1b[2K\r\n';
    seq += '\x1b[2K';
    // Walk back up to the block's FIRST row before painting: the clear loop
    // ends on the block's LAST row, and painting promptText()+text there
    // would repaint the block endRow rows too low — a blank row above it and
    // the whole block drifting down on every accept of a wrapped line.
    if (endRow > 0) seq += `\x1b[${endRow}A`;
    seq += '\r';
    write(seq + promptText() + text);
    toEdit();
  };

  // ---- menu computation ---------------------------------------------------
  const compute = () => {
    if (dismissed) return { open: false, items: [], lines: [], selected: 0 };
    const line = lineText();
    if (!line.startsWith('/')) return { open: false, items: [], lines: [], selected: 0 };
    return completionMenu(line, {
      selected,
      width: cols(),
      maxRows: rowBudget(),
      dyn: currentDynamicSnapshot(),
    });
  };

  /** Async refresh of dynamic candidates (/model use <ref> positions). */
  const refreshDynamic = () => {
    const kind = dynamicContextKey(lineText());
    if (!kind || kind === dynKind) return;
    dynKind = kind;
    const snapshotLine = lineText();
    fetchDynamicItems(kind, { projectId: getProjectId?.() })
      .then(() => {
        if (disposed || gated() || snapshotLine !== lineText()) return;
        redraw();
      })
      .catch(() => {});
  };

  /** Recompute + repaint (close-then-open lands in one terminal frame). */
  const redraw = () => {
    const m = compute();
    if (!m.open) {
      closeVisual();
      dynKind = null;
      return;
    }
    closeVisual();
    openVisual(m.lines);
    selected = m.selected;
    refreshDynamic();
  };

  // ---- accept / submit ------------------------------------------------------
  /** Replace the input buffer with the selected label (+ trailing space). */
  const accept = (label) => {
    closeVisual();
    repaintInput(label + ' ');
    dismissed = false;
    selected = 0;
    redraw();
  };

  /** Submit the current line: hand a synthetic Return to readline. */
  const submitLine = () => {
    closeVisual();
    keyApplied = true;   // the synthetic Return counts as dispatched
    submitting = true;
    try {
      origTtyWrite('\r', { name: 'return' });
    } finally {
      submitting = false;
    }
  };

  // ---- key routing -----------------------------------------------------------
  const NAV = new Set(['up', 'down', 'pageup', 'pagedown']);

  /**
   * Decide what a key means while the menu is open.
   * @returns 'nav' | 'accept' | 'submit' | 'dismiss' | 'edit'
   */
  const classify = (key) => {
    const name = key?.name;
    if (NAV.has(name)) return 'nav';
    if (name === 'tab') return 'accept';
    if (name === 'return' || name === 'enter') {
      const m = compute();
      const line = lineText().trim();
      const exact = m.open && m.items.length === 1 && m.items[0].label === line;
      return exact ? 'submit' : (m.open ? 'accept' : 'edit');
    }
    if (name === 'escape' || (key?.ctrl && name === 'g')) return 'dismiss';
    return 'edit';
  };

  const handleNav = (name) => {
    const m = compute();
    if (!m.open || m.items.length === 0) return;
    const n = m.items.length;
    const step = name === 'pageup' ? -5 : name === 'pagedown' ? 5 : (name === 'up' ? -1 : 1);
    selected = (selected + step + n) % n;
    redraw();
  };

  // ---- the _ttyWrite wrapper -------------------------------------------------
  rl._ttyWrite = function hintsTtyWrite(s, key) {
    if (disposed) return origTtyWrite(s, key);
    if (submitting) return origTtyWrite(s, key);
    keyApplied = false;
    const pass = () => { keyApplied = true; return origTtyWrite(s, key); };
    try {
      if (!open || gated()) {
        // Menu closed (or another owner holds the input): plain passthrough,
        // then live-open the menu if the edit produced a slash line. A menu
        // left open while gated (turn just started) is erased first. A text
        // change clears a standing dismissal (TUI parity: Esc closes until
        // the input changes, then the menu may reappear).
        if (open) closeVisual();
        const before = lineText();
        const r = pass();
        if (lineText() !== before) { dismissed = false; selected = 0; }
        if (!gated() && !dismissed) redraw();
        return r;
      }
      const kind = classify(key);
      if (kind === 'nav') { handleNav(key.name); return; }
      if (kind === 'accept') {
        const m = compute();
        if (m.open && m.items.length > 0) { accept(m.items[m.selected].label); return; }
        return pass();
      }
      if (kind === 'submit') { submitLine(); return; }
      if (kind === 'dismiss') {
        dismissed = true;
        selected = 0;
        closeVisual();
        return;
      }
      // 'edit': erase the menu, park the caret exactly where readline last
      // left it, let readline process the key, then reopen if still matching.
      closeVisual();
      const before = lineText();
      const r = pass();
      if (lineText() !== before) { dismissed = false; selected = 0; }
      if (!gated() && !dismissed) redraw();
      return r;
    } catch {
      // Fail-open: any surprise in the hint layer must never eat a key — but
      // ONLY one that never reached readline. Re-dispatching an already
      // applied key would insert the char twice / submit the line twice.
      if (!keyApplied) return origTtyWrite(s, key);
    }
  };

  // A completed line resets the menu state (the submit path already erased
  // the menu; this also covers readline's own line injections like history
  // recall driven from elsewhere).
  const onLine = () => {
    closeVisual();
    dismissed = false;
    selected = 0;
    dynKind = null;
  };
  rl.on('line', onLine);

  readline.emitKeypressEvents(rl.input); // idempotent

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try { closeVisual(); } catch { /* ignore */ }
      rl._ttyWrite = origTtyWrite;
      rl.off('line', onLine);
    },
    refresh: redraw,
  };
}
