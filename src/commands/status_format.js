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
 * Shared status/prompt/card formatting helpers — pure functions over the
 * session object, with NO readline or stream coupling. Extracted from
 * interactive.js so both the line REPL and the TUI front-end render the
 * same prompt, status line, plan panel, and tool-card headers from one
 * place. Everything here either returns a string or reads/mutates only the
 * plan-progress slice of `session`.
 */
import * as style from '../../lib/agent/style.js';

/**
 * Compact, *provider-distinguishing* model label for the prompt, status bar,
 * and welcome card. We show the full `provider/model-id` ref (not just the
 * model-id segment) so that two providers hosting the same model id are
 * visually distinct - e.g. `volcengine/glm-5.2[1m]` vs
 * `volcengine2/glm-5.2[1m]`. A trailing bracketed context-window hint
 * (e.g. `[1m]`) is PRESERVED so the active context length stays visible.
 * Returns the empty string when no model is configured (caller styles it).
 */
export function modelTagFor(session) {
  if (!session.modelCfg || !session.modelCfg.ref) return '';
  return session.modelCfg.ref;
}

export function promptFor(session) {
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
export function kbBrief(session) {
  if (!session.rt) return style.warning('no-kb');
  const ks = session.rt.knowledgeBySpace || { holy: [], eden: [] };
  const eden = String(ks.eden?.length ?? 0);
  const holy = String(ks.holy?.length ?? 0);
  return `${style.dim('Eden/')}${style.muted(eden)} ${style.dim('Holy/')}${style.muted(holy)}`;
}

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
export function formatPlanProgressLines(session) {
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

/**
 * Advance the plan-progress state machine one step — the `plan_step` tool's
 * mutation logic, extracted from turn.js's planStep callback so tests exercise
 * the REAL implementation instead of a drifting local mirror (the mirror was
 * how earlier regressions in this area slipped past the suite).
 *
 * Contract (Holy: plan-progress-state-machine):
 *   - Always marks the CURRENT step done, regardless of the step number the
 *     model passed. Sloppy args (numeric strings, 0-based, ahead-of-current
 *     "next step" values, re-confirming an already-done earlier step) must
 *     never strand the in-flight step: trusting the passed index left the
 *     current step stuck in_progress while the agent had moved on.
 *   - Defensive downgrade: stale in_progress markers left by earlier
 *     ahead-of-current calls are reset to pending, then the FIRST non-done
 *     step becomes the new current (in_progress).
 *   - When no non-done step remains the plan is complete: planProgress is
 *     cleared to null (the system-wide completion signal consumed by
 *     clearTaskState and the Code Review gate).
 *
 * Returns the 1-based step index actually marked done, or null when there is
 * no active plan. Mutates only the planProgress slice of `session`; the
 * caller refreshes the status bar.
 */
export function advancePlanStep(session, _stepIndex, note) {
  const p = session.planProgress;
  if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return null;
  // The model-supplied step number is deliberately IGNORED for the mutation:
  // the CURRENT step is always the one marked done. (An earlier revision
  // parsed/validated it here; it had no effect beyond documentation, so it is
  // kept out to make the always-mark-current intent unmistakable.)
  const cur = (typeof p.current === 'number' && p.current >= 0 && p.current < p.steps.length) ? p.current : 0;
  const markIdx = cur;
  p.steps[markIdx].status = 'done';
  if (note) p.steps[markIdx].note = String(note).slice(0, 160);
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
  return markIdx + 1;
}

/**
 * End-of-turn plan-progress reconciliation — the LAST line of defense that
 * keeps the panel from lying after a turn ends.
 *
 * The panel's in-turn state is driven entirely by the model voluntarily
 * calling `plan_step`, which fast reasoning models demonstrably skip (zero
 * calls, partial calls, or all-but-the-final calls). The system's own
 * end-of-turn logic (clearTaskState, the Code Review gate `planCompleted`)
 * already treats a NORMAL runLoop return as "task complete" — the panel must
 * agree with that contract. runLoop's every non-complete exit (stuck
 * detection, absolute cap, abort) THROWS, so a normal return is exactly the
 * model's final-text-answer signal.
 *
 *   - { turnCompleted: true } (normal-return path ONLY): clear the block
 *     regardless of individual step statuses. This closes every "task done,
 *     panel still pinned" variant (skipped / partial / missing plan_step
 *     calls) and unblocks the Code Review gate in those cases.
 *   - default / conservative (catch, interrupted, error, stuck paths): clear
 *     only when every step is already done. A mid-flight plan SURVIVES so the
 *     interruption-recovery flow ("请继续") can restore the panel and keep
 *     advancing it (Holy: interruption-recovery-mechanism — the catch path
 *     must never wipe a live planProgress).
 *
 * Trade-off, deliberately accepted: a model that pauses MID-plan to ask the
 * user a question also returns normally, and its panel closes. The work is
 * not lost (the confirmed plan lives in the transcript; "continue" resumes
 * execution) — only the visualization resets, and the alternative (a panel
 * that keeps showing stale in_progress state after completion) is the
 * recurring bug this reconciliation exists to kill.
 *
 * Safe to call when no plan is active.
 */
export function finalizePlanProgress(session, { turnCompleted = false } = {}) {
  const p = session.planProgress;
  if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return;
  if (turnCompleted || p.steps.every(st => st.status === 'done')) {
    session.planProgress = null;
  }
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
 * The mid-task instruction input box line (REPL StatusBar inputRenderer):
 * shown as the FIRST reserved row while an agent turn runs. [] when idle —
 * the bar then reserves nothing extra, matching the legacy layout.
 */
export function formatInputBoxLine(session) {
  if (!session || !session.agentTurnActive) return [];
  const label = style.accent('»') + style.dim(' add instruction ');
  const line = String(session.rl?.line ?? '');
  const cur = Math.max(0, Math.min(session.rl?.cursor ?? line.length, line.length));
  const caret = style.accent('▏');
  // The caret glyph sits AT the readline cursor position (not always at the
  // end), so mid-draft edits render where they will land. While an in-run
  // menu owns the input (consumeNext), keep the legacy tail-caret so the box
  // reads as inert while the menu is on screen.
  if (session.consumeNext) return [label + line + caret];
  return [label + line.slice(0, cur) + caret + line.slice(cur)];
}

/**
 * The REAL-cursor dock column for the input box: 1-based VISIBLE column just
 * after the label + the draft left of readline's cursor. Null when the
 * cursor must NOT dock (no turn, or a menu owns the input). Exported for
 * unit tests.
 */
export function inputBoxDockColumn(session) {
  if (!session || !session.agentTurnActive || session.consumeNext) return null;
  const label = '» add instruction ';
  const line = String(session.rl?.line ?? '');
  const cur = Math.max(0, Math.min(session.rl?.cursor ?? line.length, line.length));
  return style.visibleWidth(label) + style.visibleWidth(line.slice(0, cur)) + 1;
}

export function formatStatusLine(session) {
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
export function formatUsage(tokens, contextWindow) {
  const tin = tokens?.loopPeakIn ?? tokens?.callIn ?? 0;
  const tout = tokens?.loopPeakOut ?? tokens?.callOut ?? 0;
  const pct = contextWindow > 0 ? (tin / contextWindow) * 100 : 0;
  const pctStr = pct < 10 ? pct.toFixed(1) : pct.toFixed(0);
  return `${style.accent(style.ICON.up + fmtTok(tin))} ${style.success(style.ICON.down + fmtTok(tout))} ${style.muted(pctStr + '%/' + fmtTok(contextWindow))}`;
}

export function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n || 0);
}

export function safeParseArgs(s) {
  try { return JSON.parse(s || '{}') || {}; } catch { return {}; }
}

/**
 * Card width for tool-call cards. Tool cards always span the full terminal
 * width so their borders fill the screen edge-to-edge; bodyLine() truncates
 * any content that would overflow. (The welcome banner keeps its own 96-col
 * cap in printBanner, so this only affects bash/read/write/edit/find/etc.)
 */
export function cardWidthFor(lines, title) {
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
export function toolHeader(name, args, token, { full = false } = {}) {
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

/**
 * One-line squeeze for session digests: collapse all whitespace (including
 * newlines) and cap the length so a single long turn cannot blow up the
 * assessment prompt.
 */
export function digestLine(text, max = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Plain-text (ANSI-free) rendering of the active plan progress for LLM
 * consumption. formatPlanProgressLines() is for the terminal; the assessor
 * gets this instead.
 */
export function plainPlanLines(session) {
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
