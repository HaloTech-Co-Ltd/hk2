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
 * 商标和商号相关的商誉、设计和专利；与创新，技术诀窍、商业秘密、保密技术、非
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
 * The TUI implementation of the turn `ui` interface (the counterpart of
 * src/commands/repl_ui.js). All rendering goes through the Frame (single
 * writer, cursor-safe); all prompts go through the ModalHost. The status
 * line animates via the Frame's animateWhen refresh (only while a turn is
 * active — an idle frame writes nothing), so the ProgressIndicator dance is
 * a no-op shim that only tracks `.phase` — turn.js reads it for idempotence
 * guards. Markdown/reasoning styling reuses the same MarkdownStream /
 * ReasoningStream so the transcript looks identical to the REPL.
 */
import { MarkdownStream } from '../../lib/agent/markdown.js';
import { ReasoningStream } from '../../lib/agent/reasoning_stream.js';
import * as style from '../../lib/agent/style.js';
import { userMarkerLines } from '../commands/session_ctx.js';
import { compactToolHeader, compactToolResult, toolDisplayName, fullResultLines } from '../commands/tool_card.js';

/**
 * Open a modal prompt and KEEP THE FRAME IN SYNC: a redraw is requested the
 * moment the modal is queued (it must become visible while the pipeline
 * awaits the answer) and again when it resolves (the block disappears /
 * advances to the next queued prompt).
 */
function promptViaModal(frame, modalHost, kind, spec) {
  frame.requestRender();
  const p = modalHost.open(kind, spec);
  p.then(() => frame.requestRender(), () => frame.requestRender());
  return p;
}

export function makeTuiUi(frame, session, modalHost, hooks = {}) {
  let md = null;       // per-LLM-call markdown renderer
  let reasoning = null; // per-LLM-call reasoning renderer (live mode only)
  // HK2_HIDE_THINKING=0 restores the LIVE reasoning stream (same env var as
  // the REPL's 9-line window, README-documented). Default: thinking stays
  // hidden while it runs and collapses to one 'Thought for Ns' line — the
  // live preview rendered poorly and nobody reads it mid-turn.
  const showReasoningLive = () =>
    (process.env.HK2_HIDE_THINKING ?? '').trim() === '0';
  /** wall-clock start per tool call id → per-call duration in toolEnd */
  const toolStarts = new Map();
  /** most recent tool result, for the Ctrl+O expand */
  let lastTool = null;

  // Shared UI state rendered by the frame's 'thinking' block (see
  // src/tui/index.js): { active, lines: last<=2 source lines, since }.
  const uiState = { thinking: { active: false, lines: [], since: 0 } };

  // ProgressIndicator-compatible shim: state only, no \r writes (the status
  // block already animates itself). `.phase` mirrors the real indicator's
  // transitions so the guarded ui.phase() calls in turn.js stay idempotent.
  const progress = {
    phase: null,
    stopped: false,
    midLine: false,
    start(p) { this.phase = p; },
    nextPhase(p) { this.phase = p; },
    reason() { if (this.phase && this.phase !== 'thinking') this.phase = 'thinking'; },
    resume(p) { this.stopped = false; this.phase = p; },
    pause() { this.phase = null; },
    stop() { this.phase = null; this.stopped = true; },
    tick() { this.stopped = true; },
    done() { this.phase = null; },
    breakLine() { /* no spinner line to break */ },
  };

  // Thinking is HIDDEN while it runs (user call: the live preview rendered
  // poorly and nobody reads it) — the footer's 'thinking' phase spinner is
  // the only live signal. When the window ends, ONE dim 'Thought for Ns'
  // line lands in the transcript. Reasoning deltas only mark the window
  // active and time it.

  // Answers render as PLAIN streaming text (current Claude Code style) —
  // no bullet opener on prose. The ● bullet belongs to TOOL lines only
  // (compactToolHeader); a bullet on every response made conversations
  // visually noisy.
  const emit = (rendered) => {
    if (!rendered) return;
    frame.write(rendered);
  };

  const stream = {
    reset() {
      // Table width MUST match the visible box width — an unconstrained
      // stream renders tables at natural width (150+ cols), which the
      // terminal hard-wraps into visual chaos.
      md = new MarkdownStream({ width: (hooks.contentWidth ? hooks.contentWidth() : undefined) });
      reasoning = showReasoningLive() ? new ReasoningStream() : null;
      uiState.thinking.active = false;
      uiState.thinking.since = 0;
    },
    delta(text) {
      emit(md ? md.feed(text) : text);
    },
    reasoning(text) {
      if (!text) return;
      if (!uiState.thinking.active) {
        uiState.thinking.active = true;
        uiState.thinking.since = Date.now();
      }
      // Live mode (HK2_HIDE_THINKING=0): render the reasoning stream through
      // the Frame exactly like the REPL does.
      if (reasoning) {
        const rendered = reasoning.feed(text);
        if (rendered) frame.write(rendered);
      }
    },
    flushReasoning() {
      if (reasoning) {
        const tail = reasoning.end();
        reasoning = null;
        if (tail) frame.write(tail);
        uiState.thinking.active = false;
        uiState.thinking.since = 0;
        return '';
      }
      if (!uiState.thinking.active) return '';
      const secs = Math.max(1, Math.round((Date.now() - (uiState.thinking.since || Date.now())) / 1000));
      uiState.thinking.active = false;
      // The transcript gets exactly ONE collapsed line, blank-separated on
      // BOTH sides (Claude Code's rhythm: echo / blank / Thought / blank /
      // answer).
      const out = '\n' + style.dim(`  Thought for ${secs}s`) + '\n\n';
      frame.write(out);
      frame.requestRender();
      return out;
    },
    flushMarkdown() {
      const out = md ? md.flush() : '';
      emit(out); // flush output opens the response block too (a response with
      // no source newline never emits during delta — its ONLY output is here)
      return out;
    },
    flush() {
      return this.flushReasoning() + this.flushMarkdown();
    },
  };

  const setPhaseLocal = (p) => {
    session.phase = p;
    frame.requestRender();
  };

  return {
    canPrompt: true, // the TUI can always show a modal
    progress,
    /** Frame-block view of the live thinking preview. */
    uiState,

    spinnerStart(p) { setPhaseLocal(p); },
    phase(p) { setPhaseLocal(p); },
    phaseOnly(p) { setPhaseLocal(p); },
    setPhaseSafe(p) {
      try { session.phase = p; } catch { /* ignore */ }
      frame.requestRender();
    },
    statusRefresh() { frame.requestRender(); },

    stream,

    toolStart(call, args) {
      stream.flushReasoning();
      stream.flushMarkdown();
      setPhaseLocal(`tool: ${call.name}`);
      if (call?.id) toolStarts.set(call.id, Date.now());
      // Claude Code turn style: blank line, then the compact tool header.
      frame.writeLine('');
      frame.writeLine(compactToolHeader(call.name, args));
    },
    toolEnd(call, result) {
      const started = call?.id ? toolStarts.get(call.id) : undefined;
      if (call?.id) toolStarts.delete(call.id);
      const durSec = started ? Math.max(0, (Date.now() - started) / 1000) : null;
      frame.writeLine(compactToolResult(call.name, result, { durSec }));
      // Stash the FULL result (as physical display lines) for Ctrl+O — the
      // compact line deliberately shows one line + "+N lines".
      lastTool = {
        name: call?.name || '?',
        durSec,
        lines: fullResultLines(result, { width: Math.max(20, (hooks.contentWidth ? hooks.contentWidth() : 80) - 6) }),
      };
    },
    /** Ctrl+O: drop the most recent tool's FULL output into the transcript. */
    expandLastTool() {
      if (!lastTool) {
        frame.writeLine(style.dim('  (no tool result yet)'));
        frame.requestRender();
        return;
      }
      frame.writeLine(style.dim(`  ⎿  ${toolDisplayName(lastTool.name)} · full result${lastTool.durSec != null ? ` · ${lastTool.durSec.toFixed(1)}s` : ''}`));
      for (const ln of lastTool.lines.lines) frame.writeLine(style.muted(`     ${ln}`));
      if (lastTool.lines.capped) {
        frame.writeLine(style.dim('     … output capped at 40 lines'));
      }
      frame.requestRender();
    },
    finishStream() {
      stream.flushReasoning();
      stream.flushMarkdown();
      frame.write('\n');
    },

    noticeLines(lines) {
      for (const ln of lines || []) frame.writeLine(ln);
    },
    /**
     * Transient LLM failure — the client restarts the call from scratch
     * (see lib/llm/retries.js). Flush what the failed attempt streamed,
     * one dim notice line, then FRESH renderers: the retried attempt
     * re-generates the whole reply.
     */
    retryNotice(evt) {
      stream.flushReasoning();
      stream.flushMarkdown();
      frame.writeLine(style.muted(
        `[llm retry ${evt.attempt}/${evt.maxRetries} in ${Math.round((evt.delayMs || 0) / 1000)}s: ${evt.error}]`
      ));
      stream.reset();
      setPhaseLocal('waiting for model');
    },
    notice(text) {
      frame.writeLine(text);
    },
    userEcho(lines) {
      frame.writeLine('');
      for (const ln of userMarkerLines(lines.join('\n'))) {
        frame.writeLine(style.muted(ln));
      }
      frame.writeLine('');
    },
    usageLine(text) {
      // Append the turn duration (Claude's '✻ Crunched for Ns' equivalent).
      let secs = 0;
      try {
        if (session.turnStart) secs = Math.max(0.1, (Date.now() - session.turnStart) / 1000);
      } catch { /* ignore */ }
      frame.writeLine(text + style.dim(` · ${secs.toFixed(1)}s`));
    },
    cancelled() {
      frame.writeLine(style.warning(style.ICON.warn + ' cancelled'));
    },
    interrupted() {
      frame.writeLine(style.warning(style.ICON.warn + ' interrupted') + style.dim(' — partial output preserved'));
    },
    failed(err) {
      frame.writeLine(style.errorLine(err.message));
      if (process.env.HK2_DEBUG) frame.writeLine(err.stack || '');
    },

    confirm(promptText, { threeWay = false, title } = {}) {
      return promptViaModal(frame, modalHost, 'confirm', { text: promptText, threeWay, title });
    },
    optionList(spec) {
      return promptViaModal(frame, modalHost, 'optionList', spec);
    },
    freeText(label) {
      return promptViaModal(frame, modalHost, 'freeText', { label });
    },
    onInterrupt(cb) {
      return hooks.onInterrupt ? hooks.onInterrupt(cb) : () => {};
    },
  };
}
