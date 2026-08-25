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
import { ensureHome, getCurrentProject, getProject, setCurrentProject, resolveDefaultModel, resolveModelRef, getPhaseModelRef } from '../../lib/config/home.js';
import { getRuntime, dropRuntime } from '../../lib/retrieval/kb_runtime.js';
import { LLMClient } from '../../lib/llm/client.js';
import { runPhaseWithFallback, runPhaseWithSkipOnUnreachable } from '../phase_fallback.js';
import { buildTools, KbFirstGuard } from '../../lib/agent/tools.js';
import { getMcpTools, invalidateMcpTools, invalidateAllMcpTools } from '../../lib/agent/mcp.js';
import { runLoop } from '../../lib/agent/loop.js';
import { buildKbStats, fallbackKind, classifyRead } from '../../lib/agent/kb_stats.js';
import { estimateTokensFromChars } from '../../lib/llm/client.js';
import { buildSystemPrompt } from '../../lib/agent/system_prompt.js';
import { reviewPlan } from '../../lib/agent/plan_review.js';
import { reviewCode, buildCodeReviewContent, createVerdictFilter } from '../../lib/agent/code_review.js';
import { buildRequestGraph, renderRequestGraph } from '../../lib/agent/graph.js';
import { dispatchSlash } from '../slash/index.js';
import { getKbMeta } from '../../lib/index/registry.js';
import { ProgressIndicator } from '../progress.js';
import Transcript from '../../lib/agent/transcript.js';
import { StatusBar } from '../../lib/agent/statusbar.js';
import { PasteHandler } from '../../lib/agent/paste.js';
import { MultiLineCollector } from '../../lib/agent/multiline.js';
import * as style from '../../lib/agent/style.js';
import { renderLogo } from '../../lib/agent/logo.js';
import { MarkdownStream } from '../../lib/agent/markdown.js';
import { ReasoningStream } from '../../lib/agent/reasoning_stream.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { exists } from '../../lib/util/fs_atomic.js';
import { saveTaskState, loadTaskState, clearTaskState } from '../../lib/agent/task_state.js';
import { replayTranscript, findLatestSessionId } from '../../lib/agent/transcript.js';
import { toolCardToken, loadTheme } from '../../lib/agent/tool_theme.js';
import { VERSION } from '../version.js';

/**
 * Build a bare session object (no readline / status bar). Shared by
 * interactive() and the multi-session isolation tests so the pin logic is
 * exercised against the exact same shape the REPL uses.
 *
 * `pinnedProjectId` is null for a bare launch (resolved from global current
 * on first reload) or a project id for `--project=<...>` launches.
 */
export function createSession(pinnedProjectId = null) {
  return {
    project: null,
    pinnedProjectId,
    kbMeta: null,
    rt: null,
    llm: null,
    modelCfg: null,
    sessionModelRef: null,
    transcript: null,
    messages: [],
    lastAnswer: null,
    reloadFlags: { project: false, kb: false, model: false },
    rl: null,
    exiting: false,
    multilineBuf: null,
    queue: [],
    processing: false,
    exitResolve: null,
    consumeNext: null,
    startedAt: new Date().toISOString(),
    toolCallCount: 0,
    bashSearchCommands: [],
    // Per-loop KB-hit-rate / token-savings tracking. Reset at the start of
    // each turn's first LLM call (onTurnStart _turnIdx===1). Each entry is
    // `{ call, result, seq }` — seq restores true execution order so the
    // stats helper can classify a read against exactly the KB results that
    // preceded it (targeted vs cold).
    loopKbCalls: [],
    loopFallbackCalls: [],
    loopCallSeq: 0,
    tokens: { callIn: 0, callOut: 0, loopIn: 0, loopOut: 0, loopPeakIn: 0, loopPeakOut: 0, cumIn: 0, cumOut: 0, cacheRead: 0, cacheCreation: 0 },
    statusBar: null,
    phase: 'idle',
    turnStart: 0,
    // Last measured context size (input tokens) of the most recent completed
    // turn. Snapshotted from loopPeakIn/callIn at end-of-turn (those get reset
    // at the next turn start) and used by auto context compaction.
    lastContextTokens: 0,
    planProgress: null,
    // Set when the agent confirms a plan this turn (planConfirm callback). Used
    // to decide whether the end-of-turn Code Review step should run. lastPlanText
    // is the confirmed plan text, captured for the code-review prompt.
    hadPlanThisTurn: false,
    lastPlanText: null,
    // In-session task context for interruption recovery. Updated at the start
    // of each turn with the user's request + a text snapshot of the live plan
    // progress. When the user types "请继续/continue" after an interruption,
    // runAgentTurn injects this as a system message so the LLM can rebuild
    // "what was I doing, which step, what's next" instead of seeing a bare
    // continuation cue with no memory. Mirrored to disk via task_state.js so
    // a process restart (not just an in-session error) can also recover.
    lastTask: null,
    // True right after a session resume: the replayed history contains no
    // system prompt (replayTranscript skips system_prompt events — it must be
    // rebuilt with the CURRENT tool list), so runAgentTurn inserts a fresh
    // one at the head of history on the next turn.
    needsSystemPrompt: false,
    kbGuard: new KbFirstGuard(),
    // Set when the agent successfully persisted knowledge via kb_save_knowledge
    // this turn ({ saved: true } result) or the user explicitly approved/refused
    // a proposal. End-of-turn learnNewKnowledge() is SKIPPED when a save
    // already happened, so the same task is not learned twice. Reset at the
    // start of each turn.
    kbSavedThisTurn: false,
    kbSavedEntries: [],
    // Session-level "recently learned" cooldown (epoch ms). Refreshed whenever
    // knowledge capture is HANDLED for this session's current task: agent saved
    // via kb_save_knowledge, user answered the end-of-turn proposal (commit or
    // decline), or the user declined an agent proposal. While kbLearnHandledAt is
    // within the cooldown (HK2_KB_LEARN_COOLDOWN_MIN, default 0 = OFF, set
    // positive minutes to enable),
    // the end-of-turn [kb learn] fallback is skipped — follow-up turns of the
    // same task and --resume'd sessions must not re-extract what was just
    // learned. Restored from the transcript by resumeSessionInto.
    kbLearnHandledAt: 0,
    // Holy-over-Eden conflicts detected by this turn's buildRequestGraph:
    // [{ eden: {id,title}, holy: {id,title} }]. Populated right after graph
    // retrieval, printed as a user-facing notice, and consumed at end of turn
    // by syncConflictingEden() which stamps the Eden entries as superseded
    // (Eden is auto-updatable, so this happens without an extra prompt).
    kbConflicts: [],
    // Mid-task user input: while runAgentTurn is active, non-slash input is
    // captured here (FIFO) instead of session.queue, and injected into the
    // RUNNING conversation at the agent loop's round boundary (after all
    // tool_calls of the current round complete, before the next LLM call) —
    // see runLoop's onRoundBoundary. Slash commands are NOT captured; they
    // keep the legacy behavior of waiting for the turn to end, because they
    // may mutate session state (model / KB / project) the in-flight turn
    // still depends on. Menu input (session.consumeNext) is checked BEFORE
    // enqueue in the rl line handler, so plan/confirm menus are unaffected.
    userInputQueue: [],
    // True while runAgentTurn is executing (armed at turn start, disarmed in
    // its finally). enqueue() consults this to decide whether to capture.
    agentTurnActive: false,
  };
}

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
      + (session.lastTask ? '; interrupted task state recovered (type 请继续/continue to go on)' : '');
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
  });
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
    process.once('SIGINT', () => { restoreOnce(); process.exit(130); });
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
      process.stderr.write(style.success(`${style.ICON.ok} queued #${n} ${style.dim('· delivered after the current action')}`) + '\n');
      return;
    }
    session.queue.push(line);
    if (session.processing) return;
    session.processing = true;
    try {
      while (session.queue.length > 0 && !session.exiting) {
        const l = session.queue.shift();
        await processLine(l, session, ctx);
        if (session.reloadFlags.project || session.reloadFlags.kb || session.reloadFlags.model) {
          await reloadAll(session, ctx, session.reloadFlags);
          session.reloadFlags = { project: false, kb: false, model: false };
        }
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

  if (isInteractive) session.rl.prompt();
  session.rl.on('line', (line) => {
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
    // context.
    const sid = session.transcript?.sessionId;
    console.error(sid
      ? `Goodbye (using \`hk2 --resume ${sid}\` to resume the session)`
      : 'Goodbye');
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ */

/**
 * Flatten replayed LLM messages into ordered OUTPUT EVENTS — the same units
 * the user watched scroll by in the live session:
 *   { kind: 'user',  text }        context marker (a new question was asked)
 *   { kind: 'tool',  name, args }  ONE tool call (args = parsed object)
 *   { kind: 'reply', text }        ONE assistant text reply
 *
 * Why events, not "rounds": a single user question fans out into dozens of
 * tool calls (real transcripts show e.g. 2 user events vs 37 tool_call
 * events), so slicing by user turns yields 1-2 huge "rounds" and a
 * "last 5 rounds" preview degenerates into stale round-openings. Keying on
 * output events makes "last 5" mean the five most recent things the agent
 * actually emitted. Consecutive tool_calls inside one replayed assistant
 * message are flattened to individual events, preserving order.
 *
 * Pure data, no ANSI — exported for unit testing.
 *
 * @param {Array} messages LLM-shaped messages (as produced by replayTranscript)
 * @returns {Array<{kind:'user',text:string}|{kind:'tool',name:string,args:object}|{kind:'reply',text:string}>}
 */
export function splitOutputUnits(messages) {
  const events = [];
  let sawUser = false; // defensive: replayTranscript never emits pre-user msgs
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      sawUser = true;
      if (typeof m.content === 'string' && m.content.trim()) {
        events.push({ kind: 'user', text: m.content });
      }
      continue;
    }
    if (m.role !== 'assistant' || !sawUser) continue; // role:'tool' too verbose
    if (Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        events.push({
          kind: 'tool',
          name: c?.function?.name || '?',
          args: typeof c?.function?.arguments === 'string'
            ? safeParseArgs(c.function.arguments)
            : (c?.function?.arguments || {}),
        });
      }
    }
    // tool_calls and content are independent — a live-loop assistant message
    // may carry both; the replayed shape carries either.
    if (typeof m.content === 'string' && m.content.trim()) {
      events.push({ kind: 'reply', text: m.content });
    }
  }
  return events;
}

/**
 * Lines for the `you:` context marker of a user event. FULL fidelity: no
 * truncation, no ellipsis — multi-line inputs keep every line (first line
 * carries the `you:` prefix, the rest are aligned under it).
 */
function userMarkerLines(text) {
  const raw = String(text ?? '').replace(/\r/g, '').split('\n');
  return raw.map((l, i) => (i === 0 ? `you: ${l}` : `     ${l}`));
}

/** Every line of a reply, verbatim — no clamping, no truncation, no ellipsis. */
function allLines(text) {
  return String(text ?? '').replace(/\r/g, '').split('\n');
}

/**
 * Render the LAST N OUTPUT EVENTS (default 5) of a resumed session as display
 * lines, so the user immediately sees what the agent last DID — the most
 * recent tool calls (rendered with toolHeader, matching the live cards) and
 * reply texts. `user` events inside the window are shown as dim context
 * markers but do NOT count toward N. Used by the `hk2 --resume` launch path
 * (printed AFTER the welcome banner — the TTY clear at startup wipes anything
 * printed earlier) and by `/session resume` (via ctx.recentOutputs).
 *
 * FULL fidelity: every reply line is printed verbatim and tool arguments are
 * never truncated — no `… (N more line(s))` markers, no char caps.
 *
 * @param {Array} messages LLM-shaped messages (session.messages after resume)
 * @param {{outputs?: number}} opts outputs: how many trailing output events to show
 * @returns {string[]} styled lines; empty array when there is nothing to show
 */
export function formatRecentOutputs(messages, { outputs = 5 } = {}) {
  const all = splitOutputUnits(messages);
  const outputIdx = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].kind !== 'user') outputIdx.push(i);
  }
  if (outputIdx.length === 0) return [];
  const n = Math.max(1, outputs | 0);
  const from = Math.max(0, outputIdx.length - n);
  const shown = outputIdx.length - from;
  const window = all.slice(outputIdx[from]);
  const out = [
    style.bold(style.accent(`── last ${shown} of ${outputIdx.length} output(s) ──`)),
  ];
  for (const ev of window) {
    if (ev.kind === 'user') {
      for (const line of userMarkerLines(ev.text)) out.push(style.muted(line));
    } else if (ev.kind === 'tool') {
      const token = toolCardToken(ev.name);
      out.push(`  ${toolHeader(ev.name, ev.args, token, { full: true })}`);
    } else {
      out.push(style.dim('  reply:'));
      for (const line of allLines(ev.text)) out.push(`  ${line}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * Resume a previous session into `session` — the shared engine behind both
 * `hk2 --resume <id>` (launch-time) and `/session resume <id>` (in-REPL).
 *
 * Replays the target transcript's JSONL into `session.messages` with FULL
 * fidelity (assistant tool_calls + role:tool pairs, not just user/assistant
 * text), restores the interrupted-task context (lastTask + planProgress)
 * from task_state.js when it belongs to this session, and swaps the
 * transcript object so subsequent events APPEND to the same file (history
 * survives).
 *
 * @param {object} session the live REPL session
 * @param {string|null} sessionId explicit id, or null for "the project's
 *   latest session" (excludes the file this REPL is currently writing)
 * @returns {Promise<boolean>} true on success; false = not found / no project
 */
async function resumeSessionInto(session, sessionId) {
  if (!session.project) return false;
  let id = sessionId;
  if (!id) {
    id = await findLatestSessionId(session.project.id, {
      // NEVER pick the session this REPL just created / is writing — that
      // would resume "now" (an empty history). At launch time reloadAll has
      // already written the fresh transcript's session_start line to disk,
      // so without this exclusion a bare `hk2 --resume` would find the
      // brand-new empty session as the "latest".
      exclude: session.transcript?.sessionId,
    });
    if (!id) return false;
  }
  const t = new Transcript(session.project.id, id);
  if (!await exists(t.path)) return false;
  const text = await fs.readFile(t.path, 'utf8');
  const { messages, lastUserText, firstTs, lastTs } = replayTranscript(text);

  session.transcript = t;
  session.messages = messages;
  session.lastAnswer = null;
  session.toolCallCount = 0;
  session.needsSystemPrompt = messages.length > 0;

  // Restore interrupted-task context when task_state points at this session.
  // (A /quit'd session that finished its task normally has no taskstate on
  // disk — clearTaskState already ran — so nothing is restored and "请继续"
  // is treated as a fresh request, which is correct.)
  const saved = await loadTaskState(session.project.id);
  if (saved && saved.userRequest && saved.sessionId === id) {
    session.lastTask = {
      userRequest: saved.userRequest,
      capturedAt: saved.interruptedAt,
      restored: true,
    };
    if (saved.planProgress && Array.isArray(saved.planProgress.steps)
        && saved.planProgress.steps.some(s => s.status !== 'done')) {
      session.planProgress = saved.planProgress;
    }
  } else {
    session.lastTask = null;
    session.planProgress = null;
  }

  await t.logMeta('resume', {
    pid: process.pid,
    cwd: process.cwd(),
    replayedMessages: messages.length,
    originalStart: firstTs,
    lastEvent: lastTs,
    restoredTask: !!session.lastTask,
  });

  // Restore the "recently learned" cooldown from the transcript so a resumed
  // session doesn't re-extract knowledge that was just captured before the
  // restart. We scan for the LATEST evidence of a handled knowledge capture:
  //   - meta learned_knowledge (end-of-turn [kb learn] committed)
  //   - tool_call kb_save_knowledge with result.saved/cancelled (agent saved,
  //     or the user answered its y/N proposal)
  // and take the most recent ts among them — matching the in-session behavior
  // where a cancelled proposal also sets the skip flag. Hard tool errors and
  // pure LLM declines (skip) are NOT logged distinctly and so do not arm the
  // cooldown here; re-offering after a resume is the safer failure mode.
  try {
    let latest = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      if (!raw.includes('learned_knowledge') && !raw.includes('kb_save_knowledge')) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      const ts = ev && typeof ev.ts === 'string' ? Date.parse(ev.ts) : NaN;
      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (ev.type === 'meta' && ev.key === 'learned_knowledge') {
        if (ts > latest) latest = ts;
      } else if (ev.type === 'tool_call' && ev.name === 'kb_save_knowledge') {
        const res = ev.result;
        if (res && typeof res === 'object' && (res.saved || res.cancelled)) {
          if (ts > latest) latest = ts;
        }
      }
    }
    session.kbLearnHandledAt = latest;
  } catch { /* best-effort; cooldown stays 0 (fallback extraction enabled) */ }
  return true;
}

/**
 * Three-way yes/no/eden prompt (y/N/E) for NEW Holy knowledge saves.
 * Same readline mechanics as ctx.confirm (consumeNext + close-fallback), but
 * additionally accepts e/eden which resolves to the string 'eden'. Unrecognized
 * or empty input re-prompts; Ctrl+D / closed rl resolves false.
 * Exported for unit tests.
 */
export function confirmThreeWay(session, promptText) {
  if (!session.rl) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onClose = () => resolve(false);
    session.rl.once('close', onClose);
    const done = (val) => {
      session.rl.off('close', onClose);
      resolve(val);
    };
    const ask = () => {
      process.stderr.write(promptText);
      session.consumeNext = (ans) => {
        const v = (ans || '').trim().toLowerCase();
        if (v === 'y' || v === 'yes') { done(true); return; }
        if (v === 'n' || v === 'no') { done(false); return; }
        if (v === 'e' || v === 'eden') { done('eden'); return; }
        process.stderr.write('Please answer y, n, or e. ');
        ask();
      };
    };
    ask();
  });
}

export function buildCtx(session) {
  return {
    print: (text) => console.error(text),
    confirm: async (promptText) => {
      if (!session.rl) return false;
      // Loop until we get a recognizable yes/no answer. This fixes the bug
      // where typing a wrong answer (e.g. "N") and pressing Backspace to
      // correct it would submit an empty line and silently resolve to the
      // default (false), quitting the KB update with no chance to re-answer.
      // Empty input (just Enter, or Backspace-to-empty + Enter) now re-prompts.
      // Explicit y/yes -> true; n/no -> false.
      // Ctrl+D / rl close -> false (treated as decline / cancel).
      return await new Promise((resolve) => {
        const onClose = () => resolve(false);
        session.rl.once('close', onClose);
        const done = (val) => {
          session.rl.off('close', onClose);
          resolve(val);
        };
        const ask = () => {
          process.stderr.write(promptText);
          session.consumeNext = (ans) => {
            const v = (ans || '').trim().toLowerCase();
            if (v === 'y' || v === 'yes') { done(true); return; }
            if (v === 'n' || v === 'no') { done(false); return; }
            // Empty or unrecognized (e.g. user backspaced to nothing, or typed
            // garbage): re-prompt so they get another chance instead of being
            // silently dropped.
            process.stderr.write('Please answer y or n. ');
            ask();
          };
        };
        ask();
      });
    },
    /**
     * Numeric menu prompt (1..N) for slash commands that offer a choice list
     * (e.g. /kb knowledge housekeep conflict resolution). Same readline
     * mechanics as confirm: re-prompts on invalid input, Enter defaults to
     * the LAST option, Ctrl+D / closed rl also returns the last option
     * (fail-safe: the caller treats "last" as the conservative skip).
     * Returns the 1-based index of the chosen option.
     */
    choose: async (promptText, options = []) => {
      const n = options.length;
      if (n === 0) return null;
      if (!session.rl) return n; // non-interactive: conservative default (last)
      return await new Promise((resolve) => {
        const onClose = () => resolve(n);
        session.rl.once('close', onClose);
        const done = (val) => {
          session.rl.off('close', onClose);
          resolve(val);
        };
        const ask = () => {
          process.stderr.write(promptText);
          session.consumeNext = (ans) => {
            const v = (ans || '').trim();
            if (!v) { done(n); return; }              // Enter → default (last)
            const num = parseInt(v, 10);
            if (Number.isInteger(num) && num >= 1 && num <= n) { done(num); return; }
            process.stderr.write(`Please answer 1-${n}. `);
            ask();
          };
        };
        ask();
      });
    },
    get lastAnswer() { return session.lastAnswer; },
    get llm() { return session.llm; },
    get modelCfg() { return session.modelCfg; },
    /** Session-only model override ref (set via /model use); null when the session follows the default. */
    get sessionModelRef() { return session.sessionModelRef; },
    get rt() { return session.rt; },
    /**
     * Hot-swap the session's active model (session-only, not persisted).
     * Used by /model use and /model set (when editing the active model) so the
     * change takes effect immediately without reloading from models.json.
     */
    setModel: (cfg) => {
      if (!cfg) return;
      // Model switched: the MCP toolset of the previous model must not leak
      // into turns that use the new one.
      invalidateMcpTools(session.sessionModelRef);
      session.modelCfg = cfg;
      session.sessionModelRef = cfg.ref || null;
      session.llm = new LLMClient(cfg);
      session.statusBar?.update();
    },
    /** Clear any session-only model override so the next reload falls back to the persisted default. */
    clearSessionModel: () => {
      invalidateMcpTools(session.sessionModelRef);
      session.sessionModelRef = null;
    },
    /** Set the status-bar phase string and refresh the bar. */
    setPhase: (p) => {
      session.phase = p;
      if (!session.turnStart) session.turnStart = Date.now();
      session.statusBar?.update();
    },
    /**
     * Stream from the LLM with status-bar tracking. Wraps ctx.llm.stream()
     * so that usage events update session.tokens and the status bar refreshes.
     * Use this in slash commands that make LLM calls (e.g. /kb knowledge learn).
     *
     * A slash-command stream is treated as its own loop: callIn/callOut and
     * loopIn/loopOut both reset at start. loopIn/loopOut are delta-updated on
     * each usage event so the bar shows running totals mid-stream (not just
     * after the stream ends).
     */
    streamLLM: async function* (messages, opts = {}) {
      if (!session.llm) throw new Error('No LLM configured');
      // Reset per-call AND per-loop token counters for this stream.
      session.tokens.callIn = 0;
      session.tokens.callOut = 0;
      session.tokens.loopIn = 0;
      session.tokens.loopOut = 0;
      session.tokens.loopPeakIn = 0;
      session.tokens.loopPeakOut = 0;
      session.statusBar?.update();
      for await (const evt of session.llm.stream(messages, opts)) {
        if (evt.type === 'usage') {
          if (typeof evt.input === 'number' && evt.input > 0 && evt.input > session.tokens.callIn) {
            // Delta-update loop so the bar reflects the in-flight call.
            session.tokens.loopIn += evt.input - session.tokens.callIn;
            session.tokens.callIn = evt.input;
            // Peak across the loop = max single-call input. This is what
            // the context window actually constrains, so the % in the bar
            // can't exceed 100% unless the provider accepted >window tokens.
            if (session.tokens.callIn > session.tokens.loopPeakIn) {
              session.tokens.loopPeakIn = session.tokens.callIn;
            }
          }
          if (typeof evt.output === 'number' && evt.output > 0 && evt.output > session.tokens.callOut) {
            session.tokens.loopOut += evt.output - session.tokens.callOut;
            session.tokens.callOut = evt.output;
            if (session.tokens.callOut > session.tokens.loopPeakOut) {
              session.tokens.loopPeakOut = session.tokens.callOut;
            }
          }
          session.statusBar?.update();
        }
        yield evt;
      }
      // Commit this stream's call maxima to the cumulative session totals.
      session.tokens.cumIn += session.tokens.callIn;
      session.tokens.cumOut += session.tokens.callOut;
    },
    /**
     * Resolve the project this session is operating on. Honors the session
     * pin (set at launch via --project or migrated by setCurrentProject);
     * only falls back to the shared global `current` when no pin is set
     * (bare launch with no project chosen yet). Slash commands should call
     * THIS instead of importing getCurrentProject directly, so two parallel
     * `hk2 --project=` sessions never cross-resolve onto each other's project.
     */
    getCurrentProject: async () => {
      if (session.pinnedProjectId) {
        const p = await getProject(session.pinnedProjectId);
        if (p) return p;
      }
      const p = await getCurrentProject();
      if (p) session.pinnedProjectId = p.id;
      return p;
    },
    /**
     * Switch this session onto a different project AND update the shared
     * global `current` pointer (so /project show etc. stay consistent).
     * Migrating the pin means the switch takes effect in THIS session even
     * if another parallel process later rewrites the global pointer.
     * Returns the resolved project record, or null if not found.
     */
    setCurrentProject: async (idOrName) => {
      const target = await setCurrentProject(idOrName);
      if (target) {
        session.pinnedProjectId = target.id;
        session.reloadFlags.project = true;
        session.reloadFlags.kb = true;
        // The effective default model is project-scoped (resolveDefaultModel
        // prefers the project's defaultModel override), so a project switch
        // must also re-resolve the model — unless a session-only override
        // (/model use) is active, which always wins.
        if (!session.sessionModelRef) session.reloadFlags.model = true;
      }
      return target;
    },
    /** Read-only accessor for the session pin (null when unpinned). */
    get pinnedProjectId() { return session.pinnedProjectId; },
    noteReloadModels: () => { session.reloadFlags.model = true; },
    noteReloadProject: () => { session.reloadFlags.project = true; session.reloadFlags.kb = true; },
    noteReloadKb: () => { session.reloadFlags.kb = true; },
    clearConversation: () => {
      session.messages = [];
      session.lastAnswer = null;
      session.needsSystemPrompt = false;
    },
    newSession: async () => {
      const oldProject = session.project;
      session.transcript = null;
      session.messages = [];
      session.lastAnswer = null;
      session.toolCallCount = 0;
      session.needsSystemPrompt = false;
      if (oldProject) {
        session.transcript = new Transcript(oldProject.id);
        await session.transcript.logMeta('start', { pid: process.pid, cwd: process.cwd(), reason: 'new-session' });
      }
    },
    resumeSession: async (sessionId) => {
      // sessionId undefined/null → the project's latest PREVIOUS session
      // (excluding the one this REPL is currently writing to).
      return resumeSessionInto(session, sessionId || null);
    },
    /**
     * Render the last N output events (default 5) of the CURRENT conversation
     * as display lines — used by /session resume to show what the agent last
     * did. Returns [] when the conversation has no outputs yet.
     */
    recentOutputs: (n = 5) => formatRecentOutputs(session.messages, { outputs: n }),
    getSessionInfo: () => {
      const info = {
        sessionId: session.transcript?.sessionId,
        projectId: session.project?.id,
        projectName: session.project?.name,
        startedAt: session.startedAt,
        messageCount: session.messages.filter(m => m.role === 'user' || m.role === 'assistant').length,
        toolCalls: session.toolCallCount,
        path: session.transcript?.path,
      };
      return info;
    },
    compactConversation: async () => {
      const out = await compactMessages(session);
      if (out == null) {
        console.error(`(nothing to compact yet)`);
        return;
      }
      session.messages = out.messages;
      await session.transcript?.logMeta('compact', { dropped: out.dropped, kept: out.kept });
      console.error(`Compacted: dropped ${out.dropped} messages, kept ${out.kept}.`);
    },
    /**
     * Read-only view of the current conversation for the /review command:
     * the latest user request (the "task requirement") and the assistant's
     * final answer (the "claimed result"). Deliberately returns ONLY these
     * two strings - /review's contract is to review the completed result in
     * isolation, without any of the implementation-process context (tool
     * calls, reasoning, intermediate turns) that could anchor the reviewer.
     */
    getConversation: async () => {
      const msgs = Array.isArray(session.messages) ? session.messages : [];
      let requestText = '';
      let answerText = '';
      // requestText = the LAST user message (the most recent task; earlier
      // ones belong to previous tasks in the same conversation).
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
          requestText = m.content;
          break;
        }
      }
      // answerText = the assistant's final answer: session.lastAnswer is the
      // definitive end-of-turn answer (already excludes tool-call frames);
      // fall back to the last plain-text assistant message when it is not set
      // (e.g. a resumed session).
      answerText = typeof session.lastAnswer === 'string' ? session.lastAnswer : '';
      if (!answerText.trim()) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
            answerText = m.content;
            break;
          }
        }
      }
      return { requestText, answerText };
    },
    /**
     * Working-tree material (tracked diff + untracked file contents + changed
     * file list) for the /review command. Same collector as the automatic
     * end-of-turn Code Review; best-effort, returns empty fields when the
     * project path isn't a git repo.
     */
    collectWorkingTreeDiff: async () => collectWorkingTreeDiff(session.project?.sourcePath),
    exit: () => { session.exiting = true; },
  };
}

export async function reloadAll(session, ctx, flags = { project: true, kb: true, model: true }) {
  if (flags.project) {
    // Resolve the project from the session pin when set, falling back to the
    // global `current` pointer for a bare launch. The pin is (re)synced after
    // resolution so a bare launch captures the global current as its pin
    // (and subsequent global-current churn in another process can't pull
    // this session onto a different project).
    let p = null;
    if (session.pinnedProjectId) {
      p = await getProject(session.pinnedProjectId);
    } else {
      p = await getCurrentProject();
      if (p) session.pinnedProjectId = p.id;
    }
    session.project = p;
    if (session.project && session.project.sourcePath) {
      process.env.HK2_PROJECT_SOURCE = session.project.sourcePath;
    }
    if (session.project && !session.transcript) {
      session.transcript = new Transcript(session.project.id);
      await session.transcript.logMeta('start', { pid: process.pid, cwd: process.cwd() });
    }
    // Cross-process interruption recovery: if a previous process for this
    // project was interrupted mid-task and persisted its task state, restore
    // it into session.lastTask / planProgress so a "请继续 / continue" cue can
    // resume the work. Only on the initial project load (flags.project) and
    // only when we don't already have in-session context (a reloaded session
    // keeps its own lastTask).
    if (flags.project && !session.lastTask && session.project) {
      const saved = await loadTaskState(session.project.id);
      if (saved && saved.userRequest) {
        session.lastTask = {
          userRequest: saved.userRequest,
          capturedAt: saved.interruptedAt,
          restored: true,
        };
        // Restore the live progress panel too, so the user sees where the
        // interrupted task left off as soon as the REPL comes up.
        if (saved.planProgress && Array.isArray(saved.planProgress.steps) &&
            saved.planProgress.steps.some(st => st.status !== 'done')) {
          session.planProgress = saved.planProgress;
          session.statusBar?.update();
        }
      }
    }
    session.kbMeta = session.project ? await getKbMeta(session.project.id) : null;
  }
  if (flags.kb) {
    if (session.project) {
      session.kbMeta = await getKbMeta(session.project.id);
      if (session.kbMeta) {
        try { session.rt = await getRuntime(session.project.id); }
        catch (err) { session.rt = null; console.error(`[warn] KB load failed: ${err.message}`); }
      } else {
        session.rt = null;
      }
    } else {
      session.rt = null;
    }
  }
  if (flags.model) {
    // If the session has a session-only model override (set via /model use),
    // keep it - a models.json reload must not clobber an explicit per-session
    // choice. Only re-resolve the default when there is no override.
    // MCP tool caches are dropped either way: models.json may have changed
    // mcpServers / api keys under us.
    invalidateAllMcpTools();
    if (session.sessionModelRef) {
      const cfg = await resolveModelRef(session.sessionModelRef);
      if (cfg) {
        session.modelCfg = cfg;
        session.llm = new LLMClient(cfg);
      } else {
        session.llm = null;
      }
    } else {
      // Resolve the default against THIS session's project (the pin), NOT the
      // global `current` pointer: `hk2 --project=postgres` must not inherit
      // the global-current project's defaultModel override, and
      // `hk2 --project=kernel-deepdive` must use its own override. session.project
      // was (re)loaded above by the flags.project branch — which runs first even
      // on a model-only reload, because every project-mutating command also
      // flags a project reload — so a mid-session /model set-default current
      // picks up the fresh record. null (no project) skips the override path
      // entirely and falls through to the global models.json default.
      const cfg = await resolveDefaultModel(session.project || null);
      if (cfg) {
        session.modelCfg = cfg;
        session.llm = new LLMClient(cfg);
      } else {
        session.llm = null;
      }
    }
  }
}

/**
 * Compact, *provider-distinguishing* model label for the prompt, status bar,
 * and welcome card. We show the full `provider/model-id` ref (not just the
 * model-id segment) so that two providers hosting the same model id are
 * visually distinct - e.g. `volcengine/glm-5.2[1m]` vs
 * `volcengine2/glm-5.2[1m]`. A trailing bracketed context-window hint
 * (e.g. `[1m]`) is PRESERVED so the active context length stays visible.
 * Returns the empty string when no model is configured (caller styles it).
 */
function modelTagFor(session) {
  if (!session.modelCfg || !session.modelCfg.ref) return '';
  return session.modelCfg.ref;
}

function promptFor(session) {
  // Colored prompt. Compact; live state lives in the status bar.
  const projTag = session.project ? style.accent(session.project.name) : style.dim('no-project');
  const kbTag = kbBrief(session);
  const modelTag = session.modelCfg ? style.muted(modelTagFor(session)) : style.warning('no-model');
  const sep = style.dim('|');
  return `${style.dim('hk2')}(${projTag}${sep}${kbTag}${sep}${modelTag})${style.accent('>')} `;
}

/**
 * Compact one-line KB summary for prompt / status bar / welcome card.
 * Returns a styled string showing per-space entry counts, e.g.
 *   "Eden/147 Holy/1"  (KB loaded, with entries)
 *   "Eden/0 Holy/0"    (KB loaded, empty)
 *   "no-kb"            (no runtime)
 *
 * Always returns a styled string so callers can splice it inline.
 */
function kbBrief(session) {
  if (!session.rt) return style.warning('no-kb');
  const ks = session.rt.knowledgeBySpace || { holy: [], eden: [] };
  const eden = String(ks.eden?.length ?? 0);
  const holy = String(ks.holy?.length ?? 0);
  return `${style.dim('Eden/')}${style.muted(eden)} ${style.dim('Holy/')}${style.muted(holy)}`;
}

/**
 * Persistent bottom status bar contents.
 *
 * Format: `<phase> │ <proj>|<kb>|<model> │ ↑1.4k ↓120 0.1%/1.0M │ <elapsed>`
 *
 * Token numbers (↑↓ and the %) are aggregated across the current loop = the
 * user prompt currently being processed. They are NOT the latest single LLM
 * call's numbers — a multi-step task with N tool-call rounds shows the sum
 * across all N calls.
 */
/**
 * Plan-execution progress block - the pinned multi-line panel rendered
 * JUST ABOVE the bottom status bar. Returns an array of styled lines
 * (one per visible row), or [] when no plan is active (so the status bar
 * reserves no extra rows).
 *
 * Layout:
   Plan: <summary>   (1 line, dim - truncated by the caller)
   [x] 1. <goal>     (done)
   [>] 2. <goal>     (in progress)
   [ ] 3. <goal>     (pending)
 * The chosen strategy for the current (in_progress) step is shown on a
 * second indented line so the user can see what approach is in flight.
 */
/**
 * End-of-turn plan-progress reconciliation.
 *
 * The `plan_step` tool clears `session.planProgress` to null the moment the
 * last step is marked done. But a model can finish all the real work and emit
 * its final answer WITHOUT calling `plan_step` on the last step (or at all),
 * leaving the plan block pinned with the final step stuck `in_progress`. This
 * clears the block when every step is already `done`, so the panel never
 * lingers past actual completion. Safe to call when no plan is active.
 */
function finalizePlanProgress(session) {
  const p = session.planProgress;
  if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return;
  if (p.steps.every(st => st.status === 'done')) {
    session.planProgress = null;
  }
}

function formatPlanProgressLines(session) {
  const p = session.planProgress;
  if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return [];
  const lines = [];
  const head = p.summary
    ? `${style.accent(style.bold("Plan"))} ${style.dim(":")} ${style.muted(p.summary)}`
    : `${style.accent(style.bold("Plan"))} ${style.dim("(in progress)")}`;
  lines.push(head);
  for (let i = 0; i < p.steps.length; i++) {
    const st = p.steps[i];
    let mark, label;
    if (st.status === 'done') {
      mark = style.success(style.ICON.ok);
      label = style.dim(`${i + 1}. ${st.goal}`);
    } else if (st.status === 'in_progress') {
      mark = style.accent(">");
      label = style.accent(style.bold(`${i + 1}. ${st.goal}`));
    } else {
      mark = style.dim("[ ]");
      label = style.dim(`${i + 1}. ${st.goal}`);
    }
    lines.push(`  ${mark} ${label}`);
    if (st.status === 'in_progress' && st.strategy) {
      lines.push(`     ${style.dim(st.strategy)}`);
    }
  }
  return lines;
}

function formatStatusLine(session) {
  const projTag = session.project ? style.accent(session.project.name) : style.dim('no-project');
  const kbTag = kbBrief(session);
  const modelTag = session.modelCfg ? style.muted(modelTagFor(session)) : style.warning('no-model');
  const usage = formatUsage(session.tokens, session.modelCfg?.maxChars || 0);
  const phase = session.phase || 'idle';
  const sep = style.dim(style.BOX.vertical);
  // Animated braille spinner before the phase (the leftmost dynamic item)
  // so the user can see at a glance that work is in progress. Time-based
  // frame selection makes the animation independent of how often the bar
  // redraws; only shown while actually working (not idle / not error).
  const working = phase !== 'idle' && phase !== 'error';
  const spinner = working
    ? style.accent(style.SPINNER[Math.floor(Date.now() / 120) % style.SPINNER.length]) + ' '
    : '';
  let line = `${spinner}${style.accent(phase)} ${sep} ${projTag} ${style.dim('|')} ${kbTag} ${style.dim('|')} ${modelTag} ${sep} ${usage}`;
  if (session.turnStart > 0) {
    const secs = ((Date.now() - session.turnStart) / 1000).toFixed(1);
    line += ` ${sep} ${style.muted(secs + 's')} ${style.dim(style.ICON.dot)} ${style.italic(style.dim('esc to interrupt'))}`;
  }
  return line;
}

/**
 * Format token usage as a status bar segment:
 *   ↑1.4k ↓120 0.1%/1.0M
 *   ↑ peak single-call input in this loop (= peak context size)
 *   ↓ peak single-call output in this loop (= largest response so far)
 *   0.1%  = peak input / context window (real context-fill, can't exceed
 *           100% unless the provider actually accepted >window tokens)
 *   1.0M  = context window size from model config
 *
 * "Peak" rather than "sum" because each LLM call's input already includes
 * the full prior context — summing inputs across calls double-counts the
 * shared prefix and produces a number that has no real meaning. Peak input
 * represents the most context a single call consumed, which is what the
 * window actually constrains.
 */
function formatUsage(tokens, contextWindow) {
  const tin = tokens?.loopPeakIn ?? tokens?.callIn ?? 0;
  const tout = tokens?.loopPeakOut ?? tokens?.callOut ?? 0;
  const pct = contextWindow > 0 ? (tin / contextWindow) * 100 : 0;
  const pctStr = pct < 10 ? pct.toFixed(1) : pct.toFixed(0);
  return `${style.accent(style.ICON.up + fmtTok(tin))} ${style.success(style.ICON.down + fmtTok(tout))} ${style.muted(pctStr + '%/' + fmtTok(contextWindow))}`;
}

function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n || 0);
}

function safeParseArgs(s) {
  try { return JSON.parse(s || '{}') || {}; } catch { return {}; }
}

/**
 * Card width for tool-call cards. Tool cards always span the full terminal
 * width so their borders fill the screen edge-to-edge; bodyLine() truncates
 * any content that would overflow. (The welcome banner keeps its own 96-col
 * cap in printBanner, so this only affects bash/read/write/edit/find/etc.)
 */
function cardWidthFor(lines, title) {
  return style.termWidth();
}

/**
 * Build the header line for a tool-call card. Shows the most meaningful single
 * argument (the bash command, the read path, the find pattern, etc.) so the
 * user can see at a glance what the call actually does — matches the
 * per-tool renderers used by the styled output.
 *
 * `full` (resume preview) disables the 110-char argument preview: live tool
 * cards keep it because their bordered rows are width-constrained by
 * bodyLine(), while the resume preview prints unbounded full lines.
 */
function toolHeader(name, args, token, { full = false } = {}) {
  const preview = (s) => (full ? (s || '')
    : (s && s.length > 110 ? s.slice(0, 110) + '…' : (s || '')));
  switch (name) {
    case 'bash':
      return `${style.success('$')} ${style.muted(preview(args.command))}`;
    case 'read':
      return `${style.cardHeader('read', token)} ${style.muted(preview(args.path))}`;
    case 'write':
      return `${style.cardHeader('write', token)} ${style.muted(preview(args.path))} ${style.dim('(' + (args.content?.length || 0) + ' bytes)')}`;
    case 'edit':
      return `${style.cardHeader('edit', token)} ${style.muted(preview(args.path))}`;
    case 'find':
      return `${style.cardHeader('find', token)} ${style.muted(preview(args.pattern))}`;
    case 'grep':
      return `${style.cardHeader('grep', token)} ${style.muted(preview(args.pattern))}`;
    case 'kb_search':
      return `${style.cardHeader('kb_search', token)} ${style.muted(preview(args.query))}`;
    case 'kb_symbol':
      return `${style.cardHeader('kb_symbol', token)} ${style.muted(preview(args.name))}`;
    case 'kb_neighbors':
    case 'kb_callchain':
    case 'kb_refs':
      return `${style.cardHeader(name, token)} ${style.muted(preview(args.symbol_id))}`;
    case 'kb_class':
      return `${style.cardHeader('kb_class', token)} ${style.muted(preview(args.name || args.qual_name))}`;
    case 'kb_knowledge':
    case 'kb_search_knowledge':
      return `${style.cardHeader(name, token)} ${style.muted(preview(args.id || args.query))}`;
    default:
      return `${style.cardHeader(name, token)}`;
  }
}

function printBanner(session, ctx) {
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

function makeCompleter() {
  const cmds = ['/model', '/project', '/kb', '/session', '/review', '/help', '/quit', '/exit', '/clear', '/compact', '/theme',
    '/model list', '/model add', '/model use', '/model set-default', '/model set', '/model set-phase', '/model add-mcpserver', '/model types', '/model del', '/model show', '/model help',
    '/project init', '/project list', '/project set', '/project show',
    '/kb init', '/kb update', '/kb status', '/kb search', '/kb symbol', '/kb neighbors', '/kb knowledge', '/kb help',
    '/kb knowledge list', '/kb knowledge show', '/kb knowledge add', '/kb knowledge learn', '/kb knowledge help',
    '/session info', '/session list', '/session new', '/session resume',
    '/theme list', '/theme set', '/theme reset', '/theme preview', '/theme title-follow', '/theme help',
    '/review code', '/review plan'];
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
 * Detect whether a trimmed user line is a short continuation cue
 * ("continue" / "请继续" / "go ahead" / ...) rather than a fresh task.
 *
 * Used by handleLine to decide whether to keep the live planProgress block
 * (a continuation preserves the in-flight plan; a fresh prompt clears it)
 * and by runAgentTurn to inject interruption-recovery context. Supports both
 * English and Chinese cues - without the Chinese branch, a 中文 "请继续" after
 * an interrupted task used to be misclassified as a new task, wiping the live
 * planProgress and leaving the progress panel empty.
 */
export function isContinuationCue(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  const contRe = /^(y|yes|ok|okay|continue|cont|go|next|done|keep going|proceed|go on|go ahead|please continue)\b/i;
  // Chinese cues: \b does NOT match at CJK character boundaries (\w is ASCII
  // only), so we omit the trailing \b here. The alternation anchors at ^ so a
  // cue followed by more Chinese text ("继续，把剩下的做完") still matches.
  const contZhRe = /^(请继续|继续吧|继续做|继续|接着做|接着来|接着|往下做|往下|进行)/i;
  return contRe.test(t) || contZhRe.test(t);
}

/**
 * Mid-task input capture: called from enqueue() for every line arriving while
 * an agent turn is running. Returns true when the line was captured as an
 * in-task instruction (pushed onto session.userInputQueue, to be delivered at
 * the next round boundary) and must NOT enter the normal session.queue.
 *
 * NOT captured (returns false): slash commands (they may reload model / KB /
 * project state the in-flight turn depends on — they keep the legacy
 * post-turn behavior) and blank lines (let the normal path drop them).
 * Exported for unit testing the capture rule without a live REPL.
 */
export function captureMidTaskInput(session, line) {
  if (!session || !session.agentTurnActive) return false;
  if (!line || typeof line !== 'string') return false;
  if (!line.trim()) return false;
  if (line.trim().startsWith('/')) return false;
  if (!Array.isArray(session.userInputQueue)) session.userInputQueue = [];
  session.userInputQueue.push(line);
  return true;
}

/**
 * Batch the queued mid-task instructions into ONE user message, tagged so the
 * model knows these arrived while it was working and should be folded into
 * the in-flight task rather than treated as a brand-new task. Returns null
 * when there is nothing to inject. Exported for unit testing.
 */
export function buildMidTaskInjection(lines) {
  const items = (lines || []).map(l => String(l).trim()).filter(Boolean);
  if (items.length === 0) return null;
  const body = items.map(l => `- ${l}`).join('\n');
  return '## Additional user instruction (queued while the task was running)\n' +
    `${body}\n\n` +
    'These arrived from the user while you were executing the current task. ' +
    'Fold them into the work in progress — finish or adjust the current task ' +
    'accordingly; do not restart from scratch unless the user explicitly asks.';
}

/**
 * Disarm mid-task capture and hand any undelivered instructions back to the
 * normal queue. Safe to call multiple times (idempotent disarm). Used BOTH by
 * runAgentTurn's finally AND by its early-cancel paths that return before the
 * try block begins (clarification cancel) — every exit from a turn that armed
 * `agentTurnActive` must disarm it, or enqueue() would keep capturing (and
 * silently swallowing) all subsequent plain input. Exported for unit testing.
 */
export function disarmMidTaskCapture(session) {
  if (!session) return [];
  session.agentTurnActive = false;
  return flushMidTaskQueue(session);
}

/**
 * Move any still-queued mid-task instructions back onto the normal input
 * queue. Called from runAgentTurn's finally when the turn ended before a
 * round boundary could deliver them (e.g. the model's final reply carried no
 * tool calls, so the last boundary never fired). The leftovers are unshifted
 * to the FRONT of session.queue — the user's instructions to the agent take
 * priority over housekeeping slash commands typed during the same turn — and
 * are then handled as fresh user turns right after this task. Returns the
 * transferred lines (empty array when nothing was pending).
 */
export function flushMidTaskQueue(session) {
  if (!session || !Array.isArray(session.userInputQueue) || session.userInputQueue.length === 0) return [];
  const leftover = session.userInputQueue.splice(0);
  if (leftover.length > 0 && Array.isArray(session.queue)) session.queue.unshift(...leftover);
  return leftover;
}

/**
 * Build the system-message text injected when the user asks to continue an
 * interrupted task. Combines the last user request (from session.lastTask)
 * with a text snapshot of the live planProgress (so the model knows which
 * step is in_progress and what's next). Returns null when there is no
 * lastTask to resume from.
 *
 * Exported so the resume-injection logic is unit-testable without spinning
 * up the full agent loop (which needs an LLM, KB, and readline).
 */
export function buildResumeContext(session) {
  if (!session || !session.lastTask) return null;
  const planLines = formatPlanProgressLines(session);
  const planText = planLines.length > 0
    ? '\n\nCurrent plan progress:\n' + planLines.join('\n')
    : '\n\n(No structured plan was active when the task was interrupted; the plan may have been proposed but not yet confirmed, or the interruption happened before the plan tool fired.)';
  return `## Resuming an interrupted task
You are resuming a task that was interrupted before it finished. The user just asked you to continue. Here is the context you need to pick up where you left off:

Original user request:
${session.lastTask.userRequest || '(unavailable)'}${planText}

Do NOT restart from scratch or re-confirm the plan. Continue the in-flight work: complete the current step, then proceed to the next. If the plan is already fully done, summarize what was accomplished and stop.`;
}

/**
 * One-line squeeze for session digests: collapse all whitespace (including
 * newlines) and cap the length so a single long turn cannot blow up the
 * assessment prompt.
 */
function digestLine(text, max = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Plain-text (ANSI-free) rendering of the active plan progress for LLM
 * consumption. formatPlanProgressLines() is for the terminal; the assessor
 * gets this instead.
 */
function plainPlanLines(session) {
  const p = session.planProgress;
  if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return [];
  const lines = [];
  if (p.summary) lines.push(`  Plan: ${digestLine(p.summary)}`);
  for (let i = 0; i < p.steps.length; i++) {
    const st = p.steps[i] || {};
    const mark = st.status === 'done' ? '[done]' : st.status === 'in_progress' ? '[in progress]' : '[pending]';
    lines.push(`  ${i + 1}. ${mark} ${digestLine(st.goal)}`);
  }
  return lines;
}

/**
 * Build a compact digest of the current session's TASK context for the
 * request-clarity assessor: the in-flight task request (when it differs from
 * the current request), the active plan progress, and the most recent
 * conversation turns. Returns '' when the session carries no task context
 * (e.g. the very first turn), in which case the assessor runs without it.
 *
 * This lets follow-ups that are ambiguous in isolation ("continue", "fix it",
 * "same for the parser") be judged CLEAR when the conversation already pins
 * down what they refer to, instead of triggering a pointless clarification
 * menu. Exported for unit testing.
 */
export function buildSessionDigest(session, currentRequest) {
  if (!session) return '';
  const lines = [];

  // 1) In-flight task. On a fresh (non-continuation) turn runAgentTurn has
  // just set lastTask.userRequest = currentRequest, which carries no extra
  // information — skip it then. On a continuation it holds the ORIGINAL task
  // request, which is exactly what the assessor needs.
  const taskReq = session.lastTask && session.lastTask.userRequest;
  const taskLine = digestLine(taskReq);
  const curLine = digestLine(currentRequest);
  if (taskLine && curLine && taskLine !== curLine) {
    lines.push(`In-flight task (earlier request this session is working on): ${taskLine}`);
  }

  // 2) Active plan progress (if a confirmed plan is in flight).
  const plan = plainPlanLines(session);
  if (plan.length > 0) {
    lines.push('Active plan progress:');
    lines.push(...plan);
  }

  // 3) Recent conversation turns. At assessment time the current request has
  // NOT been pushed yet, so this is strictly PRIOR conversation. Only string
  // contents are usable (assistant tool-call turns may carry structured
  // content); system messages (e.g. the resume injection) are excluded.
  const turns = (session.messages || [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map(m => {
      const who = m.role === 'user' ? 'User' : 'Assistant';
      return `  ${who}: ${digestLine(m.content)}`;
    });
  if (turns.length > 0) {
    lines.push('Recent conversation (oldest first, before this request):');
    lines.push(...turns);
  }

  return lines.join('\n');
}

async function handleLine(line, session, ctx) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const handled = await dispatchSlash(line, ctx);
  if (handled) {
    // Reset status-bar state so the elapsed timer stops ticking and the phase
    // returns to idle. Slash commands use ctx.setPhase() during execution
    // (which sets turnStart); without this reset the bar keeps counting after
    // the command finishes. runAgentTurn does the same reset on its own exit
    // path; slash commands bypass that path.
    session.phase = 'idle';
    session.turnStart = 0;
    session.statusBar?.update();
    return;
  }

  if (!session.llm) {
    ctx.print(`No default model configured. Use /model add + /model set-default before chatting.`);
    return;
  }
  if (!session.rt) {
    ctx.print(`KB not loaded. Run /kb init or /project set current <project-with-KB>.`);
    return;
  }

  // Plan-progress lifecycle: a fresh prompt that is not a short
  // continuation (yes/ok/continue/go/next/done/请继续/继续/接着) starts a new
  // task, so any stale plan block from a previous task is cleared. Multi-turn
  // continuation of an in-progress plan keeps the block.
  const isContinuation = isContinuationCue(trimmed);
  if (session.planProgress && !isContinuation) {
    session.planProgress = null;
    session.statusBar?.update();
  }
  await runAgentTurn(trimmed, session, ctx, { continuation: isContinuation });
}

/**
 * Interactive plan confirmation - the interface that receives the LLM plan
 * decision. The agent calls the `plan` tool (registered in buildTools with a
 * `planConfirm` callback) when IT decides a task is complex enough to need a
 * user-confirmed plan; that callback invokes this function.
 *
 * Given a plan (from the `plan` tool args) - an ordered list of steps, each
 * with multiple candidate strategies - prompt the user once per step to choose
 * a strategy. Each prompt is a numbered menu:
 *
 *   1. <name> (recommend)         <- recommended strategy first
 *      <description>
 *   2. <name>
 *      <description>
 *   3. <name>
 *      <description>
 *   4. something else             <- free text the user types
 *
 * The recommended strategy is always listed as option 1 (and marked). Options
 * are 1-indexed; the last option is "something else" and captures the next line
 * the user types as free-form guidance.
 *
 * Returns null if the user cancels (Ctrl+D / rl close) or the plan has no
 * usable steps; otherwise a finalized plan string suitable to inject into the
 * transcript, e.g.:
 *   "Summary: ..."
 *   "Step 1: <goal> -> <chosen strategy / free text>"
 *   "Step 2: ..."
 */
async function confirmPlan(plan, session) {
  if (!plan || !plan.steps || plan.steps.length === 0) return null;
  const choices = [];
  for (let s = 0; s < plan.steps.length; s++) {
    const step = plan.steps[s];
    // Recommended strategy first, then the rest, preserving model order.
    const ordered = [...step.strategies].sort((a, b) =>
      (a.recommended === b.recommended) ? 0 : a.recommended ? -1 : 1);
    const lines = [];
    lines.push('');
    lines.push(style.accent(style.bold(`Plan - Step ${s + 1}/${plan.steps.length}: ${step.goal}`)));
    const nStrats = ordered.length;
    for (let i = 0; i < nStrats; i++) {
      const strat = ordered[i];
      const tag = strat.recommended ? ` ${style.warning('(recommend)')}` : '';
      lines.push(`  ${style.bold(String(i + 1))}. ${strat.name}${tag}`);
      if (strat.description) lines.push(`     ${style.dim(strat.description)}`);
    }
    lines.push(`  ${style.bold(String(nStrats + 1))}. ${style.dim('something else (type your own approach)')}`);
    for (const ln of lines) process.stderr.write(ln + '\n');

    const choice = await promptChoice(session, nStrats + 1);
    if (choice.cancelled) return null;
    if (choice.index === nStrats) {
      // "something else": the next line is the free-form approach.
      const free = await promptLine(session, style.accent('  Your approach: '));
      if (free.cancelled) return null;
      choices.push({ goal: step.goal, text: free.text || '(no approach given)' });
    } else {
      const strat = ordered[choice.index];
      choices.push({ goal: step.goal, text: `${strat.name}${strat.description ? ' - ' + strat.description : ''}` });
    }
  }
  const parts = [];
  if (plan.summary) parts.push(`Summary: ${plan.summary}`);
  choices.forEach((c, i) => parts.push(`Step ${i + 1}: ${c.goal} -> ${c.text}`));
  // Persist the structured plan so the status bar can render live progress.
  // The first step is marked in_progress and the rest pending; the agent
  // advances them via the `plan_step` tool (planStep callback below).
  session.planProgress = {
    summary: plan.summary || "",
    steps: choices.map((c, i) => ({
      goal: c.goal,
      strategy: c.text,
      status: i === 0 ? 'in_progress' : 'pending',
    })),
    current: 0,
  };
  session.statusBar?.update();
  return parts.join('\n');
}

/**
 * Surface Plan Review issues to the user one-by-one for confirmation.
 *
 * issues = [{ title, detail, suggestion }] from reviewPlan(). For each issue
 * we print the title + detail + the reviewer's suggestion, then a numbered
 * menu: (1) accept the suggestion, (2) dismiss this issue, (3) type your own
 * resolution. The chosen resolution text is recorded for accepted/typed ones;
 * dismissed issues contribute nothing. Returns an array of
 * { title, resolution } for the accepted/typed resolutions (empty when the
 * user dismissed everything), or null if the user cancelled (Ctrl+D / rl
 * close) - a null return propagates as a plan cancellation upstream.
 */
async function confirmPlanReview(issues, session) {
  if (!issues || issues.length === 0) return [];
  const resolutions = [];
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const lines = [];
    lines.push('');
    lines.push(style.accent(style.bold(`Plan Review - Issue ${i + 1}/${issues.length}: ${issue.title}`)));
    if (issue.detail) lines.push(style.dim(`  ${issue.detail}`));
    if (issue.suggestion) {
      lines.push(`  ${style.bold('1')}. ${style.warning('(accept suggestion)')} ${issue.suggestion}`);
    } else {
      // No suggestion from the reviewer: only dismiss / type your own.
      lines.push(`  ${style.bold('1')}. ${style.dim('(no suggestion from reviewer)')}`);
    }
    lines.push(`  ${style.bold('2')}. ${style.dim('dismiss this issue')}`);
    lines.push(`  ${style.bold('3')}. ${style.dim('type your own resolution')}`);
    for (const ln of lines) process.stderr.write(ln + '\n');

    const choice = await promptChoice(session, 3);
    if (choice.cancelled) return null;
    if (choice.index === 0) {
      // Accept the reviewer's suggestion (if any). A missing suggestion is
      // treated as a dismissal so we never record an empty resolution.
      if (issue.suggestion) {
        resolutions.push({ title: issue.title, resolution: issue.suggestion });
      }
    } else if (choice.index === 2) {
      // "type your own": the next line is the free-form resolution.
      const free = await promptLine(session, style.accent('  Your resolution: '));
      if (free.cancelled) return null;
      const text = (free.text || '').trim();
      if (text) resolutions.push({ title: issue.title, resolution: text });
    }
    // choice.index === 1 -> dismiss: contributes nothing.
  }
  return resolutions;
}

/**
 * Prompt for a single integer choice in [1..max]. Returns {index, cancelled}.
 * Mirrors ctx.confirm's consumeNext + close handling. Re-prompts on bad input.
 */
function promptChoice(session, max) {
  return new Promise((resolve) => {
    if (!session.rl) { resolve({ index: -1, cancelled: true }); return; }
    const onClose = () => resolve({ index: -1, cancelled: true });
    session.rl.once('close', onClose);
    const done = (val) => { session.rl.off('close', onClose); resolve(val); };
    const ask = () => {
      process.stderr.write(style.accent(`  Choose [1-${max}]: `));
      session.consumeNext = (ans) => {
        const v = (ans || '').trim();
        const n = parseInt(v, 10);
        if (/^\d+$/.test(v) && n >= 1 && n <= max) { done({ index: n - 1, cancelled: false }); return; }
        process.stderr.write(`  Please enter a number 1-${max}. `);
        ask();
      };
    };
    ask();
  });
}

/**
 * Prompt for a single free-text line. Returns {text, cancelled}.
 */
function promptLine(session, promptText) {
  return new Promise((resolve) => {
    if (!session.rl) { resolve({ text: '', cancelled: true }); return; }
    const onClose = () => resolve({ text: '', cancelled: true });
    session.rl.once('close', onClose);
    const done = (val) => { session.rl.off('close', onClose); resolve(val); };
    process.stderr.write(promptText);
    session.consumeNext = (ans) => done({ text: (ans || '').trim(), cancelled: false });
  });
}

/**
 * Surface an unclear-request assessment to the user for confirmation.
 *
 * assessment = { clear: false, unclear: string[], interpretations: string[] }
 * Renders the unclear aspects, then a numbered menu of the candidate
 * interpretations followed by a 'something else' free-text option (exactly
 * the shape the user requested). Returns the chosen interpretation text
 * (a candidate string or the user's typed text), or null if the user
 * cancelled (Ctrl+D / rl close).
 */
async function confirmClarification(assessment, session) {
  if (!assessment || assessment.clear) return null;
  const lines = [];
  lines.push('');
  lines.push(style.accent(style.bold('Your request is not fully clear. Could you confirm what you mean?')));
  if (assessment.unclear && assessment.unclear.length) {
    lines.push(style.dim('  Unclear aspects:'));
    for (const u of assessment.unclear) lines.push(style.dim(`    - ${u}`));
  }
  const n = assessment.interpretations.length;
  for (let i = 0; i < n; i++) {
    const tag = i === 0 ? ` ${style.warning('(recommend)')}` : '';
    lines.push(`  ${style.bold(String(i + 1))}. ${assessment.interpretations[i]}${tag}`);
  }
  lines.push(`  ${style.bold(String(n + 1))}. ${style.dim('something else (type what you mean)')}`);
  for (const ln of lines) process.stderr.write(ln + '\n');

  const choice = await promptChoice(session, n + 1);
  if (choice.cancelled) return null;
  if (choice.index === n) {
    const free = await promptLine(session, style.accent('  Your request: '));
    if (free.cancelled) return null;
    return free.text || null;
  }
  return assessment.interpretations[choice.index];
}

/**
 * Set session.phase + refresh the status bar, swallowing errors so callers can
 * use it in best-effort finally blocks (e.g. the Code Review teardown).
 */
function setPhaseSafe(session, phase) {
  try {
    session.phase = phase;
    session.statusBar?.update();
  } catch { /* ignore */ }
}

/**
 * Run an external command and resolve with { ok, out }. Never rejects - a
 * non-zero exit or spawn failure resolves with ok:false so callers can degrade
 * gracefully (used by Code Review to collect a working-tree diff).
 */
function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').toString() });
    });
  });
}

/**
 * Collect the working-tree result of a plan execution for Code Review: the
 * tracked diff (staged + unstaged vs HEAD) plus the contents of untracked text
 * files (new files the assistant wrote, which `git diff HEAD` does not cover),
 * and a list of changed files. Best-effort - returns empty fields when git is
 * unavailable or the project path isn't a git repo.
 */
export async function collectWorkingTreeDiff(sourcePath) {
  const empty = { diffText: '', changedFiles: [] };
  if (!sourcePath) return empty;
  try {
    // NOTE: `-C <path>` is a GLOBAL git option and MUST come BEFORE the
    // subcommand. `git status --porcelain -C <path>` fails with
    // "unknown switch `C'" (exit 129), which silently emptied changedFiles
    // and skipped untracked-file collection entirely.
    const [diffRes, statusRes, untrackedRes] = await Promise.all([
      execFileAsync('git', ['-C', sourcePath, 'diff', 'HEAD', '--unified=3']),
      execFileAsync('git', ['-C', sourcePath, 'status', '--porcelain']),
      execFileAsync('git', ['-C', sourcePath, 'ls-files', '--others', '--exclude-standard']),
    ]);
    if (!diffRes.ok && !statusRes.ok) return empty;

    // Porcelain lines are "XY <path>" (2 status cols + 1 space). Renames are
    // "R  old -> new": keep the destination. Paths with special chars are
    // C-quoted by git: strip the surrounding quotes.
    const changedFiles = statusRes.ok
      ? statusRes.out.split('\n').map((l) => {
          let f = l.slice(3).trim();
          if (f.startsWith('"') && f.endsWith('"')) f = f.slice(1, -1);
          const arrow = f.indexOf(' -> ');
          if (arrow >= 0) f = f.slice(arrow + 4);
          return f;
        }).filter((f) => f.trim())
      : [];

    let diffText = diffRes.ok ? diffRes.out : '';

    // Include new (untracked) files, which `git diff HEAD` does not cover.
    if (untrackedRes.ok && untrackedRes.out.trim()) {
      const newFiles = untrackedRes.out.split('\n').map((f) => f.trim()).filter(Boolean);
      for (const f of newFiles.slice(0, 50)) {
        try {
          const abs = path.join(sourcePath, f);
          const stat = await fs.stat(abs);
          if (!stat.isFile()) continue;
          // Cap each new file's body so a single huge generated file can't blow
          // up the review prompt (buildCodeReviewContent truncates again later).
          const content = (await fs.readFile(abs, 'utf8')).slice(0, 16000);
          const lines = content.split('\n');
          if (lines[lines.length - 1] === '') lines.pop(); // trailing newline
          diffText += `\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n` + content;
        } catch { /* skip unreadable / binary files */ }
      }
    }

    return { diffText, changedFiles };
  } catch {
    return empty;
  }
}

/**
 * End-of-turn Code Review (HK2_ENABLE_CODEREVIEW, default 0). Runs after the
 * agent finishes executing a plan and the plan block has been finalized. It
 * collects the working-tree result (diff + changed files) and the final answer,
 * reviews them with a configurable phase model
 * (`/model set-phase --phase=code-review`), and prints any issues one-by-one.
 * Best-effort: any failure is reported and the turn ends normally.
 */
async function runCodeReview(session, ctx, { planText, assistantText, resolvePhaseLlm, signal, progress }) {
  if (!session.llm) return;

  // Resolve a per-phase model override for the code-review phase; fall back to
  // the session model when unset or unresolvable (matching plan-review).
  let reviewLlm = session.llm;
  let usingPhaseModel = false;
  try {
    const phaseLlm = await resolvePhaseLlm('code-review');
    if (phaseLlm) { reviewLlm = phaseLlm; usingPhaseModel = true; }
  } catch (err) {
    ctx.print(`[warn] could not resolve phase model for code-review, using session model: ${err.message}`);
  }

  const reviewModelLabel = usingPhaseModel
    ? (getPhaseModelRef(session.project, 'code-review') || 'code-review phase model')
    : 'session model';

  // Explicitly show that a Code Review is running AND what it is reviewing.
  ctx.print('');
  ctx.print(style.accent(style.bold('Code Review')));
  ctx.print(style.dim(`  Reviewing the completed plan result with ${reviewModelLabel}...`));
  ctx.print(style.dim('  Checks: correctness, completeness, quality, and consistency of the changes.'));

  // Collect the result of the execution: the working-tree diff + changed files.
  const { diffText, changedFiles } = await collectWorkingTreeDiff(session.project?.sourcePath);
  ctx.print(style.dim(
    changedFiles.length > 0
      ? `  Files changed (${changedFiles.length}): ${changedFiles.slice(0, 12).join(', ')}${changedFiles.length > 12 ? '...' : ''}`
      : '  Files changed: (none detected - reviewing the plan and final answer only)'
  ));

  // Show a live "review in progress" indicator while the LLM review runs.
  // progress.done() has already run for the agent loop, so restart the spinner
  // for this phase and pause it before printing the result (mirroring the
  // plan-review UX). In non-TTY mode ProgressIndicator prints a one-line phase
  // header instead, which keeps the wait visible in piped runs too.
  let started = false;
  try {
    progress.nextPhase('reviewing code');
    started = true;
    setPhaseSafe(session, 'reviewing code');
  } catch { /* progress already finalized - status bar still shows the phase */ }

  try {
    const reviewText = buildCodeReviewContent({
      planText: planText || '',
      changedFiles,
      diffText,
      answerText: assistantText || '',
    });
    // Stream the reviewer's analysis live, mirroring the agent loop's own
    // streaming UX: progress.tick() clears the spinner on the first delta,
    // MarkdownStream styles headings/lists/code as they arrive. The verdict
    // filter hides the machine-readable JSON that follows the === VERDICT ===
    // marker so the user never sees raw JSON scrolling by. The reviewer's
    // THINKING stream renders live too (ReasoningStream + progress.reason(),
    // mirroring the main agent loop): reasoning deltas arrive before any body
    // text, so without this the whole deep-reasoning window is a silent
    // spinner.
    const mdStream = new MarkdownStream();
    const reasoningStream = new ReasoningStream();
    // Write any partial line the renderer is still holding so subsequent
    // prints (warnings, verdict) always start on a fresh line.
    const flushNow = () => {
      const tail = reasoningStream.end() + mdStream.flush();
      if (tail) process.stdout.write(tail);
    };
    const onReasoning = (text) => {
      progress.reason();
      if (reasoningStream.headerShown) progress.pause();
      const rendered = reasoningStream.feed(text);
      if (rendered) process.stdout.write(rendered);
    };
    const onDelta = createVerdictFilter((text) => {
      progress.tick(text);
      const rendered = mdStream.feed(text);
      if (rendered) process.stdout.write(rendered);
    });
    // Review phases use the "skip on unreachable" policy — NEVER a session-
    // model fallback (see runPhaseWithSkipOnUnreachable): substituting an
    // unplanned model would change what reviewed the code. Warnings are
    // printed by the policy; skip -> no "no issues found" message, the turn
    // simply ends without a review.
    const reviewRun = await runPhaseWithSkipOnUnreachable({
      phase: 'code-review',
      phaseLlm: usingPhaseModel ? reviewLlm : null,
      sessionLlm: session.llm,
      warn: (m) => { flushNow(); progress.breakLine(); ctx.print(m); },
      run: (llmForReview) => reviewCode(llmForReview, reviewText, { signal, onDelta, onReasoning }),
    });
    // Flush the stream renderer's trailing partial line before the verdict.
    flushNow();
    await session.transcript?.logMeta('codeReview', {
      skipped: reviewRun.skipped,
      ...(reviewRun.skipped ? { error: reviewRun.error } : {}),
      ok: reviewRun.result ? reviewRun.result.ok : null,
      issueCount: reviewRun.result && reviewRun.result.issues ? reviewRun.result.issues.length : 0,
      ...(reviewRun.result && reviewRun.result.parseError ? { parseError: reviewRun.result.parseError } : {}),
      changedFileCount: changedFiles.length,
      phaseModelRef: usingPhaseModel && !reviewRun.skipped ? (getPhaseModelRef(session.project, 'code-review') || null) : null,
    });

    if (reviewRun.skipped) {
      // Model unreachable: warnings already printed; end without a review.
    } else if (reviewRun.result.parseError) {
      // The reply had no parseable JSON verdict: UNKNOWN outcome, never
      // "no issues found". Whatever the reviewer said already streamed above.
      ctx.print(style.warning(`  [warn] ${reviewRun.result.parseError} - the review outcome is UNKNOWN.`));
    } else if (reviewRun.result.ok || !reviewRun.result.issues || reviewRun.result.issues.length === 0) {
      ctx.print(style.dim('  Code review complete - no issues found.'));
    } else {
      ctx.print(style.warning(`  Code review found ${reviewRun.result.issues.length} issue(s):`));
      reviewRun.result.issues.forEach((issue, i) => {
        ctx.print('');
        ctx.print(style.warning(style.bold(`  Issue ${i + 1}: ${issue.title}`)));
        if (issue.detail) ctx.print(style.dim(`    ${issue.detail}`));
        if (issue.suggestion) ctx.print(`    ${style.bold('Suggestion:')} ${issue.suggestion}`);
      });
    }
  } catch (err) {
    ctx.print(`[warn] code review failed: ${err.message}`);
  } finally {
    if (started) {
      try { progress.pause(); } catch { /* ignore */ }
    }
    setPhaseSafe(session, 'idle');
  }
}

async function runAgentTurn(userText, session, ctx, opts = {}) {
  const progress = new ProgressIndicator();
  session.turnStart = Date.now();
  // Track whether a plan was already active when this turn started, so the
  // end-of-turn Code Review can run on the turn that COMPLETES a multi-turn
  // plan (not only the turn that first confirmed the plan via the plan tool).
  const planActiveAtStart = !!session.planProgress;
  session.hadPlanThisTurn = false;
  // Per-turn Holy-over-Eden conflict list: reset at the TOP of the turn (before
  // pass-1 graph retrieval populates it), consumed at end of turn by
  // syncConflictingEden(). It MUST NOT be reset after pass-1/pass-2 retrieval
  // — that would wipe the conflicts detected this turn and the end-of-turn
  // Eden sync would silently become a no-op.
  session.kbConflicts = [];
  // Mid-task input: arm the capture flag for the whole turn (enqueue() routes
  // non-slash input to session.userInputQueue while this is true) and make
  // sure no stale queue survives from an earlier aborted turn.
  session.agentTurnActive = true;
  session.userInputQueue = [];

  // ---- Auto context compaction (safe turn boundary) ------------------------
  // Runs before any rewrite/retrieval/agent work so it never interrupts an
  // in-flight action. Uses the context size snapshotted at the previous turn's
  // end (session.lastContextTokens), falling back to a chars→tokens estimate.
  await maybeAutoCompact(session, ctx);

  const setPhase = (p) => {
    session.phase = p;
    session.statusBar?.update();
  };

  // ESC-to-interrupt: while a turn is running, pressing ESC aborts the
  // in-flight LLM stream (runLoop checks the signal at the top of each turn
  // and inside the stream loop, and forwards it to the provider fetch). Only
  // wired in TTY mode, where readline keypress events are available.
  const abortCtrl = new AbortController();
  const onKeypress = (_str, key) => {
    if (key && key.name === 'escape' && !abortCtrl.signal.aborted) {
      abortCtrl.abort(new Error('interrupted by user (ESC)'));
    }
  };
  const rlInput = session.rl?.input;
  const canInterrupt = !!(rlInput && session.rl?.terminal);
  if (canInterrupt) {
    readline.emitKeypressEvents(rlInput);  // idempotent; readline already set this up
    rlInput.on('keypress', onKeypress);
  }

  // ---- Interruption recovery: task context ----
  // When a task is interrupted (LLM error / ESC / crash) and the user types a
  // continuation cue ("请继续 / continue / go ahead"), the LLM has lost all
  // memory of what it was doing. session.lastTask carries the most recent
  // user request + a text snapshot of the live plan progress; inject it as a
  // system message so the model can resume instead of flailing on a bare
  // "continue". For a fresh (non-continuation) task, refresh lastTask now so a
  // *later* interruption can be recovered the same way.
  if (opts.continuation && session.lastTask) {
    const resumeMsg = buildResumeContext(session);
    if (resumeMsg) session.messages.push({ role: 'system', content: resumeMsg });
  } else {
    // Fresh task: snapshot the request + current plan progress so a future
    // interruption can be recovered. The planProgress text is re-derived lazily
    // on recovery (it may have advanced since), but capturing the request now
    // is essential because the interruption may happen before the plan tool
    // ever fires.
    session.lastTask = {
      userRequest: userText,
      capturedAt: new Date().toISOString(),
    };
  }

  // Phase ordering: the LLM query rewrite (when enabled) runs before KB
  // retrieval, because the rewritten query feeds BM25. The spinner therefore
  // starts on 'rewriting query' (or 'retrieving KB' when rewrite is off), and
  // only transitions to 'retrieving KB' right before buildRequestGraph performs
  // the actual retrieval. Announcing 'retrieving KB' before the rewrite would
  // mislabel the work and imply retrieval runs on the un-rewritten query.
  //
  // Request-clarity assessment (when enabled) runs AFTER the first
  // rewrite+retrieve pass, so the LLM can judge clarity against the retrieved
  // project context (matching symbols/knowledge) instead of the raw request
  // alone. If the request is unclear, the user's confirmation is fed back into
  // a context-aware second rewrite, after which retrieval is re-run. See Eden
  // KB entry `request-assessment-clarification-phase`.
  const enableRewrite = envFlag('HK2_ENABLE_QUERYREWRITE', 1);
  // Request-clarity assessment (HK2_ENABLE_REQUEST_ASSESS, default 1).
  // Active only in interactive TTY mode (a confirmation menu needs a real
  // prompt). Non-interactive callers (explain/search/serve) never run it.
  const enableAssess = enableRewrite && envFlag('HK2_ENABLE_REQUEST_ASSESS', 1);
  const canAssess = enableAssess && session.llm && !!(session.rl && session.rl.terminal);
  let rewrite = null;
  // Outcome of the rewrite phase under the HK2_ENABLE_PHASEMODEL_FALLBACK
  // policy: filled in by pass-1 and REUSED by the post-clarification pass-2
  // rewrite, so the same phase never probes a dead endpoint twice per turn
  // (and never repeats its warnings).
  let rewritePhaseRun = null;

  // Resolve a per-phase model override for the rewrite phase. When the current
  // project has configured /model set-phase --phase=rewrite-query <ref>, the
  // rewrite runs on that model instead of the session model; otherwise we use
  // session.llm (the default, unchanged behavior). The phase model is resolved
  // once per turn and reused for both the pass-1 rewrite and the post-
  // clarification pass-2 rewrite, so the two passes stay consistent.
  // resolvePhaseLlm returns null when no override is configured or the
  // override can't be resolved (in which case we fall back to session.llm and
  // warn, rather than silently running on the wrong model).
  const resolvePhaseLlm = async (phase) => {
    const ref = getPhaseModelRef(session.project, phase);
    if (!ref) return null;
    const cfg = await resolveModelRef(ref);
    if (!cfg) return null;
    return new LLMClient(cfg);
  };
  let rewriteLlm = null;
  if (enableRewrite && session.llm) {
    try {
      rewriteLlm = await resolvePhaseLlm('rewrite-query');
    } catch (err) {
      ctx.print(`[warn] could not resolve phase model for rewrite, using session model: ${err.message}`);
      rewriteLlm = null;
    }
  }

  // Same mechanism for the request-clarity assessment phase ('assessing
  // request'): /model set-phase --phase=request-assess <ref> runs the assessor
  // on that model instead of the session model. Resolved once per turn;
  // resolve failure falls back to session.llm with a warning (never silently
  // run on the wrong model).
  let assessLlm = null;
  if (canAssess) {
    try {
      assessLlm = await resolvePhaseLlm('request-assess');
    } catch (err) {
      ctx.print(`[warn] could not resolve phase model for request assessment, using session model: ${err.message}`);
      assessLlm = null;
    }
  }

  // Start the spinner on the FIRST piece of real work: the rewrite (when
  // enabled), else KB retrieval. Assessment runs later, after retrieval.
  if (enableRewrite && session.llm) {
    progress.start('rewriting query');
    setPhase('rewriting query');
  } else {
    progress.start('retrieving KB');
    setPhase('retrieving KB');
  }

  // --- Pass 1: rewrite (raw user text, no clarification yet) ---------------
  if (enableRewrite && session.llm) {
    if (progress.phase !== 'rewriting query') {
      progress.nextPhase('rewriting query');
      setPhase('rewriting query');
    }
    try {
      const { rewriteQuery } = await import('../../lib/retrieval/rewrite_query.js');
      // HK2_ENABLE_PHASEMODEL_FALLBACK policy (default 1): when a configured
      // phase model is UNREACHABLE (connection refused / timeout / HTTP
      // error), warn and re-run the phase on the session (main) model (=1),
      // or skip the phase entirely (=0). Previously the transport error was
      // swallowed inside rewriteQuery, so a dead phase model looked like a
      // successful fallback rewrite with no warning at all. Each phase
      // evaluates its OWN model — the rewrite-query override and the
      // request-assess override may point at different providers.
      const rewriteRun = await runPhaseWithFallback({
        phase: 'rewrite-query',
        phaseLlm: rewriteLlm,
        sessionLlm: session.llm,
        warn: (m) => { progress.breakLine(); ctx.print(m); },
        run: (llmForRewrite) => rewriteQuery(llmForRewrite, userText, {
          timeoutMs: 15000,
        }),
      });
      rewritePhaseRun = rewriteRun;
      if (rewriteRun.skipped) {
        // FALLBACK=0: warning already printed; retrieval proceeds on the
        // raw query (same effect as a failed rewrite).
        rewrite = null;
      } else {
        rewrite = rewriteRun.result;
        await session.transcript?.logMeta('rewrite', {
          intent: rewrite.intent,
          functionNames: rewrite.functionNames,
          keywords: rewrite.keywords,
          rewrittenQuery: rewrite.rewrittenQuery,
          fallback: rewrite.fallback,
          // Audit trail: record the ref only when the phase model was
          // ACTUALLY used; phaseModelFallback records the degradation.
          phaseModelRef: rewriteLlm && !rewriteRun.usedFallback
            ? (getPhaseModelRef(session.project, 'rewrite-query') || null)
            : null,
          phaseModelFallback: rewriteRun.usedFallback,
        });
      }
    } catch (err) {
      progress.done();
      ctx.print(`[warn] query rewrite failed, using raw query: ${err.message}`);
      rewrite = null;
    }
  }

  // --- Pass 1: retrieve KB (on the rewritten query, else raw user text) ----
  if (progress.phase !== 'retrieving KB') {
    progress.nextPhase('retrieving KB');
    setPhase('retrieving KB');
  }
  let graphText = '';
  let graphSummary = '';
  let graph = null;
  try {
    graph = await buildRequestGraph(session.rt, userText, {
      maxChars: session.modelCfg.maxChars || 65536,
      project: session.project,
      retrievalQuery: rewrite && !rewrite.fallback ? rewrite.rewrittenQuery : userText,
      rewrite,
    });
    graphSummary = graph.summary;
    graphText = renderRequestGraph(graph, { maxChars: Math.floor((session.modelCfg.maxChars || 65536) / 2) });
    // Holy-over-Eden priority: surface conflicts detected during retrieval so
    // the user knows an Eden entry was overridden by Holy for this turn. The
    // list is also kept for the end-of-turn Eden sync.
    session.kbConflicts = graph.conflicts || [];
    if (session.kbConflicts.length > 0) {
      progress.pause();
      process.stderr.write(`\n${style.warning(style.ICON.warn + ' [kb priority]')} Holy Space takes precedence over Eden. ${session.kbConflicts.length} Eden entr${session.kbConflicts.length === 1 ? 'y' : 'ies'} conflicted with Holy and ${session.kbConflicts.length === 1 ? 'was' : 'were'} suppressed from this turn's context:\n`);
      for (const c of session.kbConflicts) {
        process.stderr.write(`  - eden "${c.eden.title}" (${c.eden.id}) → superseded by holy "${c.holy.title}" (${c.holy.id})\n`);
      }
      process.stderr.write(style.dim('  The Eden entries will be marked superseded at the end of this task.\n'));
    }
    await session.transcript?.logMeta('graph', { summary: graph.summary });
  } catch (err) {
    progress.done();
    ctx.print(`[warn] knowledge graph build failed: ${err.message}`);
    graphText = '';
    graph = null;
  }
  // Remember the per-turn prefetch injection for the end-of-loop KB stats:
  // the knowledge-graph context rendered into the system prompt IS a KB use
  // (often the biggest one — the agent never had to search for these files).
  // filePaths feeds read classification (targeted vs cold) and the savings
  // estimate; renderedChars is the payload actually sent to the LLM.
  if (graph && graphText) {
    const seen = new Set();
    const fp = [];
    for (const s of graph.symbols || []) if (s.filePath && !seen.has(s.filePath)) { seen.add(s.filePath); fp.push(s.filePath); }
    for (const n of graph.neighbors || []) if (n.filePath && !seen.has(n.filePath)) { seen.add(n.filePath); fp.push(n.filePath); }
    for (const k of graph.knowledge || []) for (const kf of k.keyFiles || []) if (!seen.has(kf)) { seen.add(kf); fp.push(kf); }
    session.loopKbPrefetch = { filePaths: fp, renderedChars: graphText.length };
  } else {
    session.loopKbPrefetch = null;
  }

  // --- Pass 1.5: request-clarity assessment WITH retrieved context ---------
  // Runs after the first rewrite+retrieve so the LLM can ground its clarity
  // judgement in the retrieved symbols/knowledge. If unclear, surface the
  // candidate interpretations as a menu; the user's confirmation then drives
  // a second rewrite and a re-retrieve. One bounded round.
  let clarification = null;
  if (canAssess && graph) {
    if (progress.phase !== 'assessing request') {
      progress.nextPhase('assessing request');
      setPhase('assessing request');
    }
    try {
      const { assessRequest } = await import('../../lib/retrieval/rewrite_query.js');
      // Build a compact KB-context digest for the assessor: the graph summary
      // plus the top symbol names/signatures and matched knowledge titles.
      const ctxLines = [graphSummary ? `Summary: ${graphSummary}` : 'Summary: (no KB hits)'];
      if (graph.symbols && graph.symbols.length) {
        ctxLines.push('Top symbols:');
        for (const s of graph.symbols.slice(0, 8)) {
          ctxLines.push(`  - ${s.name} (${s.kind}) ${s.signature ? s.signature : ''}`);
        }
      }
      if (graph.knowledge && graph.knowledge.length) {
        ctxLines.push('Knowledge entries:');
        for (const k of graph.knowledge.slice(0, 4)) ctxLines.push(`  - ${k.title}`);
      }
      // Session task context (in-flight task / plan progress / recent turns)
      // so follow-ups that are terse in isolation but unambiguous given the
      // conversation are not flagged unclear.
      const sessionDigest = buildSessionDigest(session, userText);
      // Same HK2_ENABLE_PHASEMODEL_FALLBACK policy as the rewrite phase, but
      // evaluated INDEPENDENTLY: the request-assess override may be a
      // different model that is alive when the rewrite model is dead (or
      // vice versa), so the rewrite phase's outcome must not carry over.
      const assessRun = await runPhaseWithFallback({
        phase: 'request-assess',
        phaseLlm: assessLlm,
        sessionLlm: session.llm,
        warn: (m) => { progress.breakLine(); ctx.print(m); },
        run: (llmForAssess) => assessRequest(llmForAssess, userText, {
          timeoutMs: 15000,
          signal: abortCtrl.signal,
          context: ctxLines.join('\n'),
          sessionContext: sessionDigest,
        }),
      });
      // FALLBACK=0 and the phase model unreachable: assessRun.skipped (warn
      // already printed) -> assessment stays null, no clarification round,
      // the turn falls through to the agent loop on the pass-1 rewrite+graph.
      const assessment = assessRun.skipped ? null : assessRun.result;
      if (assessment) {
        await session.transcript?.logMeta('assess', {
          clear: assessment.clear,
          unclear: assessment.unclear,
          interpretations: assessment.interpretations,
          hadSessionContext: !!sessionDigest,
          phaseModelRef: assessLlm && !assessRun.usedFallback
            ? (getPhaseModelRef(session.project, 'request-assess') || null)
            : null,
          phaseModelFallback: assessRun.usedFallback,
        });
      }
      if (assessment && !assessment.clear) {
        progress.pause();
        clarification = await confirmClarification(assessment, session);
        if (clarification === null) {
          // User cancelled the clarification prompt (Ctrl+D / rl close):
          // abort the whole turn cleanly, mirroring plan-cancel handling.
          // Still run the Eden sync: pass-1 already told the user conflicting
          // entries "will be marked superseded at the end of this task".
          await syncConflictingEden(session, ctx);
          progress.done();
          // Mid-task input: this return exits BEFORE the main try/finally, so
          // disarm here explicitly — leaving agentTurnActive armed would make
          // enqueue() capture (and never deliver) every subsequent line.
          disarmMidTaskCapture(session);
          process.stderr.write(`${style.warning(style.ICON.warn + ' cancelled')}\n`);
          session.phase = 'idle';
          session.turnStart = 0;
          session.statusBar?.update();
          return;
        }
        await session.transcript?.logMeta('clarify', { clarification });
      }
    } catch (err) {
      // Assessment is best-effort: on any failure, fall through to the
      // normal flow (using the pass-1 rewrite + graph) with no clarification.
      ctx.print(`[warn] request assessment failed, skipping: ${err.message}`);
    }
  }

  // --- Pass 2 (only when the user supplied a clarification) ----------------
  // Re-run the rewrite with the confirmed interpretation, then re-retrieve so
  // the agent loop operates on the disambiguated, re-grounded context.
  if (clarification) {
    if (enableRewrite && session.llm) {
      if (progress.phase !== 'rewriting query') {
        progress.nextPhase('rewriting query');
        setPhase('rewriting query');
      }
      try {
        const { rewriteQuery } = await import('../../lib/retrieval/rewrite_query.js');
        // Pass-2 stays SKIPPED when pass-1 skipped the phase
        // (HK2_ENABLE_PHASEMODEL_FALLBACK=0): re-probing the dead model would
        // just repeat the warning and pay the 15s timeout again.
        if (!rewritePhaseRun?.skipped) {
          // Reuse the model that actually produced pass-1's outcome (the
          // phase model, or the session model after a fallback) so the
          // post-clarification pass stays consistent with pass-1.
          const llmForRewrite = rewritePhaseRun?.llm || rewriteLlm || session.llm;
          rewrite = await rewriteQuery(llmForRewrite, userText, {
            timeoutMs: 15000,
            clarification,
          });
          await session.transcript?.logMeta('rewrite', {
            intent: rewrite.intent,
            functionNames: rewrite.functionNames,
            keywords: rewrite.keywords,
            rewrittenQuery: rewrite.rewrittenQuery,
            fallback: rewrite.fallback,
            afterClarification: true,
            phaseModelRef: rewriteLlm && !rewritePhaseRun?.usedFallback
              ? (getPhaseModelRef(session.project, 'rewrite-query') || null)
              : null,
            phaseModelFallback: !!rewritePhaseRun?.usedFallback,
          });
        }
      } catch (err) {
        ctx.print(`[warn] post-clarification rewrite failed, keeping prior query: ${err.message}`);
      }
    }
    if (progress.phase !== 'retrieving KB') {
      progress.nextPhase('retrieving KB');
      setPhase('retrieving KB');
    }
    try {
      graph = await buildRequestGraph(session.rt, userText, {
        maxChars: session.modelCfg.maxChars || 65536,
        project: session.project,
        retrievalQuery: rewrite && !rewrite.fallback ? rewrite.rewrittenQuery : userText,
        rewrite,
      });
      graphSummary = graph.summary;
      graphText = renderRequestGraph(graph, { maxChars: Math.floor((session.modelCfg.maxChars || 65536) / 2) });
      // Merge the pass-2 conflict list into the pass-1 list (union by eden
      // id). Pass-1 already TOLD the user its conflicts "will be marked
      // superseded at the end of this task" — dropping them just because the
      // re-written query no longer matches would break that promise. Re-print
      // only NEWLY detected conflicts to avoid noise.
      const prevConflicts = session.kbConflicts || [];
      const prevConflictIds = new Set(prevConflicts.map(c => c.eden.id));
      const pass2Conflicts = graph.conflicts || [];
      session.kbConflicts = [...prevConflicts];
      for (const c of pass2Conflicts) {
        if (!prevConflictIds.has(c.eden.id)) session.kbConflicts.push(c);
      }
      const newConflicts = pass2Conflicts.filter(c => !prevConflictIds.has(c.eden.id));
      if (newConflicts.length > 0) {
        process.stderr.write(`\n${style.warning(style.ICON.warn + ' [kb priority]')} ${newConflicts.length} additional Eden entr${newConflicts.length === 1 ? 'y' : 'ies'} suppressed by Holy after clarification:\n`);
        for (const c of newConflicts) {
          process.stderr.write(`  - eden "${c.eden.title}" (${c.eden.id}) → superseded by holy "${c.holy.title}" (${c.holy.id})\n`);
        }
      }
      // Refresh the prefetch descriptor: pass-2 replaced the pass-1 graph.
      if (graph && graphText) {
        const seen = new Set();
        const fp = [];
        for (const s of graph.symbols || []) if (s.filePath && !seen.has(s.filePath)) { seen.add(s.filePath); fp.push(s.filePath); }
        for (const n of graph.neighbors || []) if (n.filePath && !seen.has(n.filePath)) { seen.add(n.filePath); fp.push(n.filePath); }
        for (const k of graph.knowledge || []) for (const kf of k.keyFiles || []) if (!seen.has(kf)) { seen.add(kf); fp.push(kf); }
        session.loopKbPrefetch = { filePaths: fp, renderedChars: graphText.length };
      }
      await session.transcript?.logMeta('graph', { summary: graph.summary, afterClarification: true });
    } catch (err) {
      progress.done();
      ctx.print(`[warn] post-clarification knowledge graph build failed: ${err.message}`);
      // Keep the pass-1 graphText; retrieval failures are non-fatal.
    }
  }

  const tools = buildTools(session.rt, {
    allowWrite: true,
    llm: session.llm,
    projectId: session.project?.id,
    guard: session.kbGuard,
    // Plan-confirmation interface: when the agent calls the `plan` tool,
    // surface its proposed plan to the user for per-step strategy
    // selection (confirmPlan) and return the finalized plan. The progress
    // spinner is paused while the interactive menu is on screen so its
    // per-200ms \r refresh does not overwrite the "Choose [1-k]" prompt.
    //
    // Plan Review (HK2_ENABLE_PLANREVIEW, default 0): AFTER the user confirms
    // the plan, if enabled, an LLM reviews the finalized plan for problems.
    // When the reviewer raises issues, each is surfaced to the user one-by-one
    // for confirmation (accept the reviewer's suggestion / dismiss / type your
    // own); the confirmed resolutions are appended to the finalized plan text
    // returned to the agent. The review model is configurable via
    // `/model set-phase --phase=plan-review <ref>` (same mechanism as
    // rewrite-query); when unset it uses the session model. Best-effort: any
    // failure falls through and returns the already-confirmed plan unchanged.
    planConfirm: async (plan) => {
      progress.pause();
      const confirmed = await confirmPlan(plan, session);
      if (confirmed === null) return null; // user cancelled the plan itself
      // Record that a plan was confirmed this turn and keep the finalized plan
      // text so the end-of-turn Code Review can compare the result against it.
      session.hadPlanThisTurn = true;
      session.lastPlanText = confirmed;
      if (!envFlag('HK2_ENABLE_PLANREVIEW', 0) || !session.llm) return confirmed;
      // Resolve a per-phase model override for the plan-review phase; fall
      // back to the session model when unset or unresolvable (with a warn,
      // matching the rewrite-query phase handling).
      let reviewLlm = session.llm;
      let usingPhaseModel = false;
      try {
        const phaseLlm = await resolvePhaseLlm('plan-review');
        if (phaseLlm) { reviewLlm = phaseLlm; usingPhaseModel = true; }
      } catch (err) {
        ctx.print(`[warn] could not resolve phase model for plan-review, using session model: ${err.message}`);
      }
      // Surface the Plan Review so the user knows it is running AND what it
      // is checking. The review is a best-effort LLM call with no fixed
      // timeout — it waits for the LLM to finish (the user can still abort);
      // show an animated spinner phase (mirroring rewrite-query / KB
      // retrieval) so the wait is never silent, then pause it before any
      // output / menu.
      const reviewModelLabel = usingPhaseModel
        ? (getPhaseModelRef(session.project, 'plan-review') || 'plan-review phase model')
        : 'session model';
      ctx.print('');
      ctx.print(style.accent(style.bold('Plan Review')));
      ctx.print(style.dim(`  Reviewing the confirmed plan with ${reviewModelLabel}...`));
      ctx.print(style.dim('  Checks: requirement coverage, missing steps, ordering, feasibility, risks, assumptions.'));
      progress.nextPhase('reviewing plan');
      setPhase('reviewing plan');
      try {
        // Review phases use the "skip on unreachable" policy — NEVER a session-
        // model fallback (see runPhaseWithSkipOnUnreachable): substituting an
        // unplanned model would change what reviewed the plan. Warnings are
        // printed by the policy; skip -> the confirmed plan passes through
        // unchanged, with no "no issues found" message.
        //
        // The reviewer's analysis streams live (same UX as code review):
        // progress.tick() clears the spinner on the first delta, MarkdownStream
        // styles headings/lists as they arrive, and createVerdictFilter hides
        // the machine-readable === VERDICT === JSON so the user never sees raw
        // JSON scroll by. flushNow() writes any trailing partial line before
        // warnings / menus / verdicts print. The reviewer's THINKING stream
        // renders live too (ReasoningStream + progress.reason(), mirroring the
        // main agent loop): reasoning deltas arrive before any body text, so
        // without this the whole deep-reasoning window is a silent spinner.
        const mdStream = new MarkdownStream();
        const reasoningStream = new ReasoningStream();
        const flushNow = () => {
          const tail = reasoningStream.end() + mdStream.flush();
          if (tail) process.stdout.write(tail);
        };
        const onReasoning = (text) => {
          progress.reason();
          if (reasoningStream.headerShown) progress.pause();
          const rendered = reasoningStream.feed(text);
          if (rendered) process.stdout.write(rendered);
        };
        const onDelta = createVerdictFilter((text) => {
          progress.tick(text);
          const rendered = mdStream.feed(text);
          if (rendered) process.stdout.write(rendered);
        });
        const reviewRun = await runPhaseWithSkipOnUnreachable({
          phase: 'plan-review',
          phaseLlm: usingPhaseModel ? reviewLlm : null,
          sessionLlm: session.llm,
          warn: (m) => { flushNow(); progress.breakLine(); ctx.print(m); },
          run: (llmForReview) => reviewPlan(llmForReview, confirmed, {
            signal: abortCtrl.signal,
            onDelta,
            onReasoning,
          }),
        });
        flushNow(); // write the renderer's trailing partial line before any menu/warning
        progress.pause(); // stop the spinner before printing the menu / result
        await session.transcript?.logMeta('planReview', {
          skipped: reviewRun.skipped,
          ...(reviewRun.skipped ? { error: reviewRun.error } : {}),
          ok: reviewRun.result ? reviewRun.result.ok : null,
          issueCount: reviewRun.result && reviewRun.result.issues ? reviewRun.result.issues.length : 0,
          ...(reviewRun.result && reviewRun.result.parseError ? { parseError: reviewRun.result.parseError } : {}),
          phaseModelRef: usingPhaseModel && !reviewRun.skipped ? (getPhaseModelRef(session.project, 'plan-review') || null) : null,
        });
        if (reviewRun.skipped) {
          // Model unreachable: warnings already printed; proceed with the
          // confirmed plan as-is (review skipped, not "passed").
          return confirmed;
        }
        const result = reviewRun.result;
        if (result.parseError) {
          // No parseable JSON verdict: UNKNOWN outcome, never "no issues
          // found". The report part already streamed above; warn and proceed
          // with the confirmed plan (the gate is best-effort, never blocks).
          ctx.print(style.warning(`  [warn] ${result.parseError} - the plan review outcome is UNKNOWN; proceeding with the confirmed plan.`));
          return confirmed;
        }
        if (result.ok || !result.issues || result.issues.length === 0) {
          ctx.print(style.dim('  Plan review complete - no issues found. Proceeding with the confirmed plan.'));
          return confirmed;
        }
        const resolutions = await confirmPlanReview(result.issues, session);
        if (resolutions === null) return null; // user cancelled during review
        if (resolutions.length === 0) return confirmed; // dismissed every issue
        const annex = resolutions
          .map((r) => `Plan review issue: ${r.title} -> ${r.resolution}`)
          .join('\n');
        return `${confirmed}\n${annex}`;
      } catch (err) {
        // Review is best-effort: never block the confirmed plan on a failure.
        progress.pause();
        ctx.print(`[warn] plan review failed, using confirmed plan as-is: ${err.message}`);
        return confirmed;
      }
    },
    // Plan-step advancement: the agent calls the `plan_step` tool to mark
    // the current step done and move to the next. This updates the pinned
    // progress block above the status bar in real time. When the last step
    // completes the plan is cleared (block disappears).
    //
    // Robust to sloppy model step args (fast reasoning models like
    // deepseek-v4-flash emit numeric strings, 0-based indices, or off-by-one
    // values): any invalid step falls back to the current one so the panel
    // never gets stuck on an in_progress step that can never flip to done.
    // Returns the 1-based step actually marked (or null when no plan is
    // active) so the tool result can report it accurately.
    planStep: async (stepIndex, note) => {
      const p = session.planProgress;
      if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return null;
      let idx = -1;
      if (typeof stepIndex === 'number' && Number.isInteger(stepIndex)) idx = stepIndex - 1;
      else if (typeof stepIndex === 'string' && /^\d+$/.test(stepIndex.trim())) idx = parseInt(stepIndex, 10) - 1;
      const cur = (typeof p.current === 'number' && p.current >= 0 && p.current < p.steps.length) ? p.current : 0;
      // Always treat the CURRENT step as the one just finished, regardless of
      // what step number the model passed. Fast reasoning models (observed:
      // deepseek-v4-flash) emit numeric strings, 0-based indices, ahead-of-
      // current "next step" values, or re-confirm an already-done earlier
      // step. Trusting the passed idx to mark-done left the *current*
      // in_progress step stranded: (a) the panel showed a stale in_progress
      // step while the agent had moved on, and (b) when the current step was
      // the last one, it never flipped to done so `next` never reached -1 and
      // the plan block never cleared. Marking cur done guarantees the actual
      // in-flight step advances and the panel stays in sync with reality.
      const markIdx = cur;
      p.steps[markIdx].status = 'done';
      if (note) p.steps[markIdx].note = String(note).slice(0, 160);
      // Defensively clear any stale in_progress markers left by earlier
      // ahead-of-current calls, then advance to the FIRST non-done step.
      // (Looking only for the first 'pending' step let a wrong-but-valid step
      // number leave an earlier in_progress step stuck forever, rendering two
      // '>' rows and blocking the all-done clear.)
      let next = -1;
      for (let i = 0; i < p.steps.length; i++) {
        if (p.steps[i].status !== 'done') {
          if (p.steps[i].status === 'in_progress') p.steps[i].status = 'pending';
          if (next === -1) next = i;
        }
      }
      if (next === -1) {
        // All steps done - clear the plan progress block.
        session.planProgress = null;
      } else {
        p.steps[next].status = 'in_progress';
        p.current = next;
      }
      session.statusBar?.update();
      return markIdx + 1;
    },
    // Knowledge-save approval gate: the agent calls `kb_save_knowledge` to
    // persist learned entries. Holy Space is the source of truth - it MUST
    // prompt the user before every commit, regardless of env vars. Eden
    // auto-commits only when HK2_ENABLE_AUTO_LEARN=1; otherwise it also
    // prompts. The progress spinner is paused while the prompt is on screen
    // (same reason as planConfirm). Returns true (proceed) / false (refuse) /
    // 'eden' (redirect a NEW Holy write into Eden, per the y/N/E rule).
    knowledgeConfirm: async (targetSpace, entry) => {
      progress.pause();
      const label = targetSpace === 'holy'
        ? style.warning('HOLY space')
        : style.accent('Eden space');
      process.stderr.write(`\n[kb save] Model proposes ${label} entry "${entry?.id}": ${entry?.title || ''}\n`);
      if (targetSpace === 'holy') {
        process.stderr.write(`  Holy Space is the source of truth for stable design knowledge.\n`);
      }
      // Tri-state (y/N/E) only for NEW Holy entries; updates and Eden keep (y/N).
      const offerEden = targetSpace === 'holy' && entry?.isNew;
      const suffix = offerEden ? ' (y/N/E) ' : ' (y/N) ';
      if (offerEden) {
        process.stderr.write(style.dim('  E = save this entry to Eden space instead of Holy.\n'));
      }
      const confirmed = offerEden
        ? await confirmThreeWay(session, `Write "${entry?.id}" to ${targetSpace} space?${suffix}`)
        : await ctx.confirm(`Write "${entry?.id}" to ${targetSpace} space?${suffix}`);
      if (confirmed === 'eden') {
        process.stderr.write(`${style.accent('  Redirected - saving to Eden space instead.')}\n`);
      } else if (!confirmed) {
        process.stderr.write(`${style.dim('  Cancelled - nothing was written to the KB.')}\n`);
      }
      return confirmed;
    },
  });

  // ── MCP tools (/model add-mcpserver) ──
  // Attach tools from MCP servers configured on the ACTIVE model. Cached per
  // model ref so a turn doesn't redo the JSON-RPC handshake. Best-effort:
  // unreachable servers print a warning and are skipped; the session keeps
  // its built-in tools either way.
  try {
    const mcp = await getMcpTools(session.modelCfg?.ref);
    if (mcp.tools.length > 0) {
      tools.push(...mcp.tools);
      const names = mcp.tools.map((t) => t.name).join(', ');
      ctx.print(style.dim(`  [mcp] attached ${mcp.tools.length} tool(s) from model MCP servers: ${names}`));
    }
    for (const w of mcp.warns) ctx.print(style.warning(`  [mcp] ${w}`));
  } catch (err) {
    ctx.print(style.warning(`  [mcp] attach failed: ${err.message} (continuing without MCP tools)`));
  }

  if (session.messages.length === 0 || session.needsSystemPrompt) {
    // Supreme code items: read fresh from the store on every system-prompt
    // build so an amended code (via /kb code add|del) takes effect at the
    // next prompt rebuild without waiting for a KB reload.
    let supremeCodes;
    if (session.project?.id) {
      try {
        const { readSupremeCode } = await import('../../lib/store/supreme_code.js');
        supremeCodes = (await readSupremeCode(session.project.id))?.codes || [];
      } catch { supremeCodes = undefined; }
    }
    const sysPrompt = buildSystemPrompt({
      project: session.project,
      tools,
      cwd: process.cwd(),
      graphText,
      supremeCodes,
    });
    if (session.messages.length === 0) {
      session.messages.push({ role: 'system', content: sysPrompt });
    } else {
      // Resumed session: replayTranscript skipped the old system prompt (it
      // references the tool list / KB graph of the process that wrote it) —
      // splice a fresh one at the head of the replayed history.
      session.messages.unshift({ role: 'system', content: sysPrompt });
      session.needsSystemPrompt = false;
    }
    await session.transcript?.logSystemPrompt(sysPrompt);
  } else {
    session.messages.push({
      role: 'system',
      content: `## Knowledge-base context for this turn (query="${userText}")\nHits: ${graphSummary}\n\n${graphText}`,
    });
  }

  // Track KB-first-policy violations: when the agent uses bash to grep/find/cat
  // source files, that's a signal the KB didn't have what it needed and we
  // should suggest a KB update at end of turn.
  session.bashSearchCommands = [];
  // Reset the per-turn "already learned" flag: if the agent saves knowledge
  // via kb_save_knowledge during THIS turn, maybeOfferKbUpdate will skip the
  // redundant end-of-turn [kb learn] extraction.
  session.kbSavedThisTurn = false;
  session.kbSavedEntries = [];
  // Reset per-loop AND per-call token counters; cumulative session totals
  // (cumIn/cumOut) stay in session.tokens. callIn/callOut will also be reset
  // on every onTurnStart (per LLM call) after being committed to loopIn/loopOut.
  session.tokens.callIn = 0;
  session.tokens.callOut = 0;
  session.tokens.loopIn = 0;
  session.tokens.loopOut = 0;
  session.tokens.loopPeakIn = 0;
  session.tokens.loopPeakOut = 0;

  // Planning is now LLM-driven: the system prompt instructs the agent to act
  // as its own triage assistant and call the `plan` tool when (and only when)
  // it decides the task is complex enough to warrant a user-confirmed plan.
  // There is no separate pre-execution assessment / generation pass here;
  // the `plan` tool (registered via buildTools planConfirm) is the interface
  // that receives the LLM plan decision and surfaces it to the user for
  // per-step confirmation. Simple tasks flow straight into execution.

  session.messages.push({ role: 'user', content: userText });
  await session.transcript?.logUser(userText);

  // Enter the model-wait phase for the agent loop. (Planning, if needed, is
  // now driven by the agent calling the `plan` tool mid-loop, not by a
  // pre-execution pass, so we always transition straight into execution.)
  progress.nextPhase('waiting for model');
  setPhase('waiting for model');

  let assistantText = '';
  // Per-LLM-call markdown renderer. Streams line-by-line styling so the
  // user sees formatted output (headings, lists, code blocks) as it
  // arrives instead of raw `##` / `**bold**` source.
  let mdStream = new MarkdownStream();
  const flushMarkdown = () => {
    if (!mdStream) return '';
    const out = mdStream.flush();
    return out;
  };
  // Per-LLM-call reasoning renderer. Reasoning models (deepseek-v4-pro,
  // GLM-4.7, ...) stream reasoning_content BEFORE any body text. We surface
  // it live in a dim/italic style so the user can follow the model's thought
  // process instead of staring at a static 'thinking' spinner with no content.
  // Reset on every turn; ended before body text / tool cards so output stays clean.
  let reasoningStream = new ReasoningStream();
  const flushReasoning = () => reasoningStream.end();
  const callbacks = {
    onTurnStart: (_turnIdx) => {
      // Each LLM stream call inside the agent loop starts a new "turn".
      // Commit the previous call's per-call maxima to the cumulative session
      // total, then reset callIn/callOut. loopIn/loopOut are NOT touched
      // here: they're delta-updated in onUsage so the bar always reflects
      // the running loop total, including the in-flight call.
      if (_turnIdx > 1) {
        session.tokens.cumIn += session.tokens.callIn;
        session.tokens.cumOut += session.tokens.callOut;
      }
      session.tokens.callIn = 0;
      session.tokens.callOut = 0;
      // Reset the KB-first guardrail so each call gets a fresh "haven't used KB yet" check.
      session.kbGuard?.reset();
      // Reset per-loop KB-stats tracking on the first turn of the turn's loop.
      // (onTurnStart fires for every LLM call inside the loop; only _turnIdx===1
      // marks the start of a fresh user turn.)
      if (_turnIdx === 1) {
        session.loopKbCalls = [];
        session.loopFallbackCalls = [];
        session.loopCallSeq = 0;
      } else {
        // Re-arm the spinner for this LLM call. The previous call's first body
        // delta ran tick() (stopped=true, phase=null), so without re-arming
        // reason()/tick() would be no-ops for the rest of the loop and the
        // spinner would stay dead — every subsequent reasoning window / model
        // wait would render with NO phase label. Turn 1 is handled by the
        // prelude's nextPhase('waiting for model') above, so it is skipped.
        progress.resume('waiting for model');
      }
      // Fresh markdown renderer for the new LLM call.
      mdStream = new MarkdownStream();
      // Fresh reasoning renderer for the new LLM call's reasoning window.
      reasoningStream = new ReasoningStream();
      session.statusBar?.update();
    },
    onDelta: (text) => {
      // First body delta ends the reasoning window (if any). Flush any
      // trailing partial reasoning line so it renders cleanly before the
      // answer text begins, then finalize the reasoning stream.
      const reasoningTail = flushReasoning();
      if (reasoningTail) process.stdout.write(reasoningTail);
      progress.tick(text);
      // Style the delta through the markdown stream; raw text still
      // accumulates into assistantText for the transcript.
      const rendered = mdStream ? mdStream.feed(text) : text;
      if (rendered) process.stdout.write(rendered);
      assistantText += text;
      if (session.phase !== 'streaming') setPhase('streaming');
      else session.statusBar?.update();
    },
    onReasoning: (text) => {
      // Reasoning models (deepseek-v4-pro, GLM-4.7, ...) emit a long
      // reasoning_content stream before any body text. We BOTH advance the
      // spinner into a 'thinking' phase (live progress instead of stalling on
      // 'waiting for model') AND surface the reasoning text to the user so
      // they can follow what the model is doing. The previous fix only
      // switched the spinner label and threw the text away — the user saw
      // 'thinking'/'waiting for model' flip back and forth with no content.
      //
      // progress.reason() is idempotent (no-op when already on 'thinking').
      // On the FIRST reasoning delta we pause the spinner so its per-200ms \r
      // refresh on stderr can't clobber the reasoning text we stream to stdout;
      // subsequent deltas just continue the text stream (re-pausing would
      // re-clear the line and eat the trailing reasoning line we just wrote).
      progress.reason();
      if (session.phase !== 'thinking') setPhase('thinking');
      if (text) {
        if (!reasoningStream.headerShown) progress.pause();
        const rendered = reasoningStream.feed(text);
        if (rendered) process.stdout.write(rendered);
      }
    },
    onUsage: (u) => {
      // Usage events from the LLM client are cumulative-within-call snapshots
      // (the client wrapper emits progressive estimates + real provider values
      // using max() semantics). For callIn/callOut we take the running max.
      // For loopIn/loopOut we delta-update on each event so the bar shows the
      // running loop total mid-call — without this, the bar would lag one
      // full LLM call behind (and read 0 during the first call of the loop).
      // loopPeakIn/loopPeakOut track the max single-call value across the
      // loop — what the status-bar % is computed from, since context-window
      // fill is per-call, not summed.
      // cumIn/cumOut are committed at call boundaries (onTurnStart + post-loop).
      if (typeof u.input === 'number' && u.input > 0 && u.input > session.tokens.callIn) {
        session.tokens.loopIn += u.input - session.tokens.callIn;
        session.tokens.callIn = u.input;
        if (session.tokens.callIn > session.tokens.loopPeakIn) {
          session.tokens.loopPeakIn = session.tokens.callIn;
        }
      }
      if (typeof u.output === 'number' && u.output > 0 && u.output > session.tokens.callOut) {
        session.tokens.loopOut += u.output - session.tokens.callOut;
        session.tokens.callOut = u.output;
        if (session.tokens.callOut > session.tokens.loopPeakOut) {
          session.tokens.loopPeakOut = session.tokens.callOut;
        }
      }
      session.statusBar?.update();
    },
    onToolCallStart: (call) => {
      // Stream ended for this LLM call. Flush any partial markdown line so
      // the trailing text renders before the tool card opens.
      // Also flush any open reasoning window: reasoning models may emit
      // reasoning_content then tool_calls with NO body text, so we must
      // finalize the reasoning stream (trailing newline) and clear the
      // spinner line before the card takes over.
      const reasoningTail = flushReasoning();
      if (reasoningTail) process.stdout.write(reasoningTail);
      const flushed = flushMarkdown();
      if (flushed) process.stdout.write(flushed);
      // Finalize the spinner so its per-200ms \r refresh can't overwrite the
      // tool card. This is the exact bug for reasoning models: when the model
      // emits reasoning_content then tool_calls with NO body text, tick() never
      // fires, so the spinner keeps animating under 'thinking' and its \r refresh
      // clobbers the tool header that onToolCallStart writes below. stop() sets
      // `stopped` so the spinner stays down for the tool round; the next turn's
      // onTurnStart re-arms it via resume(). (No-op when already stopped.)
      progress.stop();
      setPhase(`tool: ${call.name}`);
      // Open the card: top border with the tool name as title + header line.
      // Default width matches the welcome bar so all cards line up visually;
      // onToolCallEnd may grow the card further if the body needs more room
      // (it redraws the top via ANSI cursor-up so the borders stay aligned).
      const args = typeof call.arguments === 'string' ? safeParseArgs(call.arguments) : (call.arguments || {});
      const token = toolCardToken(call.name);
      const header = toolHeader(call.name, args, token);
      const w = cardWidthFor([header], call.name);
      process.stderr.write('\n');
      process.stderr.write(style.topBorder(call.name, { width: w, token }) + '\n');
      process.stderr.write(style.bodyLine(header, { width: w, token }) + '\n');
    },
    onToolCallEnd: (call, result) => {
      setPhase('waiting for model');
      session.toolCallCount++;
      const args = typeof call.arguments === 'string' ? safeParseArgs(call.arguments) : (call.arguments || {});
      const token = toolCardToken(call.name);
      const header = toolHeader(call.name, args, token);
      const previewText = JSON.stringify(result.ok ? result.result : { error: result.error });
      // Render up to 6 body lines so big tool results don't drown the turn.
      const maxLines = 6;
      const bodyLines = [];
      const chunks = previewText.split('\\n');
      const joined = chunks.slice(0, maxLines);
      for (const ln of joined) {
        const truncated = ln.length > 200 ? ln.slice(0, 200) + '…' : ln;
        bodyLines.push(style.dim(truncated));
      }
      if (chunks.length > maxLines) {
        bodyLines.push(style.dim(`… ${chunks.length - maxLines} more lines`));
      }
      const statusLine = result.ok
        ? `${style.success(style.ICON.ok)} ${style.dim('ok')}`
        : `${style.errorT(style.ICON.err)} ${style.errorT('failed')}`;
      bodyLines.push(statusLine);
      // Pick the final width from the FULL body (header + every body line).
      const w = cardWidthFor([header, ...bodyLines], call.name);
      const startW = cardWidthFor([header], call.name);
      if (w > startW) {
        // Body needs more width than the top predicted. Move cursor back up
        // to the top border (2 lines: top + header), clear to end of screen,
        // and redraw the whole card at the wider width so the borders match
        // and no body character is truncated.
        process.stderr.write('\x1b[2A\x1b[J');
        process.stderr.write(style.topBorder(call.name, { width: w, token }) + '\n');
        process.stderr.write(style.bodyLine(header, { width: w, token }) + '\n');
      }
      // When w === startW the top + header from onToolCallStart are still
      // valid; just append the body and bottom border at the same width.
      for (const ln of bodyLines) {
        process.stderr.write(style.bodyLine(ln, { width: w, token }) + '\n');
      }
      process.stderr.write(style.bottomBorder({ width: w, token }) + '\n');
      session.transcript?.logToolCall(call, result);
      // The unwrapped tool payload (result.result when ok), used by the
      // kb_save_knowledge tracking below and the KB-hit-rate classifier.
      const payload = result && result.ok ? result.result : null;
      // Record bash search-like commands for end-of-turn KB update suggestion
      if (call.name === 'bash') {
        try {
          const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : call.arguments;
          if (args && typeof args.command === 'string' && session.kbGuard?._isBashSearch(args.command)) {
            session.bashSearchCommands.push(args.command);
          }
        } catch { /* ignore */ }
      }
      // Track successful knowledge saves this turn: when the agent already
      // persisted (or the user explicitly approved/refused) a kb_save_knowledge
      // proposal, the end-of-turn [kb learn] extraction would re-learn the
      // same thing. `saved: true` marks "done"; `cancelled: true` (user saw
      // the proposal and declined) also counts as "handled" — the model
      // already surfaced its knowledge and the user made the call. Only hard
      // errors ({ error }) leave the flag unset so learn can still run.
      if (call.name === 'kb_save_knowledge' && payload && typeof payload === 'object') {
        if (payload.saved || payload.cancelled) {
          session.kbSavedThisTurn = true;
          if (payload.saved) {
            session.kbSavedEntries.push({ id: payload.id, space: payload.space });
          }
        }
      }
      // Per-loop KB-hit-rate tracking: record every call as either a KB call
      // or a no-KB fallback (bash-search / discovery tools / cold source-file
      // reads), preserving execution order via seq. Cached cache hits still
      // count - the agent still *chose* the KB. The result is the unwrapped
      // tool payload (result.result when ok) so the stats helper can classify
      // reads and estimate token savings.
      const seq = session.loopCallSeq++;
      if (typeof call.name === 'string' && call.name.startsWith('kb_')) {
        session.loopKbCalls.push({ call, result: payload, seq });
      } else if (fallbackKind(call, null) || classifyRead(safeParseArgs(call.arguments)?.path, null, payload)) {
        session.loopFallbackCalls.push({ call, result: payload, seq });
      }
    },
  };

  try {
    const result = await runLoop({
      llm: session.llm,
      messages: session.messages,
      tools,
      callbacks,
      signal: abortCtrl.signal,
      // Round-boundary injection of mid-task user input: fires after every
      // tool_call of a round completed, before the next LLM call starts. All
      // queued instructions are batched into ONE tagged user message so the
      // model sees them as in-task guidance, not a conversation break. The
      // user sees their lines echoed (userMarkerLines) exactly like a normal
      // prompt, preserving the mental model of "I just said this".
      onRoundBoundary: async (_turnIdx) => {
        if (!session.userInputQueue || session.userInputQueue.length === 0) return;
        const lines = session.userInputQueue.splice(0);
        const injected = buildMidTaskInjection(lines);
        if (!injected) return;
        process.stderr.write('\n');
        for (const ln of userMarkerLines(lines.join('\n'))) {
          process.stderr.write(style.muted(ln) + '\n');
        }
        process.stderr.write('\n');
        session.messages.push({ role: 'user', content: injected });
        await session.transcript?.logUser(injected);
      },
      llmOpts: {
        maxChars: session.modelCfg.maxChars,
        temperature: session.modelCfg.temperature,
        enableReasoning: session.modelCfg.enableReasoning,
      },
      // No fixed maxTurns — the loop runs until the task is done, with
      // stuck-detection (identical-repeat / no-progress) and a high
      // absolute safety cap as backstops. See lib/agent/loop.js.
    });

    // Final flush of the markdown renderer in case the last LLM call left a
    // trailing partial line (no terminating newline). Renders it before the
    // closing blank line so the layout stays clean.
    const finalReasoning = flushReasoning();
    if (finalReasoning) process.stdout.write(finalReasoning);
    const finalFlush = flushMarkdown();
    if (finalFlush) process.stdout.write(finalFlush);

    process.stdout.write('\n');
    progress.done();

    // Commit the final LLM call's per-call maxima into the cumulative session
    // totals. (onTurnStart commits every call except the last, since the loop
    // ends after the last call returns no tool_calls.) loopIn/loopOut already
    // include the final call via the delta-update in onUsage — no commit here.
    session.tokens.cumIn += session.tokens.callIn;
    session.tokens.cumOut += session.tokens.callOut;

    // Status line — show usage for the WHOLE LOOP plus cumulative session totals.
    if (session.tokens.loopIn > 0 || session.tokens.loopOut > 0) {
      const usage = formatUsage(session.tokens, session.modelCfg?.maxChars || 0);
      // KB hit-rate + estimated token savings for this loop. Computed from the
      // per-loop call log (kb_* vs bash-search/source-read fallbacks). The
      // savings are an estimate (stat referenced files - KB result bytes ->
      // tokens), so they're labelled with `~`. Appended on the same stderr
      // line as usage, dot-separated, to match the existing status style.
      let kbPart = '';
      let kbStats = null;
      try {
        kbStats = await buildKbStats(session.loopKbCalls, session.loopFallbackCalls, {
          root: session.project?.sourcePath || '',
          estTokens: estimateTokensFromChars,
          prefetch: session.loopKbPrefetch,
        });
        if (kbStats.kbCalls > 0 || kbStats.fallbackCalls > 0) {
          const pct = Math.round(kbStats.hitRate * 100);
          const errs = kbStats.kbErrors > 0 ? ` ${style.dim('!' + kbStats.kbErrors + ' err')}` : '';
          kbPart = ` ${style.dim(style.ICON.dot)} ${style.accent('kb ' + pct + '%')}${errs} ${style.dim(style.ICON.dot)} ${style.muted('~' + fmtTok(kbStats.estimatedTokensSaved) + ' saved')}`;
        }
      } catch { /* stats are best-effort; never block the turn on them */ }
      // Persist the kb-stats meta OUTSIDE the render try/catch — the raw data
      // is what later analysis (hit-rate trends, saved-token distribution)
      // needs even (especially) when rendering breaks.
      if (kbStats) {
        try {
          await session.transcript?.logMeta('kb-stats', {
            kbCalls: kbStats.kbCalls,
            fallbackCalls: kbStats.fallbackCalls,
            hitRate: kbStats.hitRate,
            estimatedTokensSaved: kbStats.estimatedTokensSaved,
            prefetchSaved: kbStats.prefetchSaved,
            kbErrors: kbStats.kbErrors,
            coldReads: kbStats.coldReads,
            targetedReads: kbStats.targetedReads,
            kbAssistedReads: kbStats.kbAssistedReads,
          });
        } catch { /* transcript logging is best-effort */ }
      }
      process.stderr.write(`${style.success(style.ICON.ok + ' usage')} ${style.dim(style.ICON.dot)} ${usage}${kbPart}\n`);
      await session.transcript?.logMeta('usage', {
        loop: { in: session.tokens.loopIn, out: session.tokens.loopOut },
        cumulative: { in: session.tokens.cumIn, out: session.tokens.cumOut },
      });
    }

    session.lastAnswer = assistantText;
    await session.transcript?.logAssistant(assistantText);
    await session.transcript?.logTurn(result.turns, result.toolCalls);

    // End-of-turn KB update: if the agent fell back to bash-search at all,
    // the project source may have new files / the KB may be stale. Offer to
    // run an incremental update unless HK2_ENABLE_AUTO_UPDATEKB=1, in which
    // case update silently.
    await maybeOfferKbUpdate(session, ctx);

    // Holy-over-Eden priority, end-of-task step: stamp the Eden entries that
    // conflicted with Holy this turn as superseded (Eden is auto-updatable,
    // so no extra prompt), then remind the user what was synced.
    await syncConflictingEden(session, ctx);

    session.phase = 'idle';
    session.turnStart = 0;
    finalizePlanProgress(session);
    session.statusBar?.update();
    // Task completed normally and (if a plan existed) all steps are done:
    // clear the persisted task state so the next session doesn't resume a
    // finished task. We only clear when there's no planProgress left, because a
    // multi-step plan that's mid-flight should remain recoverable across turns.
    if (!session.planProgress) {
      session.lastTask = null;
      await clearTaskState(session.project?.id);
    }

    // ---- Code Review (HK2_ENABLE_CODEREVIEW, default 0) -------------------
    // After a plan completes, review the ENTIRE result (working-tree diff +
    // final answer) for correctness / completeness / quality. Runs only when
    // the plan is actually complete (planProgress cleared) AND a plan was
    // involved this turn: either confirmed this turn, or a multi-turn plan that
    // was already active at turn start. A plan confirmed but still mid-flight
    // keeps planProgress non-null and does NOT trigger review. Best-effort;
    // never blocks the turn.
    const planCompleted = !session.planProgress && (session.hadPlanThisTurn || planActiveAtStart);
    if (envFlag('HK2_ENABLE_CODEREVIEW', 0) && session.llm && planCompleted) {
      await runCodeReview(session, ctx, {
        planText: session.lastPlanText || '',
        assistantText,
        resolvePhaseLlm,
        signal: abortCtrl.signal,
        progress,
      });
    }
  } catch (err) {
    progress.done();
    // An abort/error can leave a trailing assistant `tool_use` (tool_calls)
    // whose tool_result never landed - the tool loop was cut short. Strip it
    // so the next turn doesn't resend an orphaned tool_use and 400 Anthropic.
    stripDanglingToolUse(session.messages);
    if (abortCtrl.signal.aborted) {
      // User pressed ESC. Any partial assistant text was already streamed to
      // stdout; we don't record an incomplete assistant turn in the transcript.
      process.stderr.write(`\n${style.warning(style.ICON.warn + ' interrupted')}${style.dim(' — partial output preserved')}\n`);
      session.phase = 'idle';
    } else {
      process.stderr.write(`\n${style.errorLine(err.message)}\n`);
      if (process.env.HK2_DEBUG) process.stderr.write(err.stack + '\n');
      session.phase = 'error';
    }
    session.turnStart = 0;
    finalizePlanProgress(session);
    session.statusBar?.update();
    // Task interrupted: persist the current task context + plan progress to
    // disk so a process restart (not just an in-session error) can also be
    // recovered via "请继续 / continue". For in-session errors session.lastTask
    // is already set, so the recovery injection above handles the next turn;
    // this write covers the cross-process case.
    //
    // The turn ended abruptly, but any Holy-over-Eden conflicts detected at
    // retrieval time were already announced to the user — sync them now so
    // the promise "will be marked superseded at the end of this task" holds
    // even on error/interrupt paths.
    await syncConflictingEden(session, ctx).catch(() => {});
    if (session.lastTask) {
      const planLines = formatPlanProgressLines(session);
      await saveTaskState(session.project?.id, {
        userRequest: session.lastTask.userRequest,
        taskSummary: planLines.length > 0 ? planLines.join('\n') : '(no active plan)',
        planProgress: session.planProgress,
        sessionId: session.transcript?.sessionId || null,
        reason: abortCtrl.signal.aborted ? 'interrupted' : 'error',
      });
    }
  } finally {
    if (canInterrupt && rlInput) rlInput.off('keypress', onKeypress);
    // Mid-task input: the turn is over. Disarm capture FIRST so lines arriving
    // from now on go through the normal queue path, then hand any instructions
    // that never reached a round boundary (e.g. the model's final reply had no
    // tool calls, or the turn aborted early) back to the normal queue — they
    // become fresh user turns right after this task, so nothing typed by the
    // user is ever dropped.
    const leftover = disarmMidTaskCapture(session);
    if (leftover.length > 0) {
      process.stderr.write(style.dim(`(queued instruction${leftover.length > 1 ? 's' : ''} passed to a new turn — the task finished before they could be delivered mid-run)`) + '\n');
    }
    // Snapshot the last measured context size (peak single-call input tokens)
    // for the next turn's auto-compaction threshold check. loopPeakIn/callIn
    // are reset at the start of the next turn, so this is the only point that
    // still holds the exact value from the just-finished turn. Runs on both
    // success and error/interrupt so a partial turn still leaves a usable
    // measurement.
    session.lastContextTokens = Math.max(session.tokens.loopPeakIn, session.tokens.callIn);
  }
}

/**
 * Remove any trailing assistant `tool_use` (tool_calls) whose tool_result
 * never landed in history - e.g. after an interrupted or errored turn where
 * the tool loop was cut short. Without this, the next LLM call resends an
 * orphaned tool_use and Anthropic rejects it with a 400
 * ("tool_use ids found without tool_result blocks").
 *
 * Operates in place on the messages array.
 */
function stripDanglingToolUse(messages) {
  // Walk from the end; drop a trailing assistant message that issued tool_calls
  // without a following tool_result. A trailing tool_result pairs with an
  // earlier assistant tool_use, so keep it (it orphans nothing).
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
      messages.pop();
      continue;
    }
    break;
  }
}

/**
 * Summarize a list of prior messages into a compact brief using the LLM so the
 * compressed context retains as much task-relevant information as possible.
 *
 * Includes tool results (file contents, bash output, KB hits) because those
 * carry the real work product; a raw user/assistant dump loses them entirely.
 * The caller falls back to naive truncation on any LLM error.
 */
async function summarizeConversation(llm, messages) {
  const parts = [];
  for (const m of messages) {
    let body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (m.role === 'tool') {
      body = `tool_result(${m.tool_call_id || '?'}): ${body}`;
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        body += `\n[tool_call ${tc.name}] ${typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {})}`;
      }
    }
    parts.push(`${m.role.toUpperCase()}: ${body}`);
  }
  const raw = parts.join('\n\n');
  // Cap the summarizer input so the summary call itself stays well within the
  // model context window (keep the most recent, most relevant tail).
  const input = raw.length > 48000 ? raw.slice(raw.length - 48000) : raw;
  const summary = await llm.complete([
    {
      role: 'system',
      content: 'You are a context-compaction assistant for an AI coding agent. Produce a dense, faithful summary that preserves everything the agent needs to continue: the user\'s goal, decisions made, completed work, files changed and their paths, code locations, constraints, errors and fixes, and any pending plan steps. Do not invent facts; if a detail is unclear, say "unclear".',
    },
    {
      role: 'user',
      content: `Summarize the following prior conversation into a compact brief the agent can use as background context:\n\n${input}`,
    },
  ], {
    maxChars: 12000,
    temperature: 0.1,
    enableReasoning: false,
    timeoutMs: 60000,
  });
  return (summary || '').trim();
}

/**
 * Context compaction: keep system + last N user/assistant turns verbatim,
 * summarize earlier ones (plus their tool results) into a single system message
 * via the LLM. Falls back to naive truncation if the LLM is unavailable or
 * errors. Preserves the leading system messages and any tool results that pair
 * with the retained tail (Anthropic requires every kept assistant tool_use to
 * be followed by its tool_result).
 *
 * Returns null if there are too few messages to compact.
 */
async function compactMessages(session) {
  const conversation = session.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (conversation.length < 6) return null;

  const keep = 4;   // keep the last 4 user/assistant turns verbatim
  const toCompact = conversation.slice(0, conversation.length - keep);
  const kept = conversation.slice(conversation.length - keep);

  // IMPORTANT: Anthropic requires every assistant tool_use to be immediately
  // followed by its tool_result. We must NOT drop a `tool` message whose
  // matching assistant tool_calls message is being kept verbatim, or the next
  // call 400s ("tool_use ids found without tool_result blocks"). Collect the
  // tool_call_ids emitted by any kept assistant turn and retain their `tool`
  // results in their original positions among the kept messages.
  const keptToolCallIds = new Set();
  for (const m of kept) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc.id) keptToolCallIds.add(tc.id);
    }
  }

  // Find where the kept tail begins in the full message list so we can carry
  // the trailing `tool` results forward alongside their assistant tool_calls.
  const keptStart = (() => {
    const firstKept = kept[0];
    return session.messages.indexOf(firstKept);
  })();

  // Classify the leading (pre-keptStart) system messages so compaction is
  // self-stabilizing across repeated auto-compacts, instead of stacking one
  // overlapping summary on top of another:
  //   - PRESERVE verbatim: the main system prompt + any other standing system
  //     messages (these carry persistent instructions, not turn-scoped state).
  //   - FOLD into the summary: a prior compaction's `## Prior conversation
  //     (compacted)` summary (it is superseded once re-summarized alongside
  //     the newer turns) and every turn-scoped `## Knowledge-base context for
  //     this turn` injection (those are stale by definition once their turn is
  //     compacted). Folding keeps the single compressed summary complete.
  const COMPACTED_HDR = '## Prior conversation (compacted)';
  const KBCONTEXT_HDR = '## Knowledge-base context for this turn';
  const foldable = new Set();
  const leadingSystem = [];
  if (keptStart >= 0) {
    for (let i = 0; i < keptStart; i++) {
      const m = session.messages[i];
      if (m.role !== 'system') continue;
      leadingSystem.push(m);
      const c = typeof m.content === 'string' ? m.content : '';
      if (c.startsWith(COMPACTED_HDR) || c.startsWith(KBCONTEXT_HDR)) {
        foldable.add(m);
      }
    }
  }

  // Collect the tool results that pair with the compacted (dropped) assistant
  // turns. They carry the real file/bash/KB output and must be fed to the
  // summarizer rather than silently discarded.
  const compactedToolResults = [];
  if (keptStart >= 0) {
    for (let i = 0; i < keptStart; i++) {
      const m = session.messages[i];
      if (m.role === 'tool' && m.tool_call_id && !keptToolCallIds.has(m.tool_call_id)) {
        compactedToolResults.push(m);
      }
    }
  }

  // Merge the compacted user/assistant turns with their tool results AND any
  // foldable leading system messages (prior summaries + stale per-turn KB
  // context), in their original conversation order.
  const toSummarize = [...toCompact, ...compactedToolResults, ...leadingSystem.filter(m => foldable.has(m))].sort((a, b) => {
    const ia = session.messages.indexOf(a);
    const ib = session.messages.indexOf(b);
    return (ia < 0 ? 0 : ia) - (ib < 0 ? 0 : ib);
  });

  let summaryText = null;
  if (session.llm) {
    try {
      summaryText = await summarizeConversation(session.llm, toSummarize);
    } catch {
      summaryText = null;
    }
  }
  if (!summaryText) {
    // Naive fallback: concatenate + truncate, now including tool results so we
    // don't silently drop them.
    summaryText = toSummarize
      .map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n\n');
  }

  // Build a fresh message list: leading standing system messages (the main
  // system prompt etc.), the new summary, then the kept tail WITH its matching
  // tool results preserved. Foldable leading system messages (prior
  // compaction summaries + stale per-turn KB context) are NOT copied verbatim
  // — they were folded into the summary above, so the compressed history stays
  // a single coherent block instead of stacking across repeated compactions.
  // `tool` messages before keptStart are likewise dropped (summarized above).
  const newMessages = [];
  for (let i = 0; i < (keptStart >= 0 ? keptStart : session.messages.length); i++) {
    const m = session.messages[i];
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') continue;
    if (foldable.has(m)) continue;  // superseded by the new summary below
    newMessages.push(m);
  }
  newMessages.push({
    role: 'system',
    content: `## Prior conversation (compacted)\nThe following is a summary of the previous ${toCompact.length} messages (and their tool results). Treat it as background context.\n\n${summaryText.slice(0, 12000)}${summaryText.length > 12000 ? '...(truncated)' : ''}\n`,
  });
  if (keptStart >= 0) {
    for (let i = keptStart; i < session.messages.length; i++) {
      const m = session.messages[i];
      // Keep every kept user/assistant turn verbatim, plus any `tool` result
      // that pairs with a retained assistant tool_call. Drop `tool` results
      // whose caller was compacted away (those are summarized above instead).
      if (m.role === 'tool') {
        if (m.tool_call_id && keptToolCallIds.has(m.tool_call_id)) newMessages.push(m);
        continue;
      }
      if (m.role === 'user' || m.role === 'assistant') newMessages.push(m);
    }
  }

  return { messages: newMessages, dropped: toCompact.length, kept: kept.length };
}

/**
 * Auto context compaction (HK2_ENABLE_AUTOCOMPACT, default 0): if the last
 * measured context size reached HK2_AUTOCOMPACT_PCTUSED% (default 90) of the
 * model's context window, compact the prior conversation at the turn boundary
 * so an in-flight turn is never interrupted.
 *
 * Runs only at the start of a new turn (before rewrite/retrieval/agent work),
 * using the snapshot captured at the previous turn's end. The tolerance comes
 * from only checking at this safe boundary — never mid-loop.
 */
async function maybeAutoCompact(session, ctx) {
  if (!envFlag('HK2_ENABLE_AUTOCOMPACT', 0)) return;
  const windowTokens = session.modelCfg?.maxChars || 0;
  if (!windowTokens) return;

  const pctUsed = envPercent('HK2_AUTOCOMPACT_PCTUSED', 90);
  const threshold = Math.floor(windowTokens * pctUsed / 100);
  const current = session.lastContextTokens || estimateMessagesTokens(session.messages);
  if (current < threshold) return;

  const out = await compactMessages(session);
  if (!out) return;

  session.messages = out.messages;
  session.lastContextTokens = estimateMessagesTokens(session.messages);
  await session.transcript?.logMeta('auto-compact', {
    beforeTokens: current,
    afterTokens: session.lastContextTokens,
    threshold,
    pctUsed,
    dropped: out.dropped,
    kept: out.kept,
  });
  ctx.print(`[auto-compact] context ${fmtTok(current)} ≥ ${fmtTok(threshold)} (${pctUsed}% of ${fmtTok(windowTokens)}) → compacted ${out.dropped} messages, kept ${out.kept}.`);
}

/**
 * Parse a 0/1 env flag. Returns defaultValue if unset; treats 0/no/false/off as false.
 */
function envFlag(name, defaultValue = 0) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return !!defaultValue;
  return /^(1|yes|true|on)$/i.test(v.trim());
}

/**
 * Parse an integer-percentage env var (0-100). Returns defaultValue if unset,
 * unparseable, or out of range (clamped to 1..100 so 0 can't disable the check
 * by accident).
 */
function envPercent(name, defaultValue = 90) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return defaultValue;
  const n = Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(1, Math.min(100, n));
}

/**
 * Estimate the input-token size of a message list (chars → tokens, ~4 chars
 * per token). Used as the fallback when the provider hasn't reported a real
 * usage value for the last call.
 */
function estimateMessagesTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (m.content) chars += JSON.stringify(m.content).length;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) chars += JSON.stringify(tc).length;
    }
  }
  return estimateTokensFromChars(chars);
}

// Note: bash search detection lives in lib/agent/tools.js's KbFirstGuard
// (_isBashSearch). interactive.js calls it via session.kbGuard for the
// end-of-turn KB-update suggestion.

/**
 * After a turn ends, if the agent used bash to grep/find/cat source files
 * (i.e. the KB didn't have what it needed), offer to update the three KB
 * spaces per their update policies:
 *
 *   Index Space  — auto with HK2_ENABLE_AUTOUPDATEKB=1; otherwise prompt y/N
 *   Eden Space   — auto with HK2_ENABLE_AUTO_LEARN=1;  otherwise prompt y/N
 *   Holy Space   — ALWAYS prompt y/N, regardless of env vars
 *
 * Why: Holy holds stable design knowledge; committing to it is a deliberate
 * user choice. Eden and Index can be auto-updated because their content is
 * either derivable (Index: re-derived from code) or transient (Eden: lists
 * that evolve with the codebase).
 */
export async function maybeOfferKbUpdate(session, ctx) {
  if (!session.project) return;
  if (!session.bashSearchCommands || session.bashSearchCommands.length === 0) return;

  const autoUpdate = envFlag('HK2_ENABLE_AUTOUPDATEKB', 0);
  const autoLearn = envFlag('HK2_ENABLE_AUTO_LEARN', 0);

  ctx.print('');
  ctx.print(`[kb hint] The agent used bash to search source files ${session.bashSearchCommands.length} time(s) during this turn.`);
  ctx.print('          This usually means the KB was missing some knowledge the agent needed.');

  // 1. Index Space — re-index the code
  if (autoUpdate) {
    await runKbUpdate(session, ctx);
  } else {
    const ok = await ctx.confirm('Run /kb update now to refresh Index Space? (y/N) ');
    if (ok) await runKbUpdate(session, ctx);
    else ctx.print('[kb hint] Skipped Index Space refresh. Run /kb update manually when ready.');
  }

  // 2. Eden / Holy — ask the model to extract what it learned, then route
  //    to the right space based on stability. The model itself decides
  //    whether the learned content is "stable" (Holy) or "frequently-updated"
  //    (Eden). Per-space policy then applies:
  //      - Eden + HK2_ENABLE_AUTO_LEARN=1 → auto-commit
  //      - Eden + HK2_ENABLE_AUTO_LEARN=0 → prompt y/N
  //      - Holy → ALWAYS prompt y/N (even with auto-learn)
  //    SKIPPED when the agent already saved knowledge via kb_save_knowledge
  //    this turn (or the user explicitly declined a proposal) — re-running
  //    the extraction would duplicate what was just learned. A session-level
  //    cooldown additionally covers follow-up turns of the same task and
  //    --resume'd sessions.
  if (session.kbSavedThisTurn) {
    const savedPart = session.kbSavedEntries.length > 0
      ? ` (${session.kbSavedEntries.map(e => `${e.space}:${e.id}`).join(', ')})`
      : '';
    const declinedPart = session.kbSavedEntries.length > 0
      ? ''
      : ' (you declined the proposal, nothing was written)';
    ctx.print(`[kb learn] skipped — knowledge was already captured via kb_save_knowledge this turn${savedPart}${declinedPart}.`);
    ctx.print('            Run /kb knowledge learn manually if you want a deeper study.');
    session.kbLearnHandledAt = Date.now();
  } else if (kbLearnInCooldown(session)) {
    ctx.print(`[kb learn] skipped — this session's knowledge was captured/answered ${Math.floor((Date.now() - session.kbLearnHandledAt) / 60000)} min ago (within the learn cooldown you enabled via HK2_KB_LEARN_COOLDOWN_MIN; unset it or set 0 to always ask).`);
    ctx.print('            Run /kb knowledge learn manually if you want a deeper study.');
  } else {
    await learnNewKnowledge(session, ctx, { autoLearn });
  }

  session.bashSearchCommands = [];
}

/**
 * Holy-over-Eden priority: end-of-task Eden sync.
 *
 * For every conflict recorded this turn (session.kbConflicts, populated by
 * runAgentTurn right after buildRequestGraph), stamp the Eden entry with
 * supersededBy = "holy:<id>" and prepend a supersession notice to its intro
 * so future readers know Holy is authoritative. Eden is the auto-updatable
 * space, so this runs WITHOUT a per-entry prompt (per the priority rule:
 * "以Holy为准 + 更新Eden + 提醒用户"); the final print is the reminder.
 * Best-effort: a failed write warns and continues to the next entry.
 *
 * Exported for unit tests (test/holy-eden-priority.test.js covers the tool
 * layer; this one is exercised via test/kb-priority-sync.test.js).
 */
export async function syncConflictingEden(session, ctx) {
  const conflicts = session.kbConflicts || [];
  if (conflicts.length === 0) return;
  if (!session.project || !session.rt) return;
  const projectId = session.project.id;
  const { readKnowledge, writeKnowledge } = await import('../../lib/store/kb_store.js');
  const synced = [];
  const failed = [];
  for (const c of conflicts) {
    if (!c?.eden?.id) continue;
    try {
      const entry = await readKnowledge(projectId, 'eden', c.eden.id);
      if (!entry) continue; // already deleted / moved — nothing to sync
      if (entry.supersededBy === `holy:${c.holy.id}`) { synced.push(c); continue; } // idempotent
      const updated = {
        ...entry,
        supersededBy: `holy:${c.holy.id}`,
        supersededAt: new Date().toISOString(),
        intro: `[Superseded by holy:${c.holy.id} — Holy Space takes precedence; follow the Holy entry "${c.holy.title}" instead.]\n\n${entry.intro || ''}`,
      };
      await writeKnowledge(projectId, 'eden', updated);
      const fresh = await readKnowledge(projectId, 'eden', c.eden.id);
      if (fresh) session.rt.reloadKnowledge?.(fresh, 'eden');
      synced.push(c);
    } catch (err) {
      failed.push({ c, err });
    }
  }
  session.kbConflicts = [];
  if (synced.length > 0) {
    ctx.print('');
    ctx.print(`${style.warning(style.ICON.warn + ' [kb priority]')} synced ${synced.length} Eden entr${synced.length === 1 ? 'y' : 'ies'} superseded by Holy:`);
    for (const c of synced) {
      ctx.print(`  - eden "${c.eden.title}" (${c.eden.id}) → supersededBy holy:${c.holy.id}`);
    }
    ctx.print(style.dim('  Eden entries keep their content but are marked superseded; Holy remains authoritative. Use /kb transform to move or /kb knowledge delete to remove them.'));
    await session.transcript?.logMeta('kb_priority_sync', {
      synced: synced.map(c => ({ eden: c.eden.id, holy: c.holy.id })),
    }).catch(() => {});
  }
  for (const { c, err } of failed) {
    ctx.print(`${style.warning('[kb priority]')} failed to sync eden "${c.eden.id}": ${err.message}`);
  }
}

/**
 * Cooldown gate for the end-of-turn [kb learn] fallback. Returns true when a
 * knowledge capture was handled recently enough that re-extracting the same
 * task would be redundant. OFF by default (0): the end-of-turn prompt always
 * reaches the user unless a positive window is explicitly configured — the
 * user, not a timer, decides when learning is done. The cooldown window is
 * memoized on the session so tests can override it deterministically.
 */
function kbLearnInCooldown(session) {
  const minutes = Number.parseFloat(String(process.env.HK2_KB_LEARN_COOLDOWN_MIN ?? '0').trim());
  const ms = (Number.isFinite(minutes) ? minutes : 0) * 60_000;
  session.kbLearnCooldownMs = ms;
  if (!Number.isFinite(minutes) || ms <= 0) return false;
  if (!session.kbLearnHandledAt || session.kbLearnHandledAt <= 0) return false;
  return Date.now() - session.kbLearnHandledAt < ms;
}

async function runKbUpdate(session, ctx) {
  ctx.print('[kb update] refreshing Index Space (incremental re-index)...');
  try {
    const { buildIndex } = await import('../../lib/index/indexer.js');
    const { markKbBuilt } = await import('../../lib/config/home.js');
    const { dropRuntime } = await import('../../lib/retrieval/kb_runtime.js');
    const stats = await buildIndex(session.project.id, { full: false });
    await markKbBuilt(session.project.id);
    dropRuntime(session.project.id);
    ctx.print(`[kb update] done: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.uniqueTokens} tokens, ${(stats.buildDurationMs / 1000).toFixed(1)}s`);
    ctx.noteReloadKb?.();
    return true;
  } catch (err) {
    ctx.print(`[kb update] failed: ${err.message}`);
    return false;
  }
}

/**
 * One-shot LLM call to extract a knowledge entry from the just-finished
 * conversation. The model itself decides whether the content belongs in
 * Holy Space (stable) or Eden Space (frequently-updated). Per-space policy
 * then decides whether to auto-commit or prompt the user.
 *
 * Holy ALWAYS prompts the user — even with HK2_ENABLE_AUTO_LEARN=1.
 */
async function learnNewKnowledge(session, ctx, { autoLearn }) {
  if (!session.llm) {
    ctx.print('[kb learn] no LLM available, skipping knowledge capture.');
    return;
  }
  const lastUser = [...session.messages].reverse().find(m => m.role === 'user');
  const lastAssistant = [...session.messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string');
  if (!lastUser || !lastAssistant) {
    ctx.print('[kb learn] no conversation to learn from, skipping.');
    return;
  }

  ctx.print('[kb learn] asking the model to summarize what it learned...');
  ctx.print(style.dim('          (one LLM call, up to ~1 min; you will be asked y/N before anything is written)'));

  const sysPrompt = `You are extracting a reusable knowledge note from a completed coding task so future tasks on the same project can skip the discovery work.

The project KB has two knowledge spaces:
- "holy": stable knowledge that rarely changes (design principles, key algorithms, fundamental patterns). Examples: "how to write a PostgreSQL extension", "how the WAL replay loop works".
- "eden": frequently-updated knowledge (function lists, command catalogs, observed patterns that may evolve). Examples: "list of common SQL commands", "frequently-used utility functions".

Output STRICT JSON only — no markdown fences, no prose. Schema:
{
  "space": "holy" | "eden",
  "id": "kebab-case-id",
  "title": "human-readable title",
  "intro": "2-5 paragraphs of prose explaining the concept; include key API names and call patterns",
  "keyFiles": ["project-relative file paths"],
  "keySymbols": ["exact function/type names"],
  "keywords": ["english keywords for future search"]
}

Pick "holy" only for genuinely stable design knowledge. Pick "eden" for things that may evolve.
The id "hk2-supreme-code" is reserved for the project's permanent Supreme Code — never propose it.
If the conversation did not produce any reusable knowledge (one-off fix, trivial), output: {"skip": true}`;

  const userPrompt = `Task that was just completed:
USER: ${typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)}

Bash search commands the agent used during this task (signaling KB gaps):
${session.bashSearchCommands.slice(0, 8).map(c => '- ' + c.split('\n')[0].slice(0, 200)).join('\n')}

Agent's final summary / explanation:
${(typeof lastAssistant.content === 'string' ? lastAssistant.content : '').slice(0, 4000)}`;

  let raw = '';
  for await (const evt of session.llm.stream(
    [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.1, maxChars: 8192, enableReasoning: false, timeoutMs: 60000 },
  )) {
    if (evt.type === 'delta') raw += evt.text;
  }

  let parsed = null;
  try { parsed = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed || parsed.skip) {
    ctx.print('[kb learn] the model declined to save a knowledge entry (no reusable knowledge identified).');
    // The extraction ran and concluded there is nothing to save — re-running
    // it for follow-up turns of the same task would just burn another minute.
    session.kbLearnHandledAt = Date.now();
    return;
  }

  const space0 = parsed.space === 'eden' ? 'eden' : 'holy';
  let space = space0;
  let id = String(parsed.id || 'learned').replace(/[^A-Za-z0-9_.-]/g, '_');
  // The supreme-code entry is permanent and managed ONLY via /kb code add|del.
  // The learn flow must never overwrite it — not even with user confirmation.
  {
    const { isSupremeCode } = await import('../../lib/store/supreme_code.js');
    if (isSupremeCode(id)) {
      ctx.print('[kb learn] refused: "hk2-supreme-code" is the permanent Supreme Code entry — manage it via /kb code add | /kb code del.');
      session.kbLearnHandledAt = Date.now();
      return;
    }
  }
  const record = {
    id,
    space,
    title: parsed.title || 'Learned knowledge',
    intro: parsed.intro || '',
    keyFiles: Array.isArray(parsed.keyFiles) ? parsed.keyFiles : [],
    keySymbols: Array.isArray(parsed.keySymbols) ? parsed.keySymbols : [],
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    autoLearned: true,
  };

  // ================= Validation against the existing KB =================
  // Before any write, check the KB for (a) the same meaning (skip — no
  // re-learning), (b) a related entry this knowledge should UPDATE in
  // place (merge onto it), (c) a direct contradiction (conflict — Holy
  // conflicts are ALWAYS decided by the user; Eden conflicts follow the
  // validator's winner + stated reason), or (d) nothing related (new —
  // when related entries exist, state why we are NOT updating them).
  // Best-effort: any validation failure falls through as 'new' so the
  // normal per-space confirmation path still runs. Gate:
  // HK2_KB_LEARN_VALIDATE (default on, set 0 to disable).
  let preApproved = false;
  let validateInfo = null;
  if (envFlag('HK2_KB_LEARN_VALIDATE', 1)) {
    const { listKnowledge } = await import('../../lib/store/kb_store.js');
    const { findCandidateEntries, validateLearnedEntry } = await import('../../lib/agent/kb_validate.js');
    const { isSupremeCode } = await import('../../lib/store/supreme_code.js');
    const holyList = await listKnowledge(session.project.id, 'holy').catch(() => []);
    // Eden entries stamped supersededBy="holy:*" are RETIRED (Holy takes
    // precedence — the same exclusion buildRequestGraph applies). Never merge
    // onto or conflict with a retired entry: writing it back would silently
    // strip the stamp and resurrect it into retrieval.
    const edenList = (await listKnowledge(session.project.id, 'eden').catch(() => []))
      .filter(e => !e.supersededBy);
    const candidates = findCandidateEntries(record, holyList, edenList);
    if (candidates.length > 0) {
      ctx.print('');
      ctx.print(style.dim(`[kb learn validate] ${candidates.length} related entr${candidates.length === 1 ? 'y' : 'ies'} found (${candidates.slice(0, 3).map(c => `${c.space}:${c.entry.id}`).join(', ')}${candidates.length > 3 ? ' ...' : ''}) — validating...`));
    }
    const verdict = await validateLearnedEntry(session.llm, record, candidates, { timeoutMs: 60000 });
    validateInfo = { validation: verdict.verdict, validatedAgainst: verdict.targetId };

    if (verdict.verdict === 'duplicate') {
      // Same or essentially the same meaning already in the KB — skip the
      // write entirely to avoid duplicate learning.
      ctx.print(`[kb learn] skipped — the KB already contains the same knowledge ("${verdict.targetId}").`);
      ctx.print(`  reason: ${verdict.reason || '(not provided)'}`);
      session.kbLearnHandledAt = Date.now();
      return;
    }

    const cand = candidates.find(c => c.entry.id === verdict.targetId);
    if (cand && isSupremeCode(cand.entry.id)) {
      // The permanent Supreme Code entry can never be a merge/conflict
      // target: a redirected write would drop its `codes` array and the
      // protected flags. Managed ONLY via /kb code add | /kb code del.
      ctx.print(`[kb learn] refused: the validator targeted "${cand.entry.id}" — that is the permanent Supreme Code entry, managed only via /kb code add | /kb code del.`);
      session.kbLearnHandledAt = Date.now();
      return;
    }

    if (verdict.verdict === 'update' && cand) {
      // Related entry covers the same topic — merge onto it instead of
      // creating a near-identical sibling. The write keeps the existing
      // entry's id + space; createdAt is carried over explicitly below
      // (writeKnowledge only preserves it when the record already has one).
      ctx.print(`[kb learn validate] "${verdict.targetId}" covers the same topic — merging into it instead of creating a sibling entry.`);
      ctx.print(`  reason: ${verdict.reason || '(not provided)'}`);
      id = cand.entry.id;
      record.id = cand.entry.id;
      space = cand.space;
      record.space = cand.space;
      record.title = cand.entry.title || record.title;
      record.intro = verdict.mergedIntro;
      record.createdAt = cand.entry.createdAt; // keep the original creation time
      record.spaceChangedAt = cand.entry.spaceChangedAt; // in-place merge must not reset the space-change time
      record.keywords = [...new Set([...(cand.entry.keywords || []), ...record.keywords])];
      record.keyFiles = [...new Set([...(cand.entry.keyFiles || []), ...record.keyFiles])];
      record.keySymbols = [...new Set([...(cand.entry.keySymbols || []), ...record.keySymbols])];
      record.updatedByLearn = true;
    } else if (verdict.verdict === 'conflict' && cand) {
      // Direct contradiction with an existing entry.
      ctx.print(`${style.warning(style.ICON.warn + ' [kb learn validate]')} the new entry CONFLICTS with ${cand.space}:"${verdict.targetId}":`);
      ctx.print(`  existing: ${(cand.entry.intro || '').replace(/\s+/g, ' ').slice(0, 160)}${(cand.entry.intro || '').length > 160 ? '...' : ''}`);
      ctx.print(`  proposed: ${(record.intro || '').replace(/\s+/g, ' ').slice(0, 160)}${(record.intro || '').length > 160 ? '...' : ''}`);
      ctx.print(`  validator verdict: ${verdict.conflictWinner === 'new' ? 'the NEW entry wins' : 'the EXISTING entry wins'}. reason: ${verdict.reason || '(not provided)'}`);
      if (cand.space === 'holy') {
        // Holy conflicts are ALWAYS decided by the user — Holy Space is
        // the source of truth and every write needs explicit approval.
        const apply = await ctx.confirm(`Update holy entry "${verdict.targetId}" with the new knowledge (new wins)? (y/N) `);
        if (!apply) {
          ctx.print('[kb learn] skipped — keeping the existing Holy entry (original wins).');
          session.kbLearnHandledAt = Date.now();
          return;
        }
        id = cand.entry.id;
        record.id = cand.entry.id;
        space = 'holy';
        record.space = 'holy';
        record.title = cand.entry.title || record.title;
        record.createdAt = cand.entry.createdAt; // keep the original creation time
        record.spaceChangedAt = cand.entry.spaceChangedAt; // in-place update: keep the original space-change time
        record.updatedByLearn = true;
        validateInfo.conflictResolvedBy = 'user';
        preApproved = true; // the user just approved this exact write
      } else if (verdict.conflictWinner === 'existing') {
        ctx.print('[kb learn] skipped — the existing entry wins the conflict (the new extraction looked stale or wrong).');
        session.kbLearnHandledAt = Date.now();
        return;
      } else {
        // Eden-vs-Eden, new wins: write the new entry and surface the old
        // one for manual cleanup (no auto-supersede across eden entries).
        ctx.print(`  The new entry is written; the contradicting eden entry "${verdict.targetId}" is kept — review it with /kb knowledge show and remove via /kb knowledge del if stale.`);
      }
    } else if (candidates.length > 0) {
      // verdict new, but related entries exist — state why we are NOT
      // updating them (required explanation for not updating in place).
      ctx.print(style.dim(`[kb learn validate] creating a NEW entry — not updating the related entr${candidates.length === 1 ? 'y' : 'ies'} (${candidates.slice(0, 3).map(c => `${c.space}:${c.entry.id}`).join(', ')}).`));
      ctx.print(style.dim(`  reason: ${verdict.reason || '(no reason provided)'}`));
    }
  }

  // Per-space policy
  let commit = false;
  if (space === 'holy') {
    if (preApproved) {
      // Conflict path: the user already approved this exact write above.
      commit = true;
    } else {
    // Holy ALWAYS prompts — even with HK2_ENABLE_AUTO_LEARN=1.
    // y/N/E tri-state (per the KB-priority rule): E saves this NEW entry to
    // Eden instead of Holy. Only offered when the id does NOT already exist
    // in Holy (an update keeps the plain y/N contract — same as
    // toolKbSaveKnowledge).
    const { readKnowledge: rk } = await import('../../lib/store/kb_store.js');
    const existingHoly = await rk(session.project.id, 'holy', id).catch(() => null);
    const isNewHoly = !existingHoly;
    ctx.print('');
    ctx.print(`[kb learn] Model proposes HOLY entry "${id}": ${record.title}`);
    ctx.print(`  intro (preview): ${(record.intro || '').slice(0, 200)}${(record.intro || '').length > 200 ? '...' : ''}`);
    ctx.print(`  Note: Holy Space is the stable source of truth. Updates require explicit approval even with HK2_ENABLE_AUTO_LEARN=1.`);
    let answer;
    if (isNewHoly) {
      ctx.print(style.dim('  E = save this entry to Eden space instead of Holy.'));
      answer = await confirmThreeWay(session, `Commit "${id}" to Holy Space? (y/N/E) `);
    } else {
      answer = await ctx.confirm(`Commit to Holy Space? (y/N) `);
    }
    if (answer === 'eden') {
      // Redirect to Eden without re-confirming — the user's single answer IS
      // the approval for the Eden write (same contract as knowledgeConfirm).
      space = 'eden';
      record.space = 'eden';
      commit = true;
      ctx.print(style.accent('  Redirected — saving to Eden space instead.'));
    } else {
      commit = answer === true;
    }
    } // end non-preApproved holy path
  } else {
    // Eden: auto-commit if autoLearn, else prompt
    if (autoLearn) {
      commit = true;
    } else {
      ctx.print('');
      ctx.print(`[kb learn] Model proposes EDEN entry "${id}": ${record.title}`);
      ctx.print(`  intro (preview): ${(record.intro || '').slice(0, 200)}${(record.intro || '').length > 200 ? '...' : ''}`);
      commit = await ctx.confirm(`Commit to Eden Space? (y/N) `);
    }
  }

  if (!commit) {
    ctx.print('[kb learn] Cancelled. Nothing was written.');
    // The user SAW the proposal and declined — treat as handled so follow-up
    // turns don't re-prompt for the same knowledge.
    session.kbLearnHandledAt = Date.now();
    return;
  }

  // Persist
  const { writeKnowledge } = await import('../../lib/store/kb_store.js');
  const p = await writeKnowledge(session.project.id, space, record);
  // Reload into runtime so subsequent kb_knowledge / kb_search_knowledge sees it
  const { readKnowledge } = await import('../../lib/store/kb_store.js');
  const final = await readKnowledge(session.project.id, space, id);
  if (final) session.rt?.reloadKnowledge?.(final, space);

  ctx.print(`[kb learn] saved ${space} entry "${id}": ${record.title}`);
  ctx.print(`            path: ${p}`);
  session.kbLearnHandledAt = Date.now();
  await session.transcript?.logMeta('learned_knowledge', { id, space, title: record.title, ...(validateInfo || {}) });
}


