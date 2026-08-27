/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或电子文档等）
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
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software or
 * in dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in dangerous
 * applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * interactive mode (default): agent REPL.
 *
 * Boot flow:
 *   1. ensureHome (~/.hk2 ready)
 *   2. Load current project (warn if none)
 *   3. Load KB (warn if not built)
 *   4. Resolve default model config → LLMClient
 *   5. Enter REPL: one line per interaction
 *        - Lines starting with / → slash dispatch
 *        - Otherwise → agent loop (streaming + tool calls + KB graph)
 *
 * Reload: project / model / KB changes flag a reload; next prompt redraws state.
 */
import readline from 'node:readline';
import { ensureHome } from '../../lib/config/home.js';
import { dispatchSlash, allSlashCompletionLabels } from '../slash/index.js';
import { StatusBar } from '../../lib/agent/statusbar.js';
import { PasteHandler } from '../../lib/agent/paste.js';
import { MultiLineCollector } from '../../lib/agent/multiline.js';
import * as style from '../../lib/agent/style.js';
import { renderLogo } from '../../lib/agent/logo.js';
import fs from 'node:fs/promises';
import { loadTheme } from '../../lib/agent/tool_theme.js';
import { VERSION } from '../version.js';
import {
  createSession, buildCtx, reloadAll, flushSessionReloads, resumeSessionInto,
  formatRecentOutputs, captureMidTaskInput,
} from './session_ctx.js';
import { handleUserLine } from './turn.js';
import {
  modelTagFor, promptFor, kbBrief, formatStatusLine, formatPlanProgressLines,
  formatInputBoxLine, inputBoxDockColumn,
} from './status_format.js';
import { runTurn } from './turn.js';
import { makeReplUi } from './repl_ui.js';

// Re-export the shared modules' public surface under the historical
// interactive.js names — the test suite (and later the TUI front-end) imports
// them from here, so the extraction stays a no-op for every consumer.
export {
  createSession, buildCtx, buildBaseCtx, replIo, reloadAll, flushSessionReloads,
  splitOutputUnits, formatRecentOutputs, userMarkerLines, allLines,
  resumeSessionInto, confirmThreeWay,
  isContinuationCue, captureMidTaskInput, buildMidTaskInjection,
  disarmMidTaskCapture, flushMidTaskQueue, buildResumeContext, buildSessionDigest,
} from './session_ctx.js';
export {
  modelTagFor, promptFor, kbBrief, formatPlanProgressLines, finalizePlanProgress,
  formatStatusLine, formatUsage, fmtTok, safeParseArgs, cardWidthFor, toolHeader,
  digestLine, plainPlanLines, formatInputBoxLine, inputBoxDockColumn,
} from './status_format.js';
export {
  envFlag, envPercent, estimateMessagesTokens, applyCompactTokenEstimate, execFileAsync,
  summarizeConversation, compactMessages, collectWorkingTreeDiff, maybeAutoCompact,
  maybeOfferKbUpdate, syncConflictingEden, runCodeReview, learnNewKnowledge,
} from './turn_support.js';
export { runTurn } from './turn.js';
export { makeReplUi } from './repl_ui.js';


export async function interactive(opts = {}) {
  await ensureHome();

  // Per-session project pin: the project this REPL instance is working on.
  // Set explicitly via --project (opts.projectId), or snapshotted from the
  // global `current` pointer on a bare launch. Once pinned, reloads and
  // slash commands resolve the project from the pin instead of re-reading
  // the shared projects.json `current` - so two parallel `hk2 --project=X`
  // processes no longer fight over the global pointer (session A's
  // /model-use reload can't flip session B onto A's project).
  // null = not yet resolved (bare launch with no current project).
  const initialProjectId = opts.projectId || null;

  const session = createSession(initialProjectId);

  const ctx = buildCtx(session);

  await reloadAll(session, ctx);

  // --resume[=<sessionId>] / opts.resume: reopen a previous session's
  // transcript instead of starting fresh. `true` means "the project's latest
  // session" (hk2 --resume with no value). Must run AFTER reloadAll so the
  // project (and its fresh transcript) is already resolved — resumeSession()
  // then swaps the transcript out for the resumed one.
  if (opts.resume) {
    const wanted = opts.resume === true ? null : String(opts.resume);
    // reloadAll created a brand-new empty transcript seconds ago (it doubles
    // as the "exclude" anchor for a bare --resume). Whichever way resume goes,
    // that file is dead weight this process will never append to:
    //  - failure → we exit(2) below; leaving the empty .jsonl behind would
    //    poison a LATER bare `hk2 --resume` (findLatestSessionId picks the
    //    newest-mtime orphan → restores 0 messages instead of the user's real
    //    last conversation) and clutter /session list.
    //  - success → session.transcript is swapped onto the RESUMED session and
    //    every further append lands there; the fresh file is never touched.
    // Launch path ONLY — the in-REPL /session resume path must NOT delete:
    // its live transcript can hold this REPL's own conversation.
    const freshPath = session.transcript?.path ?? null;
    const ok = await resumeSessionInto(session, wanted);
    if (freshPath && (!ok || session.transcript.path !== freshPath)) {
      await fs.unlink(freshPath).catch(() => {});
    }
    // A cross-project resume arms reloadFlags.model — consume it BEFORE the
    // banner/first prompt so the first post-resume message already runs on
    // the owner project's model (not the launch project's leftover llm).
    if (ok) await flushSessionReloads(session, ctx);
    if (!ok) {
      console.error(wanted
        ? `Error: session '${wanted}' not found for this project. (/session list to browse.)`
        : `Error: no previous session found for this project. Nothing to resume.`);
      process.exit(2);
    }
    const msgCount = session.messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
    // Deferred printout: in TTY mode the status-bar setup below clears the
    // screen AFTER this point but BEFORE printBanner, wiping anything printed
    // here. Stash both the summary line and the last-outputs preview and emit
    // them right after the banner instead.
    session.resumeNotice =
      `Resumed session ${session.transcript.sessionId}: ${msgCount} message(s) restored into context`
      + (session.lastTask ? '; interrupted task state recovered (type "continue" to go on)' : '');
    session.resumeOutputsPreview = formatRecentOutputs(session.messages);
  }

  const isInteractive = !!process.stdin.isTTY || opts.forceTty;
  session.rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: promptFor(session),
    terminal: isInteractive,
    completer: makeCompleter(),
  });

  // Bracketed paste support: detect multi-line pastes and submit them as a
  // single '\n'-joined message instead of one agent turn per pasted line.
  // Only meaningful in TTY mode; non-TTY (piped) input is unaffected.
  const paste = new PasteHandler(process.stderr, session.rl.input, session.rl);
  session.paste = paste;

  // Persistent bottom status bar (only in TTY mode)
  session.statusBar = new StatusBar(process.stderr, {
    formatter: () => formatStatusLine(session),
    // Pinned multi-line plan-progress block rendered just above the status
    // line. Returns [] when no plan is active, so the bar behaves exactly
    // as before (1 reserved line). When a plan is confirmed this returns
    // one line per step + a header, and the scroll region shrinks to make
    // room. Updated on every statusBar.update() (incl. the 500ms poll).
    planRenderer: () => formatPlanProgressLines(session),
    // One-line mid-task instruction input box, rendered as the FIRST
    // reserved row (above the plan panel, below the status line) while an
    // agent turn runs. [] when idle — the bar then reserves nothing extra,
    // matching the legacy layout exactly.
    inputRenderer: () => formatInputBoxLine(session),
  });
  // Real-cursor docking: the StatusBar asks this fn where the real cursor
  // should sit on the input row (null = don't dock). It reads the LIVE
  // readline state, so the dock follows the cursor through edits.
  if (session.statusBar.setInputCursorFn) {
    session.statusBar.setInputCursorFn(() => inputBoxDockColumn(session));
  }
  if (session.statusBar.isEnabled()) {
    // Clear the visible screen so the previous session's last lines don't
    // bleed in around the welcome card on re-entry. Scrollback is preserved
    // (no \x1b[3J); the user can still scroll up to prior invocations.
    // Done BEFORE start() so the status bar's scroll region takes effect on
    // a clean viewport.
    process.stderr.write('\x1b[H\x1b[2J');
    session.statusBar.start();
    // Refresh frequently while running — keeps the spinner animating and the
    // elapsed-time display fresh. Output is static when idle so the extra
    // redraws are invisible (same bytes, no flicker).
    session.statusBar.poll(200);
    // Restore terminal if Node crashes or user kills the process
    const restoreOnce = () => { session.statusBar?.stop(); };
    process.once('exit', restoreOnce);
    // Ctrl+C follows the SAME contract as the TUI's Ctrl+C:
    //   - mid-turn → INTERRUPT the turn (never a hard exit — process.exit()
    //     would bypass runTurn's catch/finally: interrupted-task state never
    //     reaches task_state.js, mid-task input stays un-redirected, and the
    //     transcript shows an unfinished session). The turn unwinds, the
    //     prompt returns; a second Ctrl+C once idle exits.
    //   - idle → restore the terminal and exit 130 (the classic REPL
    //     contract). `process.on` (not `once`): a mid-turn press must not
    //     consume the handler.
    process.on('SIGINT', () => {
      if ((session.agentTurnActive || session.processing) && session._turnInterrupt) {
        session._turnInterrupt();
        return;
      }
      restoreOnce();
      process.exit(130);
    });
    process.once('SIGTERM', () => { restoreOnce(); process.exit(143); });
  }

  // Install user theme overrides (tool-card frame colors) before any card
  // renders. Missing/invalid theme.json silently keeps built-in colors.
  await loadTheme().catch(() => {});

  printBanner(session, ctx);

  // --resume feedback — emitted here (not in the resume block above) because
  // the TTY clear during status-bar setup wipes anything printed earlier.
  // Shows the restore summary plus the last 5 rounds of the conversation so
  // the user immediately sees where they left off.
  if (session.resumeNotice) {
    console.error(session.resumeNotice);
    session.resumeNotice = null;
  }
  if (session.resumeOutputsPreview?.length) {
    for (const line of session.resumeOutputsPreview) console.error(line);
    session.resumeOutputsPreview = null;
    console.error('');
  }

  const enqueue = async (line) => {
    // Mid-task capture: while an agent turn runs, plain input becomes an
    // in-task instruction delivered at the agent loop's round boundary (after
    // the current action completes) instead of sitting in session.queue until
    // the whole task finishes. Slash commands keep the legacy behavior.
    if (captureMidTaskInput(session, line)) {
      const n = session.userInputQueue.length;
      // Break any pending spinner frame / partial line FIRST: the receipt
      // must start on its own line, not glue onto `⠋ phase · 0.0s`.
      session.progress?.breakLine();
      process.stderr.write(style.success(`${style.ICON.ok} queued #${n} ${style.dim('· delivered after the current action')}`) + '\n');
      // The submitted line left the box: clear the reserved input row so it
      // doesn't keep showing the just-queued text (receipt printed above).
      session.statusBar?.refreshInputLine();
      return;
    }
    session.queue.push(line);
    if (session.processing) return;
    session.processing = true;
    try {
      while (session.queue.length > 0 && !session.exiting) {
        const l = session.queue.shift();
        await processLine(l, session, ctx);
        await flushSessionReloads(session, ctx);
      }
    } finally {
      session.processing = false;
    }
    if (session.exiting) {
      session.exitResolve?.();
      return;
    }
    if (!session.rl.closed) {
      session.rl.setPrompt(promptFor(session));
      session.rl.prompt();
      session.statusBar?.update();
    }
  };

  // Enable bracketed paste AFTER the banner so the enable sequence isn't
  // visually interleaved with it. onFlush submits the buffered paste as one
  // '\n'-joined message once the terminal sends the paste-end marker.
  paste.onFlush = (text) => { void enqueue(text); };
  paste.start();

  // ── Mid-task instruction input box: write router (docking protocol) ──
  // While the box is armed and no menu owns the input, every workspace write
  // is re-issued as DECRC (jump to the workspace continuation saved in the
  // DECSC slot) + payload + DECSC (save the advanced continuation) + park
  // (put the visible cursor back inside the box), so streaming output lands
  // in order while the blinking caret stays in the box. The DECSC slot is
  // owned exclusively by this protocol while armed: StatusBar repaints go
  // through their captured RAW write (never re-routed) and emit their own
  // park. Fully transparent when the box is off or a menu is active.
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);
  const routedWrite = (orig, chunk, ...rest) => {
    if (!session.statusBar?.isEnabled() || !session.inputEchoOn || session.consumeNext) {
      return orig(chunk, ...rest);
    }
    const park = session.statusBar.parkSeq();
    if (!park) return orig(chunk, ...rest);
    // Nested writes (issued while another routed write is mid-flight) must
    // not double the escapes; the inner park is identical, passthrough fine.
    if (routedWrite.depth) return orig(chunk, ...rest);
    // Caller-supplied drain callbacks must fire when the write drains.
    routedWrite.depth = 1;
    try {
      return orig(`\x1b8${String(chunk)}\x1b7${park}`, ...rest);
    } finally {
      routedWrite.depth = 0;
    }
  };
  routedWrite.depth = 0;
  process.stdout.write = routedWrite.bind(null, stdoutOrig);
  process.stderr.write = routedWrite.bind(null, stderrOrig);

  // ── Mid-task instruction input box: echo redirection ──────────────
  // While an agent turn runs, the input box is the FIRST reserved StatusBar
  // row. readline's native echo writes at the terminal cursor, where
  // streaming agent output would immediately trample it — so suppress native
  // echo and repaint just the input row on every keystroke. Node routes ALL
  // readline drawing through rl._writeToOutput, a single choke point; with
  // inputEchoOn false (idle turns, in-run menus via session.consumeNext,
  // slash commands) the wrapper is fully transparent.
  //
  // MAINTENANCE (review round 8): _writeToOutput / rl.line / rl.cursor are
  // readline PRIVATE surface — not stable public API across Node majors
  // (engines: >=18). The design fails OPEN: if a future Node renames or
  // removes _writeToOutput, the guard below skips installing the wrapper and
  // native echo returns unchanged (no box, no crash). test/repl_midtask_pty
  // .test.js drives this path end-to-end under a real pty; CI runs the suite
  // on Node 18/20/22 to catch drift the day it happens.
  const rlOrigWriteToOutput = session.rl._writeToOutput
    ? session.rl._writeToOutput.bind(session.rl)
    : null;
  if (rlOrigWriteToOutput) {
    session.rl._writeToOutput = function echoRouter(s) {
      // An in-run menu owns the input while session.consumeNext is armed:
      // its prompt echo must land at the cursor exactly as before.
      if (session.inputEchoOn && !session.consumeNext) return; // suppressed; box repaints itself
      rlOrigWriteToOutput(s);
    };
  }
  const refreshInputEcho = () => {
    if (!session.inputEchoOn || session.consumeNext) return;
    session.statusBar?.refreshInputLine();
  };

  // ── Mid-task instruction input box: lifecycle helpers ─────────────
  const armInputBox = () => {
    if (session.inputEchoOn) return;
    // Only redirect echo when there is a real reserved row to echo into. With
    // a non-TTY stderr (statusBar disabled — e.g. forceTty over pipes)
    // suppression would silently eat all readline output with no box shown.
    if (!session.statusBar?.isEnabled()) return;
    session.inputEchoOn = true;
    // Docking protocol: save the workspace continuation into the DECSC slot
    // FIRST (continued output must resume there), then draw the box and park
    // the real cursor inside it.
    session.statusBar?.rawWrite('\x1b7');
    session.statusBar?.update(); // grow: input row appears above plan/status
    session.statusBar?.parkInputCursor();
    refreshInputEcho();
  };
  const disarmInputBox = () => {
    if (!session.inputEchoOn) return;
    session.inputEchoOn = false;
    if (session.rl && !session.rl.closed) {
      // Clear the draft so the next idle prompt starts empty. The queued
      // receipt was already printed by the 'line' handler; anything left was
      // never submitted.
      session.rl.line = '';
      session.rl.cursor = 0;
    }
    // Undock FIRST (restore the workspace continuation from the DECSC slot)
    // so the shrink repaint's legacy save/restore tail lands the cursor at
    // the workspace position — ready for the next rl.prompt().
    session.statusBar?.undockInputCursor();
    session.statusBar?.update(); // shrink: input row released back to workspace
  };
  session.armInputBox = armInputBox;
  session.disarmInputBox = disarmInputBox;

  // Heuristic fallback for terminals WITHOUT bracketed-paste support (older
  // emulators, some IDE consoles, multiplexers that strip the mode, non-TTY
  // piped input): coalesce a rapid burst of 'line' events into one message.
  // Defers entirely to PasteHandler while a real bracketed paste is in flight.
  const ml = new MultiLineCollector({
    isPasting: () => paste.isPasting(),
    rl: session.rl,
    onFlush: (text) => { void enqueue(text); },
  });
  session.ml = ml;

  // Mid-task input box live refresh: every keystroke re-echoes the draft
  // into the reserved input row. Registered once (emitKeypressEvents is
  // idempotent) and cheap when the box is off.
  readline.emitKeypressEvents(session.rl.input);
  session.rl.input.on('keypress', () => { refreshInputEcho(); });

  // Keep readline from auto-closing on Ctrl+C: with no rl-level 'SIGINT'
  // listener, readline closes the interface itself — the mid-turn interrupt
  // path above must leave it alive. The no-op makes the process-level
  // handler the sole authority (idle Ctrl+C still exits there).
  session.rl.on('SIGINT', () => {});

  if (isInteractive) session.rl.prompt();
  session.rl.on('line', (line) => {
    // Mid-task input box: when the box is echoing, every completed line is
    // cleared from the box (the queued-#n receipt prints in its place)
    // before the normal capture path takes over.
    if (session.inputEchoOn) {
      if (session.rl) { session.rl.line = ''; session.rl.cursor = 0; }
      // The real cursor is docked and readline's \r\n echo was suppressed,
      // so the workspace continuation slot has NOT advanced. The queued
      // receipt must start on a fresh row: restore the slot, emit an explicit
      // CRLF there (CRLF, not bare LF — the tty may be raw with OPOST off),
      // save the advanced slot, and re-dock — mirroring the write router.
      const park = session.statusBar?.parkSeq?.();
      if (park) session.statusBar?.rawWrite(`\x1b8\r\n\x1b7${park}`);
    }
    // If we're mid-paste, buffer the line and wait for paste-end. Pasted
    // content otherwise arrives as one 'line' event per line and each would
    // fire as a separate agent turn.
    if (paste.bufferIfPasting(line)) return;
    // A multi-line paste is never auto-submitted; it is held as a pending
    // draft until the user presses Enter. Drain it here: an empty Enter
    // submits the pasted block; if the user typed something fresh on the
    // cleared prompt instead, that typed text wins and the draft is dropped.
    const draft = paste.consumePendingDraft(line);
    if (draft !== null) {
      void enqueue(draft);
      return;
    }
    if (session.consumeNext) {
      const cb = session.consumeNext;
      session.consumeNext = null;
      cb(line);
      return;
    }
    // Coalesce rapid multi-line bursts (paste fallback) into one message.
    // ingest() returns true when it buffered/flushed the line; false when the
    // caller should handle it directly (e.g. slash commands).
    if (ml.ingest(line)) return;
    void enqueue(line);
  });
  session.rl.on('close', () => {
    // Discard any pending multi-line paste draft on REPL exit - the user is
    // leaving, so an unconfirmed paste (never auto-submitted) is dropped
    // rather than fired off mid-shutdown.
    paste.discardPendingDraft?.();
    ml.flush();
    if (!session.processing) session.exitResolve?.();
  });

  await new Promise((resolve) => { session.exitResolve = resolve; });

  paste.stop();
  session.statusBar?.stop();
  if (!session.rl.closed) session.rl.close();
  if (isInteractive) {
    // Tell the user how to get this conversation back before the process
    // exits — the transcript survives on disk and `hk2 --resume <id>` (or a
    // bare `hk2 --resume` for the project's latest) reopens it with full
    // context. Same lifecycle rule as the TUI exit: a boot that never got a
    // message DELETES its empty transcript and the hint falls back to the
    // newest session with actual content (resumeHintAfterExit).
    let hint = null;
    try {
      const { resumeHintAfterExit } = await import('../../lib/agent/transcript.js');
      hint = await resumeHintAfterExit(session.transcript);
    } catch { /* best-effort hint */ }
    console.error(hint
      ? `Goodbye (using \`hk2 --resume ${hint}\` to resume the session)`
      : 'Goodbye');
  }
  process.exit(0);
}

export function printBanner(session, ctx) {
  // Welcome card — rounded border with title in the top edge.
  const projTag = session.project ? session.project.name : style.warning('no project');
  const kbTag = kbBrief(session);
  // Show the full provider/model ref (incl. a trailing [ctx] hint) so two
  // providers hosting the same model id are distinguishable in the welcome
  // card, and the active context length stays visible. Matches the prompt
  // and status bar via modelTagFor().
  const modelTag = session.modelCfg
    ? modelTagFor(session)
    : style.warning('no-model');
  // Cap at 96 cols (was 72) so the Project/KB/Model row has breathing room
  // once KB shows Eden/N Holy/N. Still shrinks to term width on narrow
  // terminals and floors at 40 so the logo + tagline stay readable.
  const width = Math.min(96, Math.max(40, style.termWidth()));
  // Logo + tagline on the first rows; the ASCII art is rendered through the
  // active palette so it stays readable on any theme.
  const logoRows = renderLogo(style);
  const tagline = [
    style.bold(style.accent('hk2')) + ' ' + style.muted(VERSION + ' — KB-driven coding agent'),
    '',
    style.dim('interactive REPL · per-project KB'),
    '',
    style.italic(style.dim('esc to interrupt · typing mid-task queues an instruction')),
  ];
  // Pair logo rows with tagline rows (left logo, right tagline).
  const headerRows = [];
  for (let i = 0; i < logoRows.length; i++) {
    const logo = logoRows[i];
    const tag = tagline[i] || '';
    headerRows.push(`${logo}  ${tag}`);
  }
  const lines = [
    ...headerRows,
    '',
    `${style.accent('Project:')} ${style.muted(projTag)}   ${style.accent('KB:')} ${kbTag}   ${style.accent('Model:')} ${style.muted(modelTag)}`,
    '',
    `${style.dim('/help')} ${style.muted('commands')}  ${style.dim('/quit')} ${style.muted('exit')}  ${style.dim('\\\\')} ${style.muted('multi-line')}`,
  ];
  for (const ln of style.card({ title: 'hk2', lines, width, token: 'border' })) {
    ctx.print(ln);
  }
  ctx.print('');
  if (!session.project) {
    ctx.print(`${style.warning('⚠ No current project.')}`);
    ctx.print(`  Register: ${style.accent('/project init --name=... --source=... --source-root=...')}`);
    ctx.print(`  Switch:   ${style.accent('/project set current <id|name>')}`);
    ctx.print('');
  } else if (!session.rt) {
    ctx.print(`${style.warning('⚠ No KB for')} ${style.muted(`"${session.project.name}"`)}`);
    ctx.print(`  ${style.accent('/kb init')}`);
    ctx.print('');
  }
  if (!session.modelCfg) {
    ctx.print(`${style.warning('⚠ No default model configured.')}`);
    ctx.print(`  ${style.accent('/model add <provider> <model-id> --api-key=... --base-url=...')}`);
    ctx.print(`  ${style.accent('/model set-default <provider>/<model-id>')}`);
    ctx.print(`  ${style.accent('/model use <provider>/<model-id>')}  (session only)`);
    ctx.print('');
  }
}

/**
 * Tab completion over the DERIVED slash-command surface (see
 * allSlashCompletionLabels in slash/index.js): every completion comes from
 * SLASH_COMMANDS + the HELP_TEXT subcommand sections, so the list can never
 * drift from the registered commands. Replaces the former hand-maintained
 * 40-entry array that had already fallen behind the real command set.
 */
function makeCompleter() {
  const cmds = allSlashCompletionLabels();
  return function completer(line) {
    const hits = cmds.filter(c => c.startsWith(line));
    return [hits.length ? hits : cmds, line];
  };
}

/* ------------------------------------------------------------------ */

async function processLine(line, session, ctx) {
  if (session.multilineBuf !== null) {
    if (line.trim() === '') {
      const full = session.multilineBuf;
      session.multilineBuf = null;
      await handleLine(full, session, ctx);
    } else {
      session.multilineBuf += '\n' + line;
      session.rl.setPrompt('... ');
      session.rl.prompt();
    }
    return;
  }
  if (line.trim().endsWith('\\') && !line.trim().startsWith('/')) {
    session.multilineBuf = line.trim().slice(0, -1);
    session.rl.setPrompt('... ');
    session.rl.prompt();
    return;
  }
  await handleLine(line, session, ctx);
}


/**
 * Line handler — thin wrapper over the shared handleUserLine (turn.js),
 * driving it with the line-REPL ui. The TUI front-end calls handleUserLine
 * directly with its own ui.
 */
async function handleLine(line, session, ctx) {
  await handleUserLine(line, session, ctx, makeReplUi(session));
}

/**
 * Thin wrapper kept for internal callers (handleLine) and source compat: the
 * turn pipeline now lives in turn.js, driven through the line-REPL ui
 * (repl_ui.js) so its byte stream is identical to the pre-extraction REPL.
 * The TUI front-end calls runTurn directly with its own ui.
 */
async function runAgentTurn(userText, session, ctx, opts = {}) {
  return runTurn(userText, session, ctx, makeReplUi(session), opts);
}

