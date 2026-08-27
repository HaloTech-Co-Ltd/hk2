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
 * The line-REPL implementation of the turn `ui` interface consumed by
 * runTurn (src/commands/turn.js). Every method reproduces the exact byte
 * sequence interactive.js emitted before the extraction: the ProgressIndicator
 * start/nextPhase/reason/pause/stop/tick/done dance, the stdout/stderr split
 * (body markdown + reasoning on stdout, chrome on stderr), the MarkdownStream /
 * ReasoningStream lifecycle, and the readline menu mechanics (consumeNext).
 *
 * The TUI front-end supplies its own ui with the same surface; runTurn is
 * unaware of which one is driving it.
 */
import readline from 'node:readline';
import { ProgressIndicator } from '../progress.js';
import { MarkdownStream } from '../../lib/agent/markdown.js';
import { ReasoningStream } from '../../lib/agent/reasoning_stream.js';
import * as style from '../../lib/agent/style.js';
import { confirmThreeWay, replIo, userMarkerLines } from './session_ctx.js';
import { writeToolCardStart, writeToolCardEnd } from './tool_card.js';

/**
 * Prompt for a single integer choice in [1..max]. Returns {index, cancelled}.
 * Mirrors replIo.confirm's consumeNext + close handling. Re-prompts on bad input.
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
 * Build the REPL turn-ui for `session`. Create ONE per user turn (fresh
 * ProgressIndicator + stream renderers, matching the pre-extraction lifecycle
 * where runAgentTurn constructed them at its top).
 */
export function makeReplUi(session) {
  const io = replIo(session);
  const progress = new ProgressIndicator();
  let mdStream = null;      // per-LLM-call markdown renderer (stream.reset)
  let reasoningStream = null; // per-LLM-call reasoning renderer

  const setPhaseLocal = (p) => {
    session.phase = p;
    session.statusBar?.update();
  };

  const stream = {
    /** Fresh markdown + reasoning renderers for a new LLM call / review window. */
    reset() {
      mdStream = new MarkdownStream();
      reasoningStream = new ReasoningStream();
    },
    /** Body delta: finalize the spinner line, style through the markdown stream, write. */
    delta(text) {
      progress.tick(text);
      const rendered = mdStream ? mdStream.feed(text) : text;
      if (rendered) process.stdout.write(rendered);
    },
    /**
     * Reasoning delta. `mode` reproduces the two historical pause variants:
     *   'first' (agent loop) — pause on the FIRST delta (before the header
     *   shows) so the spinner's \r refresh can't clobber the first line;
     *   'shown' (review phases) — pause once the header has been shown.
     */
    reasoning(text, mode = 'first') {
      const headerShown = !!reasoningStream?.headerShown;
      if (mode === 'shown' ? headerShown : !headerShown) progress.pause();
      const rendered = reasoningStream ? reasoningStream.feed(text) : '';
      if (rendered) process.stdout.write(rendered);
    },
    /** End the reasoning window, writing any trailing partial line. */
    flushReasoning() {
      const tail = reasoningStream ? reasoningStream.end() : '';
      if (tail) process.stdout.write(tail);
      return tail;
    },
    /** Flush the markdown renderer's trailing partial line. */
    flushMarkdown() {
      const out = mdStream ? mdStream.flush() : '';
      if (out) process.stdout.write(out);
      return out;
    },
    /** Combined flush (review phases' flushNow). */
    flush() {
      const tail = (reasoningStream ? reasoningStream.end() : '') + (mdStream ? mdStream.flush() : '');
      if (tail) process.stdout.write(tail);
      return tail;
    },
  };

  return {
    /** True when interactive prompts are possible (readline TTY). */
    canPrompt: !!(session.rl && session.rl.terminal),
    /** The raw ProgressIndicator — turn code reads `.phase` for idempotence guards. */
    progress,

    /* ---- phase / spinner channel ---- */
    /** Turn-prelude spinner start: progress.start(p) + phase + status bar. */
    spinnerStart(p) {
      progress.start(p);
      setPhaseLocal(p);
    },
    /** Guarded phase transition: progress.nextPhase(p) unless already on p. */
    phase(p) {
      if (progress.phase !== p) progress.nextPhase(p);
      setPhaseLocal(p);
    },
    /** Phase + status-bar refresh WITHOUT touching the spinner (tool cards, streaming). */
    phaseOnly(p) {
      setPhaseLocal(p);
    },
    /** Best-effort phase set for finally blocks (never throws). */
    setPhaseSafe(p) {
      try { setPhaseLocal(p); } catch { /* ignore */ }
    },
    statusRefresh() {
      session.statusBar?.update();
    },

    /* ---- streaming channel ---- */
    stream,

    /* ---- tool cards ---- */
    /** Open a tool card: flush renderers, stop the spinner, phase, top border + header. */
    toolStart(call, args) {
      stream.flushReasoning();
      stream.flushMarkdown();
      // Finalize the spinner so its per-200ms \r refresh can't overwrite the
      // tool card. stop() keeps it down for the whole tool round; the next
      // turn's onTurnStart re-arms it via resume().
      progress.stop();
      setPhaseLocal(`tool: ${call.name}`);
      writeToolCardStart((s) => process.stderr.write(s), call, args);
    },
    /** Close a tool card: ≤6 body lines + ok/failed row + bottom border (grow-redraw when wider). */
    toolEnd(call, result) {
      writeToolCardEnd((s) => process.stderr.write(s), call, result);
    },
    /** Post-loop render close: flush both renderers, newline, finalize the spinner. */
    finishStream() {
      stream.flushReasoning();
      stream.flushMarkdown();
      process.stdout.write('\n');
      progress.done();
    },

    /* ---- notices ---- */
    /** Multi-line stderr notice, each line + '\n' (first line may carry its own leading \n). */
    noticeLines(lines) {
      for (const ln of lines || []) process.stderr.write(ln + '\n');
    },
    /** Single-line stderr notice + '\n'. */
    /**
     * Transient LLM failure — the client restarts the call from scratch
     * (see lib/llm/retries.js). Byte-for-byte the sequence main's
     * interactive.js ran: flush both renderers, print the bracketed retry
     * notice, install FRESH renderers (the retried attempt re-generates the
     * whole reply), and resume the spinner.
     */
    retryNotice(evt) {
      stream.flush();
      process.stdout.write('\n' + style.muted(
        `[llm retry ${evt.attempt}/${evt.maxRetries} in ${Math.round((evt.delayMs || 0) / 1000)}s: ${evt.error}]`
      ) + '\n');
      stream.reset();
      progress.resume('waiting for model');
      session.statusBar?.update();
    },
    notice(text) {
      process.stderr.write(text + '\n');
    },
    /** Echo mid-task injected user input (blank line, muted "you:" marker lines, blank line). */
    userEcho(lines) {
      process.stderr.write('\n');
      for (const ln of userMarkerLines(lines.join('\n'))) {
        process.stderr.write(style.muted(ln) + '\n');
      }
      process.stderr.write('\n');
    },
    /** Final per-turn usage line (pre-built by the turn pipeline). */
    usageLine(text) {
      process.stderr.write(text + '\n');
    },
    /** Clarification/plan cancellation notice (no leading newline). */
    cancelled() {
      process.stderr.write(`${style.warning(style.ICON.warn + ' cancelled')}\n`);
    },
    /** ESC-abort notice. */
    interrupted() {
      process.stderr.write(`\n${style.warning(style.ICON.warn + ' interrupted')}${style.dim(' — partial output preserved')}\n`);
    },
    /** Turn-failure notice (err.message via style.errorLine; stack under HK2_DEBUG). */
    failed(err) {
      process.stderr.write(`\n${style.errorLine(err.message)}\n`);
      if (process.env.HK2_DEBUG) process.stderr.write(err.stack + '\n');
    },

    /* ---- prompts ---- */
    /** y/N (io.confirm mechanics); {threeWay} adds the e/eden → 'eden' branch. */
    confirm(promptText, { threeWay = false } = {}) {
      return threeWay ? confirmThreeWay(session, promptText) : io.confirm(promptText);
    },
    /**
     * Numbered menu. spec = { header: string[] (pre-styled lines above the
     * options), options: [{row, note?}] } — rows print verbatim, then a
     * promptChoice over options.length. Resolves {index} (0-based) or null
     * when cancelled (Ctrl+D / closed rl).
     */
    async optionList({ header = [], options = [] }) {
      for (const ln of header) process.stderr.write(ln + '\n');
      for (const opt of options) {
        process.stderr.write(opt.row + '\n');
        if (opt.note) process.stderr.write(opt.note + '\n');
      }
      const choice = await promptChoice(session, options.length);
      if (choice.cancelled) return null;
      return { index: choice.index };
    },
    /** Free-text line prompt; resolves {text, cancelled}. */
    freeText(promptText) {
      return promptLine(session, promptText);
    },

    /* ---- interrupt ---- */
    /**
     * Wire ESC-to-interrupt on the readline input. Returns an unsubscribe
     * function. Only arms in TTY mode (readline keypress events available).
     */
    onInterrupt(cb) {
      const rlInput = session.rl?.input;
      if (!(rlInput && session.rl?.terminal)) return () => {};
      // Publish the trigger on the session so the SIGINT handler can route a
      // mid-turn Ctrl+C through the SAME abort path as ESC (parity with the
      // TUI's Ctrl+C-during-turn = interrupt, not hard exit). Cleared when
      // the turn unsubscribes.
      session._turnInterrupt = cb;
      const onKeypress = (_str, key) => {
        if (key && key.name === 'escape') cb();
      };
      readline.emitKeypressEvents(rlInput); // idempotent; readline already set this up
      rlInput.on('keypress', onKeypress);
      return () => {
        if (session._turnInterrupt === cb) session._turnInterrupt = null;
        rlInput.off('keypress', onKeypress);
      };
    },
  };
}
