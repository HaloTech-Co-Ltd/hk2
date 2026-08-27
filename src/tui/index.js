/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频，图表，界面设计，版面框架，有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新、技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. As expressly permitted in
 * your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software in
 * dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * runTui — the Claude Code-style front-end: a bordered multi-line input box
 * pinned at the bottom, streaming markdown/tool cards in the native terminal
 * scrollback above it, a hint row + animated status line under it, slash
 * completion, modal prompts, and ESC/Ctrl+C interrupt semantics. Inline
 * (main screen) — the terminal's own scrollback is the transcript, exactly
 * like Claude Code. Launched via `hk2 --tui` (or HK2_UI=tui); the bare `hk2`
 * keeps the classic line REPL untouched.
 *
 * Everything below the transcript is a Frame block stack; the whole session
 * (ctx / slash commands / turn pipeline) is the SAME code the REPL runs —
 * only the io (prompts) and ui (rendering) implementations differ.
 */
import readline from 'node:readline';
import fs from 'node:fs/promises';
import { ensureHome, HK2_HOME } from '../../lib/config/home.js';
import {
  createSession, buildBaseCtx, reloadAll, flushSessionReloads, resumeSessionInto,
  formatRecentOutputs, captureMidTaskInput, userMarkerLines,
} from '../commands/session_ctx.js';
import { handleUserLine } from '../commands/turn.js';
import { formatPlanProgressLines } from '../commands/status_format.js';
import { renderWelcome, renderClearSummary, renderInputChrome, renderFooter } from './chrome.js';
import { makeTuiUi } from './tui_ui.js';
import { makeTuiIo } from './tui_io.js';
import { Frame } from './frame.js';
import { ModalHost } from './modal.js';
import { initialState, applyKey, setText, text as boxText, cursorScreen, visibleRows } from './input_box.js';
import { History, historyPath } from './history.js';
import { normalizeKey } from './keys.js';
import { completionMenu, moveSelection, historyMenu } from './completion.js';
import { enableBracketedPaste, disableBracketedPaste } from '../../lib/agent/paste.js';
import { loadTheme } from '../../lib/agent/tool_theme.js';
import * as style from '../../lib/agent/style.js';

const CTRL_C_WINDOW_MS = 1500;

/**
 * Draft guard for freeText modals: while the pipeline owns the input box
 * (a clarification prompt), the user's half-typed NEXT message is stashed
 * and a fresh editor yielded — on resolve the draft comes back. Without
 * this the draft either leaks in as the modal's answer or is lost when the
 * modal finishes and clears the box. Pure state, unit-testable.
 */
/**
 * Ctrl+G is the cancel alias: inside a modal it behaves exactly like Esc.
 * Pure — the key loop feeds the result to ModalHost.applyKey. Exported for
 * controller-level regression tests (the const-reassignment bug lived here).
 */
/**
 * What an InputBox exit signal (Ctrl+D on an empty buffer) should do right
 * now: 'defer' while a turn is running (interrupt + exit after cleanup),
 * 'exit' when idle. Pure — exported for controller-level tests.
 */
export function ctrlDAction(session) {
  return (session && (session.processing || session.agentTurnActive)) ? 'defer' : 'exit';
}

export function cancelAliasKey(k) {
  return (k && k.type === 'ctrl' && k.ch === 'g') ? { type: 'escape' } : k;
}

export function makeDraftGuard() {
  let saved = null;
  return {
    /** Enter freeText: stash `box`, yield a fresh empty editor. */
    enter(box) {
      if (saved) return box;
      saved = box;
      return initialState({ placeholder: box.placeholder, width: box.width, maxVisibleRows: box.maxVisibleRows });
    },
    /** Leave freeText: restore the stashed draft (no-op when none). */
    exit(box) {
      const restored = saved ?? box;
      saved = null;
      return restored;
    },
    active() { return saved !== null; },
  };
}

/**
 * Terminal capability gate. `stream` is the OUTPUT the Frame will draw
 * into — capability must be judged against THAT stream, not "stdout OR
 * stderr" (`hk2 --tui 2>log` has a TTY stdout but a redirected stderr;
 * the old OR-check armed raw mode and then discovered the dead stream).
 */
export function tuiCapable(stream = process.stderr) {
  return !!(process.stdin.isTTY
    && stream?.isTTY
    && process.env.TERM !== 'dumb');
}

/** The stream the TUI actually draws into (stderr unless HK2_TUI_STREAM). */
let drawStream = process.stderr;

/**
 * Terminal width from the DRAW stream first: with stdout redirected
 * (`hk2 --tui >log`) stdout.columns is undefined and its resize events never
 * fire, but stderr — the stream being drawn — still knows the real size.
 */
export function tuiTermWidth(stream = drawStream) {
  return stream?.columns || process.stdout.columns || process.stderr.columns || 80;
}

function boxWidthFor() {
  return Math.max(20, tuiTermWidth() - 2);
}

export async function runTui(opts = {}) {
  await ensureHome();

  const session = createSession(opts.projectId || null);
  const modalHost = new ModalHost();
  const stream = process.env.HK2_TUI_STREAM === 'stdout' ? process.stdout : process.stderr;
  drawStream = stream;
  const history = new History(historyPath(HK2_HOME), { max: 1000 });
  await history.load();

  // ---- editor + interaction state ------------------------------------
  const BOX_PLACEHOLDER = 'Message hk2…';
  let box = initialState({
    placeholder: BOX_PLACEHOLDER,
    width: boxWidthFor(),
    maxVisibleRows: 6,
  });
  let completionSelected = 0;
  let completionDismissed = false; // ESC closes the menu until the text changes
  let searchMode = false;          // Ctrl+R incremental history search
  let searchSelected = 0;
  const draftGuard = makeDraftGuard();
  let booted = false;              // boot gate: submissions queue until the model/KB are ready
  const pendingSubmits = [];
  let ccArmedAt = 0;
  let ccTimer = null;              // one-shot expiry for the double-Ctrl+C window
  let exitAfterTurn = false;       // Ctrl+D during a turn: interrupt, let the
                                   // turn's cleanup run, THEN exit
  let interrupted = false; // last ESC aborted the running turn (hint text)
  const interruptCbs = new Set();
  let shutDown = false;

  // ---- frame + blocks -------------------------------------------------
  const menu = () => (completionDismissed
    ? { items: [], selected: 0, replaceFrom: 0, lines: [], open: false }
    : completionMenu(boxText(box), {
        selected: completionSelected,
        width: boxWidthFor() + 2,
        maxRows: Math.max(3, Math.min(14, (process.stdout.rows || process.stderr.rows || 24) - 10)),
      }));
  const searchMenu = () => historyMenu(boxText(box), history.entries(), {
    selected: searchSelected,
    width: boxWidthFor() + 2,
    maxRows: 8,
  });
  const blocks = [
    { name: 'modal', render: () => modalHost.render(Math.min(style.termWidth(), 100)) },
    { name: 'plan', render: () => formatPlanProgressLines(session) },
    {
      name: 'input',
      render: () => renderInputChrome(visibleRows(box, boxWidthFor()), box.placeholder, boxWidthFor() + 2),
      cursor: () => {
        const c = cursorScreen(box, boxWidthFor());
        return { row: c.row + 1, col: c.col + 2 }; // +1 top rule, +2 '❯ ' prompt
      },
    },
    {
      // Completion menu BELOW the input area (Claude Code's placement).
      // Ctrl+R search replaces it while active.
      name: 'completion',
      render: () => (modalHost.active() ? [] : (searchMode ? searchMenu().lines : menu().lines)),
    },
    {
      name: 'footer',
      render: () => [renderFooter(session, boxWidthFor() + 2, {
        armed: ccArmedAt !== 0,
        busy: session.agentTurnActive,
        queued: session.userInputQueue.length,
      })],
    },
  ];
  // Animation runs ONLY while a turn is active (footer spinner / elapsed
  // time). An idle frame writes zero bytes — no periodic redraw traffic.
  const frame = new Frame(stream, { blocks, animateWhen: () => session.agentTurnActive });
  const resetScreen = () => {
    // /clear resets the screen with a ONE-LINE session summary — the full
    // welcome card is a boot luxury; a cleared context doesn't need it again.
    frame.write('\x1b[H\x1b[2J');
    frame.cursorHome();
    frame.writeLine(renderClearSummary(session, Math.min(style.termWidth(), 100)));
    frame.writeLine('');
    frame.requestRender();
  };
  // freeText modal ownership: the input box is handed over the MOMENT the
  // modal becomes active (and returned the moment it resolves) — waiting for
  // the first keypress left the user's old draft on screen under an open
  // modal, and a first-frame Enter resolved against that stale picture.
  modalHost.onActive((m) => {
    if (m && m.kind === 'freeText') {
      if (!draftGuard.active()) box = draftGuard.enter(box);
    } else if (draftGuard.active()) {
      box = draftGuard.exit(box);
    }
    frame.requestRender();
  });
  const io = makeTuiIo(frame, modalHost, { onCleared: resetScreen });
  const ctx = buildBaseCtx(session, io);
  const hooks = {
    onInterrupt(cb) {
      interruptCbs.add(cb);
      return () => interruptCbs.delete(cb);
    },
    // Visible content width for markdown tables (input box interior width).
    contentWidth: () => boxWidthFor(),
  };
  const ui = makeTuiUi(frame, session, modalHost, hooks);

  // ---- console capture: nothing bypasses the Frame --------------------
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const capture = (...a) => frame.writeLine(a.map(x => typeof x === 'string' ? x : String(x)).join(' '));
  console.log = capture;
  console.error = capture;
  console.warn = capture;

  // ---- shutdown (single exit path) ------------------------------------
  const shutdown = (code) => {
    if (shutDown) return;
    shutDown = true;
    try { process.stdin.setRawMode(false); } catch { /* not raw */ }
    try { process.stdin.pause(); } catch { /* ignore */ }
    if (ccTimer) { clearTimeout(ccTimer); ccTimer = null; }
    disableBracketedPaste(stream);
    frame.stop();
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    // Silent exit, but ONE dim resume hint — hk2's sessions are its value:
    // the id is easy to lose with no pointer (Claude Code has /resume in
    // the next session; hk2's equivalent needs the flag or the id).
    // Quit-without-messages: this boot's transcript is EMPTY — delete it
    // (every bare launch would otherwise strand one) and point the hint at
    // the newest session that actually has content, if any.
    history.flush().catch(() => {}).then(async () => {
      let hint = null;
      try {
        const { resumeHintAfterExit } = await import('../../lib/agent/transcript.js');
        // Await any in-flight transcript append BEFORE computing the hint /
        // exiting — the exit hint must not race the last event lines.
        await session.transcript?.flush?.();
        hint = await resumeHintAfterExit(session.transcript);
      } catch { /* best-effort hint */ }
      if (hint) stream.write(style.dim(`resume: hk2 --tui --resume ${hint}`) + '\n');
      process.exit(code);
    });
  };
  // Single cleanup covering normal exit, the REPL fallback, and signals:
  // unwire keypress/resize listeners, drop raw mode, and restore the
  // console — the fallback path previously left raw mode armed and
  // listeners attached.
  let stdinTeardown = null;
  const restoreOnce = () => {
    if (shutDown) return;
    // Raw mode MUST be dropped here too, not only in shutdown(): this path
    // runs on resume-failure and the TUI→REPL fallback — leaving raw mode
    // armed handed the user a terminal where Ctrl+C/Echo were dead.
    try { process.stdin.setRawMode(false); } catch { /* not raw */ }
    disableBracketedPaste(stream);
    try { frame.stop(); } catch { /* not started */ }
    if (stdinTeardown) { try { stdinTeardown(); } catch { /* ignore */ } stdinTeardown = null; }
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  };
  process.once('exit', restoreOnce);
  process.once('SIGINT', () => shutdown(130));  // external kill -INT / non-raw subshell
  process.once('SIGTERM', () => shutdown(143));

  // ---- submit pipeline (mirrors the REPL's enqueue) --------------------
  const enqueue = async (line) => {
    if (captureMidTaskInput(session, line)) {
      const n = session.userInputQueue.length;
      frame.writeLine(style.success(`${style.ICON.ok} queued #${n} ${style.dim('· delivered after the current action')}`));
      frame.requestRender();
      return;
    }
    session.queue.push(line);
    if (session.processing) return;
    session.processing = true;
    try {
      // exitAfterTurn (deferred Ctrl+D) stops consumption HERE: the current
      // turn was interrupted and its cleanup has run — queued input must not
      // START now that the user asked to leave (review round 7).
      while (session.queue.length > 0 && !session.exiting && !exitAfterTurn) {
        const l = session.queue.shift();
        await handleUserLine(l, session, ctx, ui);
        await flushSessionReloads(session, ctx);
      }
    } finally {
      session.processing = false;
    }
    interrupted = false;
    frame.requestRender();
    if (session.exiting || exitAfterTurn) shutdown(0);
  };

  const submit = (line) => {
    if (!booted) { pendingSubmits.push(line); return; } // beat the boot: replay after
    history.add(line);
    // Claude Code echo: the prompt line (❯ + message) stays in scrollback.
    const raw = String(line).replace(/\r/g, '').split('\n');
    raw.forEach((ln, i) => {
      frame.writeLine((i === 0 ? style.accent('❯') + ' ' : '  ') + ln);
    });
    frame.requestRender();
    void enqueue(line);
  };

  // ---- key loop ---------------------------------------------------------
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  // escapeCodeTimeout: Node's default 500ms glues arrow keys pressed faster
  // than that into one escape parse, silently DROPPING them (rapid menu
  // navigation died). 50ms is far above real sequence latency.
  readline.emitKeypressEvents(stdin, { escapeCodeTimeout: 50 });
  enableBracketedPaste(stream);

  let pasting = false;
  let pasteBuf = '';

  const fireInterrupt = () => {
    interrupted = true;
    for (const cb of interruptCbs) {
      try { cb(); } catch { /* ignore */ }
    }
    frame.requestRender();
  };

  /** Clear the double-Ctrl+C armed state (any non-Ctrl+C key disarms it). */
  const disarmCc = () => {
    const was = ccArmedAt !== 0;
    ccArmedAt = 0;
    if (ccTimer) { clearTimeout(ccTimer); ccTimer = null; }
    if (was) frame.requestRender();
  };

  const onCtrlC = () => {
    if (boxText(box).length > 0) {
      // 1) non-empty input → clear it (and any open completion menu)
      box = initialState({ placeholder: box.placeholder, width: boxWidthFor(), maxVisibleRows: box.maxVisibleRows });
      completionSelected = 0;
      searchMode = false;
      frame.requestRender();
      return;
    }
    if (session.agentTurnActive) {
      // 2) empty input while a turn runs → abort the turn (same path as ESC)
      fireInterrupt();
      return;
    }
    // 3) empty + idle → double-press-to-exit within the window. The window
    // expires via a ONE-SHOT timeout (footer stops showing the exit hint on
    // its own) and any other key disarms immediately — "press twice" must
    // mean two CONSECUTIVE Ctrl+C presses, not two within 1.5s of anything.
    if (ccArmedAt) {
      disarmCc();
      shutdown(0);
      return;
    }
    ccArmedAt = Date.now();
    if (ccTimer) clearTimeout(ccTimer);
    ccTimer = setTimeout(() => {
      ccArmedAt = 0;
      ccTimer = null;
      frame.requestRender();
    }, CTRL_C_WINDOW_MS);
    frame.requestRender(); // the footer shows "Press Ctrl-C again to exit"
  };

  /**
   * Esc / Ctrl+G semantics, in precedence order:
   *   history search close > turn interrupt > completion close.
   * While a turn runs, interrupt ALWAYS wins — the footer says
   * 'esc to interrupt' and must not lie (a menu open at the same time closes
   * as part of interrupting).
   */
  const handleEscape = () => {
    if (searchMode) {
      searchMode = false;
      searchSelected = 0;
      frame.requestRender();
      return;
    }
    if (session.agentTurnActive) {
      completionDismissed = true;
      fireInterrupt();
      return;
    }
    if (menu().open) {
      completionSelected = 0;
      completionDismissed = true; // stay closed until the text changes
      frame.requestRender();
      return;
    }
  };

  const acceptCompletion = () => {
    const m = menu();
    if (!m.open || m.items.length === 0) return false;
    const label = m.items[m.selected].label;
    box = setText(box, label + ' ');
    completionSelected = 0;
    completionDismissed = false;
    frame.requestRender();
    return true;
  };

  const onKeypress = (str, key) => {
    const k = normalizeKey(str, key);

    // ---- bracketed paste ----
    if (k.type === 'paste-start') { pasting = true; pasteBuf = ''; return; }
    if (k.type === 'paste-end') {
      pasting = false;
      const text = pasteBuf.replace(/\r\n?/g, '\n').replace(/\n$/, '');
      if (text) {
        const r = applyKey(box, { type: 'char', text }, { history: history.entries() });
        box = r.state;
      }
      completionSelected = 0;
      frame.requestRender();
      return;
    }
    if (pasting) { pasteBuf += str || ''; return; }

    // ---- Ctrl+C state machine (before everything else) ----
    if (k.type === 'ctrl' && k.ch === 'c') { onCtrlC(); return; }

    // Any OTHER key breaks the double-Ctrl+C sequence — the second press
    // must be a CONSECUTIVE Ctrl+C, not "Ctrl+C then something within 1.5s".
    if (ccArmedAt !== 0) disarmCc();

    // ---- Ctrl+O: expand the last tool result into the transcript ----
    if (k.type === 'ctrl' && k.ch === 'o') {
      ui.expandLastTool();
      return;
    }

    // ---- Ctrl+L: clear the screen (transcript scrolls away, UI redraws) ----
    if (k.type === 'ctrl' && k.ch === 'l') {
      frame.write('\x1b[H\x1b[2J');
      frame.cursorHome();
      frame.writeLine(style.dim('(screen cleared)'));
      frame.requestRender();
      return;
    }

    // ---- modal precedence ----
    if (modalHost.active()) {
      if (modalHost.isFreeText()) {
        // freeText: the input box IS the modal's editor (the onActive hook
        // already swapped it for a fresh one and stashed the user's draft).
        if (k.type === 'enter') {
          const val = boxText(box).trim();
          modalHost._finish(val ? { text: val, cancelled: false } : { text: '', cancelled: true });
          frame.requestRender();
          return;
        }
        if (k.type === 'escape' || (k.type === 'ctrl' && k.ch === 'g')) {
          modalHost._finish({ text: '', cancelled: true });
          frame.requestRender();
          return;
        }
        const r = applyKey(box, k, { history: history.entries() });
        box = r.state;
        frame.requestRender();
        return;
      }
      // Ctrl+G = cancel. Derive a NEW key object — reassigning the const
      // `k` threw 'Assignment to constant variable' and, in raw mode with
      // the Frame holding the terminal, killed the process outright.
      const modalKey = cancelAliasKey(k);
      modalHost.applyKey(modalKey);
      frame.requestRender();
      return;
    }

    // ---- Esc / Ctrl+G ----
    if (k.type === 'escape' || (k.type === 'ctrl' && k.ch === 'g')) {
      handleEscape();
      return;
    }

    // ---- Ctrl+R: incremental history search over the persistent history ----
    if (k.type === 'ctrl' && k.ch === 'r') {
      if (searchMode) {
        // repeat Ctrl+R cycles to the next match (readline behavior)
        const sm = searchMenu();
        searchSelected = (sm.selected + 1) % Math.max(1, sm.items.length);
      } else {
        searchMode = true;
        searchSelected = 0;
      }
      frame.requestRender();
      return;
    }
    if (searchMode) {
      const sm = searchMenu();
      if (k.type === 'up' || k.type === 'pageup') {
        searchSelected = Math.max(0, sm.selected - (k.type === 'pageup' ? 5 : 1));
        frame.requestRender();
        return;
      }
      if (k.type === 'down' || k.type === 'pagedown') {
        searchSelected = Math.min(Math.max(0, sm.items.length - 1), sm.selected + (k.type === 'pagedown' ? 5 : 1));
        frame.requestRender();
        return;
      }
      if (k.type === 'enter' || k.type === 'tab') {
        const pick = sm.items[sm.selected];
        if (pick != null) box = setText(box, pick);
        searchMode = false;
        searchSelected = 0;
        frame.requestRender();
        return;
      }
      // every other key edits the QUERY (the buffer) — falls through
    }

    // ---- completion navigation (suppressed while history search runs) ----
    const m = searchMode ? { open: false } : menu();
    if (m.open && (k.type === 'up' || k.type === 'down')) {
      completionSelected = moveSelection(m.items, m.selected, k.type === 'up' ? -1 : +1);
      frame.requestRender();
      return;
    }
    if (m.open && (k.type === 'pageup' || k.type === 'pagedown')) {
      const dir = k.type === 'pageup' ? -5 : 5;
      completionSelected = Math.max(0, Math.min(m.items.length - 1, m.selected + dir));
      frame.requestRender();
      return;
    }
    if (m.open && k.type === 'tab') {
      acceptCompletion();
      return;
    }

    // ---- input box ----
    if (k.type === 'enter' && m.open) {
      // Enter on the menu: accept unless the buffer is already an exact
      // command match (then submit it).
      const exact = m.items.length === 1 && m.items[0].label === boxText(box).trim();
      if (!exact) {
        acceptCompletion();
        return;
      }
      // exact match: fall through to submit
    }
    const before = boxText(box);
    const r = applyKey(box, k, { history: history.entries() });
    box = r.state;
    if (r.submitted !== undefined) {
      completionSelected = 0;
      completionDismissed = false;
      submit(r.submitted);
      frame.requestRender();
      return;
    }
    if (r.exit) {
      // NEVER hard-exit mid-turn: process.exit() would bypass runTurn's
      // catch/finally — the interrupted-task state would never reach
      // task_state.js, mid-task input would stay un-redirected, and the
      // transcript would show an unfinished session instead of a clearly
      // interrupted one. Interrupt now; enqueue() exits after the pipeline
      // has unwound.
      if (ctrlDAction(session) === 'defer') {
        exitAfterTurn = true;
        fireInterrupt();
        frame.requestRender();
        return;
      }
      shutdown(0);
      return;
    }
    if (boxText(box) !== before) {
      completionSelected = 0;
      completionDismissed = false; // new text re-opens the menu
    }
    frame.requestRender();
  };

  stdin.on('keypress', onKeypress);
  const onResize = () => {
    box = { ...box, width: boxWidthFor() };
    frame.requestRender();
  };
  // Resize follows the DRAW stream (stdout redirect = no stdout resize
  // events); SIGWINCH stays as the process-wide fallback.
  stream.on?.('resize', onResize);
  process.on('SIGWINCH', onResize);
  stdinTeardown = () => {
    stdin.off('keypress', onKeypress);
    stream.off?.('resize', onResize);
    process.off('SIGWINCH', onResize);
    try { stdin.pause(); } catch { /* ignore */ }
  };

  // ---- boot (mirrors interactive()) ------------------------------------
  // Ergonomic first run: no default model configured but Claude Code's
  // ~/.claude/settings.json has an Anthropic-compatible endpoint → import
  // it so `hk2 --tui` works on first launch with zero setup. Fill-only
  // (never overwrites), idempotent, HK2_AUTOIMPORT_CLAUDE=0 disables.
  let claudeImport = null;
  try {
    const { autoImportClaudeModel } = await import('../claude_import.js');
    claudeImport = await autoImportClaudeModel();
  } catch { /* best-effort; boot continues unconfigured */ }
  await reloadAll(session, ctx);

  if (opts.resume) {
    const wanted = opts.resume === true ? null : String(opts.resume);
    // Same orphan-transcript cleanup as the REPL launch path (see
    // interactive()): reloadAll just created a fresh empty transcript that
    // would poison a later bare --resume.
    const freshPath = session.transcript?.path ?? null;
    const ok = await resumeSessionInto(session, wanted);
    if (freshPath && (!ok || session.transcript.path !== freshPath)) {
      await fs.unlink(freshPath).catch(() => {});
    }
    if (!ok) {
      restoreOnce();
      origError(wanted
        ? `Error: session '${wanted}' not found for this project. (/session list to browse.)`
        : `Error: no previous session found for this project. Nothing to resume.`);
      process.exit(2);
    }
    // Cross-project resume armed reloadFlags.model — consume it NOW so the
    // first post-resume message runs on the owner project's model/MCP.
    await flushSessionReloads(session, ctx);
    const msgCount = session.messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
    session.resumeNotice =
      `Resumed session ${session.transcript.sessionId}: ${msgCount} message(s) restored into context`
      + (session.lastTask ? '; interrupted task state recovered (type "continue" to go on)' : '')
      + (session.resumedFromOtherProject
        ? ` (project was dropped/switched — /project init to re-attach its KB)` : '');
    session.resumeOutputsPreview = formatRecentOutputs(session.messages);
  }

  // Install user theme overrides before any card renders.
  await loadTheme().catch(() => {});

  if (frame.isEnabled()) {
    frame.write('\x1b[H\x1b[2J'); // clear the visible screen, keep scrollback
    frame.start();
    frame.cursorHome(); // the welcome card starts at the TOP of the cleared screen
  } else {
    origError('[tui] output stream is not a TTY — falling back to the line REPL.');
    restoreOnce();
    const { interactive } = await import('../commands/interactive.js');
    await interactive(opts);
    return;
  }

  // Welcome tier: the FULL logo card is a first-run luxury. Returning users
  // and short terminals (< 30 rows, where the card ate ~80% of the screen)
  // get the compact single-column card; the width tiers inside
  // renderWelcome handle the rest.
  const welcomeSeenPath = `${HK2_HOME}/welcome-seen`;
  let welcomeSeen = false;
  try {
    welcomeSeen = String(await fs.readFile(welcomeSeenPath, 'utf8')).trim() === '1';
  } catch { /* first run */ }
  // Welcome tier: HK2_WELCOME=full always shows the logo card; =compact
  // always the fact card; default (auto) = full on first run, compact for
  // returning users and short screens.
  const wantWelcome = (process.env.HK2_WELCOME || 'auto').trim().toLowerCase();
  const compactWelcome = wantWelcome === 'full' ? false
    : wantWelcome === 'compact' ? true
    : welcomeSeen || (process.stdout.rows || process.stderr.rows || 24) < 30;
  if (!welcomeSeen) {
    await fs.writeFile(welcomeSeenPath, '1').catch(() => {});
  }

  booted = true;
  for (const ln of renderWelcome(session, Math.min(style.termWidth(), 100), { compact: compactWelcome })) {
    frame.writeLine(ln);
  }
  while (pendingSubmits.length > 0) {
    submit(pendingSubmits.shift()); // keystrokes that raced the boot
  }
  frame.writeLine('');
  frame.writeLine(''); // Claude Code's two blank rows between the card and the input area
  if (claudeImport?.imported) {
    frame.writeLine(style.success(`Auto-configured model ${style.bold(claudeImport.ref)} from ~/.claude/settings.json`));
    frame.writeLine(style.dim(`  (Claude Code endpoint imported as provider \"claude\"; models: ${claudeImport.models.join(', ')})`));
    frame.writeLine('');
  }
  if (session.resumeNotice) {
    frame.writeLine(session.resumeNotice);
    session.resumeNotice = null;
  }
  if (session.resumeOutputsPreview?.length) {
    for (const line of session.resumeOutputsPreview) frame.writeLine(line);
    session.resumeOutputsPreview = null;
    frame.writeLine('');
  }
  frame.requestRender();

  // Event-driven from here: keys drive everything; exit goes through shutdown().
  await new Promise(() => {});
}
