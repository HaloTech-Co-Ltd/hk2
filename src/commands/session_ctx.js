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
 * Session state + the slash-command `ctx` — shared by every front-end
 * (line REPL today, TUI next). Extracted from interactive.js.
 *
 * The seam: `buildBaseCtx(session, io)` takes an `io` object supplying the
 * three prompt primitives a UI must own:
 *
 *   io.print(text)                        one line of output
 *   io.confirm(promptText)   -> boolean   y/N (re-prompts on garbage)
 *   io.choose(promptText, options) -> 1-based index
 *
 * The line REPL passes `replIo(session)` (readline consumeNext mechanics,
 * byte-identical to the original buildCtx); the TUI passes a modal-backed
 * implementation. Everything else on ctx (model/project/KB accessors,
 * streamLLM, session lifecycle) is UI-agnostic and lives here unchanged.
 */
import fs from 'node:fs/promises';
import { getCurrentProject, getProject, setCurrentProject, resolveDefaultModel, resolveModelRef } from '../../lib/config/home.js';
import { getRuntime } from '../../lib/retrieval/kb_runtime.js';
import { LLMClient } from '../../lib/llm/client.js';
import { KbFirstGuard } from '../../lib/agent/tools.js';
import { getMcpTools, invalidateMcpTools, invalidateAllMcpTools } from '../../lib/agent/mcp.js';
import { resetPermissionService } from '../../lib/config/setting.js';
import { getKbMeta } from '../../lib/index/registry.js';
import Transcript, { replayTranscript, findLatestSessionId, findSessionProject, isValidSessionId } from '../../lib/agent/transcript.js';
import { saveTaskState, loadTaskState } from '../../lib/agent/task_state.js';
import { exists } from '../../lib/util/fs_atomic.js';
import { toolCardToken } from '../../lib/agent/tool_theme.js';
import * as style from '../../lib/agent/style.js';
import { safeParseArgs, toolHeader, formatPlanProgressLines, digestLine, plainPlanLines } from './status_format.js';
import { compactMessages, collectWorkingTreeDiff, estimateMessagesTokens, applyCompactTokenEstimate } from './turn_support.js';

/**
 * Build a bare session object (no readline / status bar). Shared by
 * interactive(), the TUI front-end, and the multi-session isolation tests so
 * the pin logic is exercised against the exact same shape the REPL uses.
 *
 * `pinnedProjectId` is null for a bare launch (resolved from global current
 * on first reload) or a project id for `--project=<...>` launches.
 */
export function createSession(pinnedProjectId = null) {
  const base = {
    project: null,
    pinnedProjectId,
    // True when the pin came from an EXPLICIT --project/--project-id launch
    // (not from a bare launch snapshotting the global current). A dead
    // explicit pin must NEVER silently switch codebases (review round 5).
    explicitProject: pinnedProjectId !== null && pinnedProjectId !== undefined,
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
    // the turn pipeline injects this as a system message so the LLM can rebuild
    // "what was I doing, which step, what's next" instead of seeing a bare
    // continuation cue with no memory. Mirrored to disk via task_state.js so
    // a process restart (not just an in-session error) can also recover.
    lastTask: null,
    // True right after a session resume: the replayed history contains no
    // system prompt (replayTranscript skips system_prompt events — it must be
    // rebuilt with the CURRENT tool list), so the turn pipeline inserts a fresh
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
    // Mid-task user input: while the turn pipeline is active, non-slash input
    // is captured here (FIFO) instead of session.queue, and injected into the
    // RUNNING conversation at the agent loop's round boundary (after all
    // tool_calls of the current round complete, before the next LLM call) —
    // see runLoop's onRoundBoundary. Slash commands are NOT captured; they
    // keep the legacy behavior of waiting for the turn to end, because they
    // may mutate session state (model / KB / project) the in-flight turn
    // still depends on. Menu input (session.consumeNext) is checked BEFORE
    // enqueue in the rl line handler, so plan/confirm menus are unaffected.
    userInputQueue: [],
    // True while the agent turn is executing (armed at turn start, disarmed in
    // its finally). enqueue() consults this to decide whether to capture.
    agentTurnActive: false,
    // ── Mid-task instruction input box (ported from main ad4765d) ──
    // While agentTurnActive is true the StatusBar reserves one line above the
    // plan panel / status bar as a persistent input box; the user's readline
    // buffer is echoed THERE (native echo would be trampled by streaming
    // output). inputEchoOn gates the redirect; slash commands and in-run
    // menus flip it off so their own echo lands at the cursor.
    inputEchoOn: false,
    // Arm/disarm callbacks, installed by the REPL front-end once the status
    // bar + readline exist; optional-chained everywhere so headless sessions
    // and the TUI (which has its own input box) are unaffected.
    armInputBox: null,
    disarmInputBox: null,
    // The CURRENT turn's ProgressIndicator, published by runTurn so the
    // enqueue() receipt writer can breakLine() before printing — without it
    // the receipt glues onto a spinner frame. Null when idle.
    progress: null,
  };

  // `consumeNext` accessor: when an in-run menu seizes the input WHILE the
  // mid-task input box is echoing, any unsubmitted readline draft must not
  // prepend itself to the menu answer. On the null -> cb transition the
  // draft is salvaged into the mid-task queue (exactly where it would have
  // gone had the user pressed Enter) and the buffer cleared. With the box
  // off the setter is a plain assignment — byte-identical to before.
  let consumeNextCb = null;
  Object.defineProperty(base, 'consumeNext', {
    configurable: true,
    enumerable: true,
    get: () => consumeNextCb,
    set: (cb) => {
      if (cb && !consumeNextCb && base.inputEchoOn && base.rl) {
        const draft = String(base.rl.line || '');
        if (draft.trim()) {
          if (!Array.isArray(base.userInputQueue)) base.userInputQueue = [];
          base.userInputQueue.push(draft);
        }
        base.rl.line = '';
        base.rl.cursor = 0;
      }
      // Real-cursor docking handoff (ported from main 7b7bb97/7ea3d2d):
      // arming a menu while the cursor is docked in the mid-task input box
      // hands the cursor back to the workspace (8 restore) so the menu's
      // prompt + native echo land at the workspace continuation —
      // byte-identical to pre-docking behaviour. Releasing after the menu's
      // final Enter adopts the cursor's current position as the NEW
      // continuation slot and re-docks. ORDER MATTERS: undock runs BEFORE
      // the flip (gated on the docked flag only), but reanchor MUST run
      // AFTER consumeNextCb is cleared — parkSeq() consults the dock column
      // fn, which reads session.consumeNext through this very getter; called
      // pre-flip it still saw the armed menu and silently no-opped, leaving
      // the DECSC slot stale until the next poll (the glued follow-up
      // prompt bug).
      const releasing = !cb && !!consumeNextCb;
      if (cb && !consumeNextCb) base.statusBar?.undockInputCursor?.();
      consumeNextCb = cb || null;
      if (releasing) base.statusBar?.reanchorAfterMenu?.();
    },
  });
  return base;
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
export function userMarkerLines(text) {
  const raw = String(text ?? '').replace(/\r/g, '').split('\n');
  return raw.map((l, i) => (i === 0 ? `you: ${l}` : `     ${l}`));
}

/** Every line of a reply, verbatim — no clamping, no truncation, no ellipsis. */
export function allLines(text) {
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
 * @param {object} session the live session
 * @param {string|null} sessionId explicit id, or null for "the project's
 *   latest session" (excludes the file this session is currently writing)
 * @returns {Promise<boolean>} true on success; false = not found / no project
 */
export async function resumeSessionInto(session, sessionId) {
  // Session ids are flat tokens everywhere — reject traversal BEFORE any
  // path is built (CLI --resume, /resume, /session resume share this).
  if (sessionId && !isValidSessionId(sessionId)) return false;
  // Resolve the owning project: the CURRENT project's dir first, then a
  // cross-project fallback — /project drop must not strand the session the
  // exit hint points at (the transcript on disk is still resumable).
  let pid = session.project?.id || null;
  if (sessionId && pid) {
    const t = new Transcript(pid, sessionId);
    if (!await exists(t.path)) pid = null; // not under the current project
  }
  if (sessionId && !pid) {
    pid = await findSessionProject(sessionId);
  }
  let id = sessionId;
  if (!id) {
    if (!session.project) return false;
    id = await findLatestSessionId(session.project.id, {
      // NEVER pick the session this process just created / is writing — that
      // would resume "now" (an empty history). At launch time reloadAll has
      // already written the fresh transcript's session_start line to disk,
      // so without this exclusion a bare `hk2 --resume` would find the
      // brand-new empty session as the "latest". requireContent additionally
      // skips OTHER boot-only empties (launch + quit without a message).
      exclude: session.transcript?.sessionId,
      requireContent: true,
    });
    if (!id) return false;
    pid = session.project.id;
  }
  if (!pid) return false;
  const t = new Transcript(pid, id);
  if (!await exists(t.path)) return false;

  // [P0 fix] Unify project ownership BEFORE replaying: the conversation
  // must execute in the OWNER project's context (KB, tools, permissions),
  // never in whatever project happened to be current. If the owner is
  // still registered → pin + load it. If it was dropped → run with NO
  // project (KB-optional chat) rather than borrowing the current one.
  if (pid !== session.project?.id) {
    session.resumedFromOtherProject = pid;
    const owner = await getProject(pid);
    if (owner) {
      session.pinnedProjectId = pid;
      session.project = owner;
      session.rt = null;
      session.kbMeta = null;
      if (owner.sourcePath) process.env.HK2_PROJECT_SOURCE = owner.sourcePath;
      try { session.rt = await getRuntime(pid); session.kbMeta = await getKbMeta(pid); }
      catch { session.rt = null; }
    } else {
      // Owner deregistered: NO project context — not the current project's.
      session.project = null;
      session.rt = null;
      session.kbMeta = null;
      delete process.env.HK2_PROJECT_SOURCE;
    }
    resetPermissionService();
    if (session.reloadFlags) {
      session.reloadFlags.project = false; // already reloaded here
      session.reloadFlags.kb = false;
      session.reloadFlags.model = !session.sessionModelRef; // re-resolve default unless session-pinned
    }
  }
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
  // is treated as a fresh request, which is correct.) Keyed on the OWNER
  // project id `pid` — NOT session.project — so a session whose owner project
  // was deregistered (session.project === null now) still recovers its
  // interrupted task/planProgress.
  const saved = await loadTaskState(pid);
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
 * Same readline mechanics as replIo.confirm (consumeNext + close-fallback),
 * but additionally accepts e/eden which resolves to the string 'eden'.
 * Unrecognized or empty input re-prompts; Ctrl+D / closed rl resolves false.
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

/**
 * The line-REPL implementation of the `io` prompt primitives — readline
 * consumeNext mechanics writing to stderr, byte-identical to the original
 * buildCtx bodies. The TUI supplies its own io; this one keeps the REPL
 * exactly as it was.
 */
export function replIo(session) {
  return {
    print: (text) => console.error(text),
    /** Streaming partial-line output — the REPL writes it to stdout. */
    write: (text) => process.stdout.write(text),
    /** Tri-state y/N/E prompt routed to the shared readline implementation. */
    confirmThreeWay: (promptText) => confirmThreeWay(session, promptText),
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
  };
}

/**
 * Consume any pending session.reloadFlags RIGHT NOW (used by the resume
 * paths). The enqueue loops also drain the flags after each line, but a
 * resume that arms them (a cross-project switch flags `model` unless the
 * session pins one) must not wait for the FIRST post-resume message to be
 * answered — that first turn would run on the OLD project's model, MCP
 * tools, and context window.
 * @returns {boolean} true when a reload actually ran
 */
export async function flushSessionReloads(session, ctx) {
  const f = session.reloadFlags || {};
  if (!f.project && !f.kb && !f.model) return false;
  await reloadAll(session, ctx, { project: !!f.project, kb: !!f.kb, model: !!f.model });
  session.reloadFlags = { project: false, kb: false, model: false };
  return true;
}

/**
 * Build the slash-command ctx for `session`. `io` supplies the UI-owned
 * prompt primitives (print/confirm/choose/write); pass `replIo(session)`
 * for the line REPL (the historical behavior) or a modal-backed io under
 * the TUI.
 */
export function buildBaseCtx(session, io) {
  const ctx = {
    print: io.print,
    /**
     * Raw character-stream primitive: streaming renderers (MarkdownStream /
     * ReasoningSink in /review, /kb learn) push PARTIAL lines through here.
     * The REPL maps it to stdout; the TUI routes it through its Frame so
     * nothing can bypass the reserved input region. Slash commands must use
     * this instead of process.stdout.write (guarded by test).
     */
    write: io.write ?? ((text) => process.stdout.write(text)),
    confirm: io.confirm,
    /** y/N/E tri-state (Holy-save redirect); falls back to plain confirm when the io has none. */
    confirmThreeWay: io.confirmThreeWay ?? io.confirm,
    choose: io.choose,
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
        // An explicit /project set is as deliberate as --project: if THAT
        // project is later dropped, never silently switch to another.
        session.explicitProject = true;
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
      // Front-ends that own the screen (the TUI) redraw on a cleared context.
      io.onCleared?.();
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
      // (excluding the one this session is currently writing to).
      const ok = await resumeSessionInto(session, sessionId || null);
      // A cross-project resume arms reloadFlags (model unless session-pinned).
      // Consume them NOW: the first post-resume message must already run on
      // the owner project's model/MCP config, not the one left in session.llm.
      if (ok) await flushSessionReloads(session, ctx);
      return ok;
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
      const preEstimate = estimateMessagesTokens(session.messages);
      const out = await compactMessages(session);
      if (out == null) {
        console.error(`(nothing to compact yet)`);
        return;
      }
      session.messages = out.messages;
      // PRE-compact estimate captured above (before the swap; compactMessages
      // builds a fresh array and never mutates session.messages). Calibrate
      // the post-compact estimate against it (see applyCompactTokenEstimate
      // in turn_support.js) so the bar and the next auto-compact check
      // reflect the compacted context instead of freezing on the old peak.
      applyCompactTokenEstimate(session, preEstimate);
      await session.transcript?.logMeta('compact', { dropped: out.dropped, kept: out.kept, estTokens: session.lastContextTokens });
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
  return ctx;
}

/** Historical one-argument form: the line-REPL ctx (replIo mechanics). */
export function buildCtx(session) {
  return buildBaseCtx(session, replIo(session));
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
      if (!p) {
        // Dead pin: the pinned project was dropped (another session ran
        // /project drop). Whether adopting the global current is acceptable
        // depends on the session's PROVENANCE — silently moving an explicit
        // --project=A launch (or a live conversation) onto project B would
        // run its tools and KB against the wrong codebase:
        //   - bare launch with no messages yet: adopt current like a fresh
        //     boot (the pin was just a snapshot; nothing has happened on it)
        //   - explicit --project launch, a conversation already in flight,
        //     or a session resumed from the dropped project: clear the
        //     project context and say so — attaching is the user's call.
        const hasConversation = (session.messages?.length || 0) > 0;
        if (!session.explicitProject && !hasConversation && !session.resumedFromOtherProject) {
          p = await getCurrentProject();
          if (p) session.pinnedProjectId = p.id;
        } else {
          session.pinnedProjectId = null;
          ctx?.print?.(`[project] the pinned project is no longer registered — no project attached. Attach one with /project set current <id|name>, or /project init.`);
        }
      }
    } else {
      p = await getCurrentProject();
      if (p) session.pinnedProjectId = p.id;
    }
    session.project = p;
    if (session.project && session.project.sourcePath) {
      process.env.HK2_PROJECT_SOURCE = session.project.sourcePath;
      // The permission singleton captured the PREVIOUS project root (and its
      // setting.json rules) at first use; drop it so the next check re-reads
      // the new project's rules and defaults. Without this, a /project switch
      // keeps enforcing the OLD project's permissions for the rest of the
      // session. (Ported from main 671303e during the TUI-branch merge.)
      resetPermissionService();
    } else if (process.env.HK2_PROJECT_SOURCE) {
      // No project resolved: drop any HK2_PROJECT_SOURCE inherited from the
      // launching shell so the permission roots shrink back to cwd only.
      delete process.env.HK2_PROJECT_SOURCE;
      resetPermissionService();
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
      const saved = session.project ? await loadTaskState(session.project.id) : null;
      if (saved && saved.userRequest) {
        session.lastTask = {
          userRequest: saved.userRequest,
          capturedAt: saved.interruptedAt,
          restored: true,
        };
        // Restore the live progress panel too, so the user sees where the
        // interrupted task left off as soon as the session comes up.
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

/* ------------------------------------------------------------------ */

/**
 * Detect whether a trimmed user line is a short continuation cue
 * ("continue" / "请继续" / "go ahead" / ...) rather than a fresh task.
 *
 * Used by handleLine to decide whether to keep the live planProgress block
 * (a continuation preserves the in-flight plan; a fresh prompt clears it)
 * and by the turn pipeline to inject interruption-recovery context. Supports
 * both English and Chinese cues - without the Chinese branch, a 中文 "请继续"
 * after an interrupted task used to be misclassified as a new task, wiping
 * the live planProgress and leaving the progress panel empty.
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
 * the turn pipeline's finally AND by its early-cancel paths that return
 * before the try block begins (clarification cancel) — every exit from a turn
 * that armed `agentTurnActive` must disarm it, or enqueue() would keep
 * capturing (and silently swallowing) all subsequent plain input. Exported
 * for unit testing.
 */
export function disarmMidTaskCapture(session) {
  if (!session) return [];
  session.agentTurnActive = false;
  return flushMidTaskQueue(session);
}

/**
 * Move any still-queued mid-task instructions back onto the normal input
 * queue. Called from the turn pipeline's finally when the turn ended before a
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

  // 1) In-flight task. On a fresh (non-continuation) turn the pipeline has
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
