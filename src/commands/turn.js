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
 * The agent-turn pipeline — extracted verbatim from interactive.js's
 * runAgentTurn. UI-agnostic: every render and every user prompt goes through
 * the `ui` object (see repl_ui.js for the line-REPL implementation that
 * reproduces the historical byte stream; the TUI supplies its own). All turn
 * POLICY lives here unchanged: phase ordering, rewrite pass-1/pass-2,
 * clarification, plan confirm + plan review, mid-task input injection,
 * interrupt recovery, KB conflict sync, and the end-of-turn KB flows.
 */
import { resolveModelRef, getPhaseModelRef } from '../../lib/config/home.js';
import { LLMClient } from '../../lib/llm/client.js';
import { estimateTokensFromChars } from '../../lib/llm/client.js';
import { runPhaseWithFallback, runPhaseWithSkipOnUnreachable } from '../phase_fallback.js';
import { buildTools } from '../../lib/agent/tools.js';
import { getMcpTools } from '../../lib/agent/mcp.js';
import { runLoop } from '../../lib/agent/loop.js';
import { buildKbStats, fallbackKind, classifyRead } from '../../lib/agent/kb_stats.js';
import { buildSystemPrompt } from '../../lib/agent/system_prompt.js';
import { reviewPlan } from '../../lib/agent/plan_review.js';
import { createVerdictFilter } from '../../lib/agent/code_review.js';
import { buildRequestGraph, renderRequestGraph } from '../../lib/agent/graph.js';
import { dispatchSlash } from '../slash/index.js';
import * as style from '../../lib/agent/style.js';
import { saveTaskState, clearTaskState } from '../../lib/agent/task_state.js';
import {
  buildResumeContext, buildSessionDigest, buildMidTaskInjection, disarmMidTaskCapture,
  isContinuationCue,
} from './session_ctx.js';
import {
  safeParseArgs, finalizePlanProgress, formatPlanProgressLines, formatUsage, fmtTok,
} from './status_format.js';
import {
  envFlag, maybeAutoCompact, maybeOfferKbUpdate, syncConflictingEden, runCodeReview,
} from './turn_support.js';

/**
 * Dispatch one submitted user line — the shared line handler for BOTH
 * front-ends (the readline REPL and the TUI): slash routing, model/KB
 * guards, plan-progress lifecycle, then the turn pipeline via the given ui.
 */
export async function handleUserLine(line, session, ctx, ui) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const handled = await dispatchSlash(line, ctx);
  if (handled) {
    // Reset status state so the elapsed timer stops ticking and the phase
    // returns to idle. Slash commands use ctx.setPhase() during execution
    // (which sets turnStart); without this reset the bar keeps counting after
    // the command finishes. The turn pipeline does the same reset on its own
    // exit path; slash commands bypass that path.
    session.phase = 'idle';
    session.turnStart = 0;
    ui.statusRefresh();
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
    ui.statusRefresh();
  }
  await runTurn(trimmed, session, ctx, ui, { continuation: isContinuation });
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
 * Returns null if the user cancels (Ctrl+D / rl close / modal dismiss) or the
 * plan has no usable steps; otherwise a finalized plan string suitable to
 * inject into the transcript, e.g.:
 *   "Summary: ..."
 *   "Step 1: <goal> -> <chosen strategy / free text>"
 *   "Step 2: ..."
 */
async function confirmPlan(plan, session, ui) {
  if (!plan || !plan.steps || plan.steps.length === 0) return null;
  const choices = [];
  for (let s = 0; s < plan.steps.length; s++) {
    const step = plan.steps[s];
    // Recommended strategy first, then the rest, preserving model order.
    const ordered = [...step.strategies].sort((a, b) =>
      (a.recommended === b.recommended) ? 0 : a.recommended ? -1 : 1);
    const header = [
      '',
      style.accent(style.bold(`Plan - Step ${s + 1}/${plan.steps.length}: ${step.goal}`)),
    ];
    const nStrats = ordered.length;
    const options = [];
    for (let i = 0; i < nStrats; i++) {
      const strat = ordered[i];
      const tag = strat.recommended ? ` ${style.warning('(recommend)')}` : '';
      options.push({
        row: `  ${style.bold(String(i + 1))}. ${strat.name}${tag}`,
        note: strat.description ? style.dim(`     ${strat.description}`) : undefined,
      });
    }
    options.push({ row: `  ${style.bold(String(nStrats + 1))}. ${style.dim('something else (type your own approach)')}` });

    const choice = await ui.optionList({ header, options, title: 'Choose implementation' });
    if (choice === null) return null;
    if (choice.index === nStrats) {
      // "something else": the next line is the free-form approach.
      const free = await ui.freeText(style.accent('  Your approach: '));
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
  ui.statusRefresh();
  return parts.join('\n');
}

/**
 * Surface Plan Review issues to the user one-by-one for confirmation.
 *
 * issues = [{ title, detail, suggestion }] from reviewPlan(). For each issue
 * we show the title + detail + the reviewer's suggestion, then a numbered
 * menu: (1) accept the suggestion, (2) dismiss this issue, (3) type your own
 * resolution. The chosen resolution text is recorded for accepted/typed ones;
 * dismissed issues contribute nothing. Returns an array of
 * { title, resolution } for the accepted/typed resolutions (empty when the
 * user dismissed everything), or null if the user cancelled (Ctrl+D / rl
 * close / modal dismiss) - a null return propagates as a plan cancellation
 * upstream.
 */
async function confirmPlanReview(issues, ui) {
  if (!issues || issues.length === 0) return [];
  const resolutions = [];
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const header = [
      '',
      style.accent(style.bold(`Plan Review - Issue ${i + 1}/${issues.length}: ${issue.title}`)),
      ...(issue.detail ? [style.dim(`  ${issue.detail}`)] : []),
    ];
    const options = [];
    if (issue.suggestion) {
      options.push({ row: `  ${style.bold('1')}. ${style.warning('(accept suggestion)')} ${issue.suggestion}` });
    } else {
      // No suggestion from the reviewer: only dismiss / type your own.
      options.push({ row: `  ${style.bold('1')}. ${style.dim('(no suggestion from reviewer)')}` });
    }
    options.push({ row: `  ${style.bold('2')}. ${style.dim('dismiss this issue')}` });
    options.push({ row: `  ${style.bold('3')}. ${style.dim('type your own resolution')}` });

    const choice = await ui.optionList({ header, options, title: 'Plan review' });
    if (choice === null) return null;
    if (choice.index === 0) {
      // Accept the reviewer's suggestion (if any). A missing suggestion is
      // treated as a dismissal so we never record an empty resolution.
      if (issue.suggestion) {
        resolutions.push({ title: issue.title, resolution: issue.suggestion });
      }
    } else if (choice.index === 2) {
      // "type your own": the next line is the free-form resolution.
      const free = await ui.freeText(style.accent('  Your resolution: '));
      if (free.cancelled) return null;
      const text = (free.text || '').trim();
      if (text) resolutions.push({ title: issue.title, resolution: text });
    }
    // choice.index === 1 -> dismiss: contributes nothing.
  }
  return resolutions;
}

/**
 * Surface an unclear-request assessment to the user for confirmation.
 *
 * assessment = { clear: false, unclear: string[], interpretations: string[] }
 * Renders the unclear aspects, then a numbered menu of the candidate
 * interpretations followed by a 'something else' free-text option (exactly
 * the shape the user requested). Returns the chosen interpretation text
 * (a candidate string or the user's typed text), or null if the user
 * cancelled (Ctrl+D / rl close / modal dismiss).
 */
async function confirmClarification(assessment, ui) {
  if (!assessment || assessment.clear) return null;
  const header = [
    '',
    style.accent(style.bold('Your request is not fully clear. Could you confirm what you mean?')),
  ];
  if (assessment.unclear && assessment.unclear.length) {
    header.push(style.dim('  Unclear aspects:'));
    for (const u of assessment.unclear) header.push(style.dim(`    - ${u}`));
  }
  const n = assessment.interpretations.length;
  const options = assessment.interpretations.map((interp, i) => ({
    row: `  ${style.bold(String(i + 1))}. ${interp}${i === 0 ? ` ${style.warning('(recommend)')}` : ''}`,
  }));
  options.push({ row: `  ${style.bold(String(n + 1))}. ${style.dim('something else (type what you mean)')}` });

  const choice = await ui.optionList({ header, options, title: 'Clarify request' });
  if (choice === null) return null;
  if (choice.index === n) {
    const free = await ui.freeText(style.accent('  Your request: '));
    if (free.cancelled) return null;
    return free.text || null;
  }
  return assessment.interpretations[choice.index];
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

export async function runTurn(userText, session, ctx, ui, opts = {}) {
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

  // ESC-to-interrupt: while a turn is running, pressing ESC aborts the
  // in-flight LLM stream (runLoop checks the signal at the top of each turn
  // and inside the stream loop, and forwards it to the provider fetch). The
  // front-end wires the actual key (readline keypress for the REPL, the TUI
  // key loop there).
  const abortCtrl = new AbortController();
  // The interrupt hook is OPTIONAL (non-interactive drivers may not wire
  // one); a missing hook just means the turn cannot be ESC-aborted.
  const interruptHook = ui.onInterrupt ? ui.onInterrupt(() => {
    if (!abortCtrl.signal.aborted) {
      abortCtrl.abort(new Error('interrupted by user (ESC)'));
    }
  }) : null;

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
  // Active only when the front-end can show an interactive prompt. Non-
  // interactive callers (explain/search/serve) never run it.
  const enableAssess = enableRewrite && envFlag('HK2_ENABLE_REQUEST_ASSESS', 1);
  const canAssess = enableAssess && session.llm && ui.canPrompt;
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
  // enabled), else KB retrieval — or straight to the model when no KB is
  // loaded (chat works without one; there is nothing to retrieve).
  if (enableRewrite && session.llm) {
    ui.spinnerStart('rewriting query');
  } else if (session.rt) {
    ui.spinnerStart('retrieving KB');
  } else {
    ui.spinnerStart('waiting for model');
  }

  // --- Pass 1: rewrite (raw user text, no clarification yet) ---------------
  if (enableRewrite && session.llm) {
    ui.phase('rewriting query');
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
        warn: (m) => { ui.progress.breakLine(); ctx.print(m); },
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
      ui.progress.done();
      ctx.print(`[warn] query rewrite failed, using raw query: ${err.message}`);
      rewrite = null;
    }
  }

  // --- Pass 1: retrieve KB (on the rewritten query, else raw user text) ----
  let graphText = '';
  let graphSummary = '';
  let graph = null;
  if (session.rt) {
  ui.phase('retrieving KB');
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
      ui.progress.pause();
      ui.noticeLines([
        `\n${style.warning(style.ICON.warn + ' [kb priority]')} Holy Space takes precedence over Eden. ${session.kbConflicts.length} Eden entr${session.kbConflicts.length === 1 ? 'y' : 'ies'} conflicted with Holy and ${session.kbConflicts.length === 1 ? 'was' : 'were'} suppressed from this turn's context:`,
        ...session.kbConflicts.map(c => `  - eden "${c.eden.title}" (${c.eden.id}) → superseded by holy "${c.holy.title}" (${c.holy.id})`),
        style.dim('  The Eden entries will be marked superseded at the end of this task.'),
      ]);
    }
    await session.transcript?.logMeta('graph', { summary: graph.summary });
  } catch (err) {
    ui.progress.done();
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
  } else {
    // No KB loaded: empty graph context, no prefetch, no warnings — the
    // turn proceeds with the plain system prompt.
    graphText = '';
    graphSummary = '';
    graph = null;
    session.loopKbPrefetch = null;
  }

  // --- Pass 1.5: request-clarity assessment WITH retrieved context ---------
  // Runs after the first rewrite+retrieve so the LLM can ground its clarity
  // judgement in the retrieved symbols/knowledge. If unclear, surface the
  // candidate interpretations as a menu; the user's confirmation then drives
  // a second rewrite and a re-retrieve. One bounded round.
  let clarification = null;
  if (canAssess && graph) {
    ui.phase('assessing request');
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
        warn: (m) => { ui.progress.breakLine(); ctx.print(m); },
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
        ui.progress.pause();
        clarification = await confirmClarification(assessment, ui);
        if (clarification === null) {
          // User cancelled the clarification prompt (Ctrl+D / rl close /
          // modal dismiss): abort the whole turn cleanly, mirroring
          // plan-cancel handling. Still run the Eden sync: pass-1 already
          // told the user conflicting entries "will be marked superseded at
          // the end of this task".
          await syncConflictingEden(session, ctx);
          ui.progress.done();
          // Mid-task input: this return exits BEFORE the main try/finally, so
          // disarm here explicitly — leaving agentTurnActive armed would make
          // enqueue() capture (and never deliver) every subsequent line.
          disarmMidTaskCapture(session);
          ui.cancelled();
          session.phase = 'idle';
          session.turnStart = 0;
          ui.statusRefresh();
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
  if (clarification && session.rt) {
    if (enableRewrite && session.llm) {
      ui.phase('rewriting query');
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
    ui.phase('retrieving KB');
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
        ui.noticeLines([
          `\n${style.warning(style.ICON.warn + ' [kb priority]')} ${newConflicts.length} additional Eden entr${newConflicts.length === 1 ? 'y' : 'ies'} suppressed by Holy after clarification:`,
          ...newConflicts.map(c => `  - eden "${c.eden.title}" (${c.eden.id}) → superseded by holy "${c.holy.title}" (${c.holy.id})`),
        ]);
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
      ui.progress.done();
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
    // per-200ms \r refresh does not overwrite the choice prompt.
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
      ui.progress.pause();
      const confirmed = await confirmPlan(plan, session, ui);
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
      ui.phase('reviewing plan');
      try {
        // Review phases use the "skip on unreachable" policy — NEVER a session-
        // model fallback (see runPhaseWithSkipOnUnreachable): substituting an
        // unplanned model would change what reviewed the plan. Warnings are
        // printed by the policy; skip -> the confirmed plan passes through
        // unchanged, with no "no issues found" message.
        //
        // The reviewer's analysis streams live (same UX as code review):
        // progress.tick() clears the spinner on the first delta, MarkdownStream
        // styles headings/lists/code as they arrive, and createVerdictFilter
        // hides the machine-readable === VERDICT === JSON so the user never
        // sees raw JSON scroll by. flushNow() writes any trailing partial line
        // before warnings / menus / verdicts print. The reviewer's THINKING
        // stream renders live too (ReasoningStream + progress.reason(),
        // mirroring the main agent loop): reasoning deltas arrive before any
        // body text, so without this the whole deep-reasoning window is a
        // silent spinner.
        ui.stream.reset();
        const flushNow = () => ui.stream.flush();
        const onReasoning = (text) => {
          ui.progress.reason();
          ui.stream.reasoning(text, 'shown');
        };
        const onDelta = createVerdictFilter((text) => ui.stream.delta(text));
        const reviewRun = await runPhaseWithSkipOnUnreachable({
          phase: 'plan-review',
          phaseLlm: usingPhaseModel ? reviewLlm : null,
          sessionLlm: session.llm,
          warn: (m) => { flushNow(); ui.progress.breakLine(); ctx.print(m); },
          run: (llmForReview) => reviewPlan(llmForReview, confirmed, {
            signal: abortCtrl.signal,
            onDelta,
            onReasoning,
          }),
        });
        flushNow(); // write the renderer's trailing partial line before any menu/warning
        ui.progress.pause(); // stop the spinner before printing the menu / result
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
        const resolutions = await confirmPlanReview(result.issues, ui);
        if (resolutions === null) return null; // user cancelled during review
        if (resolutions.length === 0) return confirmed; // dismissed every issue
        const annex = resolutions
          .map((r) => `Plan review issue: ${r.title} -> ${r.resolution}`)
          .join('\n');
        return `${confirmed}\n${annex}`;
      } catch (err) {
        // Review is best-effort: never block the confirmed plan on a failure.
        ui.progress.pause();
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
      ui.statusRefresh();
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
      ui.progress.pause();
      const label = targetSpace === 'holy'
        ? style.warning('HOLY space')
        : style.accent('Eden space');
      const lines = [
        `\n[kb save] Model proposes ${label} entry "${entry?.id}": ${entry?.title || ''}`,
      ];
      if (targetSpace === 'holy') {
        lines.push(`  Holy Space is the source of truth for stable design knowledge.`);
      }
      ui.noticeLines(lines);
      // Tri-state (y/N/E) only for NEW Holy entries; updates and Eden keep (y/N).
      const offerEden = targetSpace === 'holy' && entry?.isNew;
      const suffix = offerEden ? ' (y/N/E) ' : ' (y/N) ';
      if (offerEden) {
        ui.notice(style.dim('  E = save this entry to Eden space instead of Holy.'));
      }
      const confirmed = await ui.confirm(`Write "${entry?.id}" to ${targetSpace} space?${suffix}`, { threeWay: offerEden, title: 'Save knowledge' });
      if (confirmed === 'eden') {
        ui.notice(style.accent('  Redirected - saving to Eden space instead.'));
      } else if (!confirmed) {
        ui.notice(style.dim('  Cancelled - nothing was written to the KB.'));
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
  ui.phase('waiting for model');

  let assistantText = '';
  // Per-LLM-call renderers (markdown + reasoning) live inside ui.stream;
  // initialize the pair here (mirroring the original eager construction) —
  // every onTurnStart resets them fresh.
  ui.stream.reset();
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
        // prelude's phase('waiting for model') above, so it is skipped.
        ui.progress.resume('waiting for model');
      }
      // Fresh markdown + reasoning renderers for the new LLM call.
      ui.stream.reset();
      ui.statusRefresh();
    },
    onDelta: (text) => {
      // First body delta ends the reasoning window (if any). Flush any
      // trailing partial reasoning line so it renders cleanly before the
      // answer text begins, then finalize the reasoning stream.
      ui.stream.flushReasoning();
      ui.stream.delta(text);
      // Raw text still accumulates into assistantText for the transcript.
      assistantText += text;
      if (session.phase !== 'streaming') ui.phaseOnly('streaming');
      else ui.statusRefresh();
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
      ui.progress.reason();
      if (session.phase !== 'thinking') ui.phaseOnly('thinking');
      if (text) {
        ui.stream.reasoning(text, 'first');
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
      ui.statusRefresh();
    },
    onToolCallStart: (call) => {
      const args = typeof call.arguments === 'string' ? safeParseArgs(call.arguments) : (call.arguments || {});
      // Stream ended for this LLM call. Flush any partial markdown line so
      // the trailing text renders before the tool card opens. Also flush any
      // open reasoning window: reasoning models may emit reasoning_content
      // then tool_calls with NO body text. The card render (incl. spinner
      // finalization) lives in the ui.
      ui.toolStart(call, args);
    },
    onToolCallEnd: (call, result) => {
      ui.phaseOnly('waiting for model');
      session.toolCallCount++;
      ui.toolEnd(call, result);
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
        ui.userEcho(lines);
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
    // closing blank line so the layout stays clean; then finalize the spinner.
    ui.finishStream();

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
      // tokens), so they're labelled with `~`. Appended on the same line
      // as usage, dot-separated, to match the existing status style.
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
      ui.usageLine(`${style.success(style.ICON.ok + ' usage')} ${style.dim(style.ICON.dot)} ${usage}${kbPart}`);
      await session.transcript?.logMeta('usage', {
        loop: { in: session.tokens.loopIn, out: session.tokens.loopOut },
        cumulative: { in: session.tokens.cumIn, out: session.tokens.cumOut },
      });
    }

    session.lastAnswer = assistantText;
    await session.transcript?.logAssistant(assistantText);
    await session.transcript?.logTurn(result.turns, result.toolCalls);

    // The ANSWER is done — reset the phase BEFORE the end-of-turn prompts:
    // the confirm modals (KB update / knowledge save) can stay open for a
    // long time, and the footer behind them must read idle ('enter to send')
    // instead of a stale '⠹ streaming' spinner.
    session.phase = 'idle';
    session.turnStart = 0;
    ui.statusRefresh();

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
    ui.statusRefresh();
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
      await runCodeReview(session, ctx, ui, {
        planText: session.lastPlanText || '',
        assistantText,
        resolvePhaseLlm,
        signal: abortCtrl.signal,
      });
    }
  } catch (err) {
    ui.progress.done();
    // An abort/error can leave a trailing assistant `tool_use` (tool_calls)
    // whose tool_result never landed - the tool loop was cut short. Strip it
    // so the next turn doesn't resend an orphaned tool_use and 400 Anthropic.
    stripDanglingToolUse(session.messages);
    if (abortCtrl.signal.aborted) {
      // User pressed ESC. Any partial assistant text was already streamed;
      // we don't record an incomplete assistant turn in the transcript.
      ui.interrupted();
      session.phase = 'idle';
    } else {
      ui.failed(err);
      session.phase = 'error';
    }
    session.turnStart = 0;
    finalizePlanProgress(session);
    ui.statusRefresh();
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
    if (interruptHook) interruptHook();
    // Mid-task input: the turn is over. Disarm capture FIRST so lines arriving
    // from now on go through the normal queue path, then hand any instructions
    // that never reached a round boundary (e.g. the model's final reply had no
    // tool calls, or the turn aborted early) back to the normal queue — they
    // become fresh user turns right after this task, so nothing typed by the
    // user is ever dropped.
    const leftover = disarmMidTaskCapture(session);
    if (leftover.length > 0) {
      ui.notice(style.dim(`(queued instruction${leftover.length > 1 ? 's' : ''} passed to a new turn — the task finished before they could be delivered mid-run)`));
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
