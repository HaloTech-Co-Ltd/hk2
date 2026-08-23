/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 *-------------------------------------------------------------------------*/

/**
 * /review command - manually review the CURRENT completed task.
 *
 *   /review <phase> [--model=<provider>/<model-id>]
 *
 *   phase:
 *     code   Manual code review of the just-completed task (plan-review
 *            phase target: implemented). Sends ONLY the original user
 *            request + the claimed result (final answer, changed files,
 *            working-tree diff) to the review model - the conversation
 *            context and the execution process are deliberately EXCLUDED so
 *            they cannot anchor or pollute the review.
 *     plan   Reserved for a future manual plan-review (NOT implemented yet).
 *
 *   --model=<provider>/<model-id>
 *            Run the review with this specific model. When omitted, the
 *            project's phase-configured model is used
 *            (/model set-phase --phase=code-review <ref>), falling back to
 *            the current session (main) model when no phase override exists.
 *
 * The review itself runs through reviewCode() with the manual
 * regression-check system prompt (see lib/agent/code_review.js), under the
 * same "skip on unreachable" policy as the automatic end-of-turn review
 * (never silently re-runs on another model).
 *
 * Context isolation: by design the review messages contain ONLY the request
 * and the result material. The reviewer never sees the implementation
 * process (tool calls, reasoning, intermediate turns).
 */
import {
  splitModelRef, resolveModelRef, getPhaseModelRef,
} from '../../lib/config/home.js';
import { LLMClient } from '../../lib/llm/client.js';
import {
  reviewCode, buildManualCodeReviewContent, MANUAL_REVIEW_SYSTEM_PROMPT,
} from '../../lib/agent/code_review.js';
import { runPhaseWithSkipOnUnreachable } from '../phase_fallback.js';

/** phase alias (as typed) -> canonical pipeline phase name */
const REVIEW_PHASES = {
  code: 'code-review',
  plan: 'plan-review',
};

/**
 * Parse --key=value / --flag tokens into a flat object (same tolerant parser
 * shape as src/slash/model.js). Values are strings; value-less flags are
 * `true`.
 */
function parseFlags(tokens) {
  const out = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 2) out[t.slice(2, eq)] = t.slice(eq + 1);
      else if (eq === -1) out[t.slice(2)] = true;
      // a bare `--model=` (empty value) stays out; handled by the caller
    }
  }
  return out;
}

function printUsage(ctx) {
  ctx.print(`Usage: /review <phase> [--model=<provider>/<model-id>]`);
  ctx.print(``);
  ctx.print(`Phases:`);
  ctx.print(`  code    Manual code review of the just-completed task (implemented)`);
  ctx.print(`  plan    Manual plan review (not implemented yet)`);
  ctx.print(``);
  ctx.print(`Options:`);
  ctx.print(`  --model=<provider>/<model-id>   Review with this model`);
  ctx.print(`                                  (default: the phase-configured model,`);
  ctx.print(`                                   then the current session model)`);
  ctx.print(``);
  ctx.print(`How it works: only the original task request and the completed`);
  ctx.print(`result (final answer + changed files + working-tree diff) are sent`);
  ctx.print(`to the review model - the task's implementation context is ignored,`);
  ctx.print(`so it cannot influence or pollute the review.`);
  ctx.print(``);
  ctx.print(`Examples:`);
  ctx.print(`  /review code`);
  ctx.print(`  /review code --model=provB/model-b`);
}

export async function cmdReview(args, ctx) {
  const sub = args[0];
  const flags = parseFlags(args.slice(1));

  if (!sub || sub === 'help') {
    printUsage(ctx);
    return;
  }

  const phase = REVIEW_PHASES[sub];
  if (!phase) {
    ctx.print(`Unknown phase: ${sub}`);
    ctx.print(`Supported phases: ${Object.keys(REVIEW_PHASES).join(', ')}`);
    return;
  }
  if (phase === 'plan-review') {
    ctx.print(`/review plan is not implemented yet (only "code" is currently supported).`);
    return;
  }

  // ---- Resolve which model reviews --------------------------------------
  // Priority: --model flag > project phase config > current session model.
  let reviewLlm = null;
  let source = '';
  let modelLabel = '';

  if (typeof flags.model === 'string' && flags.model) {
    const ref = flags.model;
    const split = splitModelRef(ref);
    if (!split) {
      ctx.print(`Invalid --model ref: ${ref} (expected provider/model-id)`);
      return;
    }
    const cfg = await resolveModelRef(ref).catch(() => null);
    if (!cfg) {
      ctx.print(`Model not found: ${ref}`);
      return;
    }
    reviewLlm = new LLMClient(cfg);
    source = 'flag';
    modelLabel = ref;
  } else {
    // ctx.llm is the current session (main) model; the phase override is
    // read through the project so it stays correct across reloads.
    let phaseRef = null;
    try {
      const cur = await ctx.getCurrentProject?.();
      phaseRef = cur ? getPhaseModelRef(cur, 'code-review') : null;
    } catch { /* no project / no phaseModels field */ }
    if (phaseRef) {
      const cfg = await resolveModelRef(phaseRef).catch(() => null);
      if (cfg) {
        reviewLlm = new LLMClient(cfg);
        source = 'phase';
        modelLabel = phaseRef;
      } else {
        ctx.print(`[warn] could not resolve the configured code-review model (${phaseRef}), using the session model`);
      }
    }
    if (!reviewLlm) {
      if (!ctx.llm) {
        ctx.print(`No review model available. Configure a model first (/model add + /model set-default), or pass --model=<provider>/<model-id>.`);
        return;
      }
      reviewLlm = ctx.llm;
      source = 'session';
      modelLabel = 'session model';
    }
  }

  // ---- Collect ONLY the request + the result ----------------------------
  // ctx.getConversation() returns { requestText, answerText } (the latest
  // user request and the assistant's final answer) without any of the
  // implementation-process context. collectWorkingTreeDiff() returns the
  // working-tree material (diff + changed files).
  const convo = (await ctx.getConversation?.()) || {};
  const requestText = (convo.requestText || '').trim();
  const answerText = (convo.answerText || '').trim();
  if (!requestText && !answerText) {
    ctx.print(`No completed task in this conversation yet - nothing to review.`);
    return;
  }
  const { diffText, changedFiles } = (await ctx.collectWorkingTreeDiff?.()) || { diffText: '', changedFiles: [] };

  const reviewText = buildManualCodeReviewContent({
    requestText,
    changedFiles,
    diffText,
    answerText,
  });

  // ---- Announce + run ----------------------------------------------------
  const via = source === 'flag' ? '--model flag'
    : source === 'phase' ? 'project code-review phase config'
    : 'current session model';
  ctx.print(``);
  ctx.print(`Manual Code Review`);
  ctx.print(`  Reviewing the completed task with ${modelLabel} (${via})...`);
  ctx.print(`  Scope: the original request and the completed result only - implementation context is ignored.`);
  ctx.print(`  Checks: correctness, completeness, quality, and consistency of the result (regression check).`);
  ctx.print(`  ${changedFiles.length > 0
    ? `Files changed (${changedFiles.length}): ${changedFiles.slice(0, 12).join(', ')}${changedFiles.length > 12 ? '...' : ''}`
    : 'Files changed: (none detected - reviewing the request and claimed result only)'}`);

  ctx.setPhase?.('reviewing code');
  try {
    const reviewRun = await runPhaseWithSkipOnUnreachable({
      phase: 'code-review',
      phaseLlm: source === 'session' ? null : reviewLlm,
      sessionLlm: ctx.llm || reviewLlm,
      warn: (m) => ctx.print(m),
      run: (llmForReview) => reviewCode(llmForReview, reviewText, {
        systemPrompt: MANUAL_REVIEW_SYSTEM_PROMPT,
      }),
    });

    if (reviewRun.skipped) {
      // Model unreachable: warnings already printed; no review result.
      return;
    }
    const result = reviewRun.result;
    if (result.ok || !result.issues || result.issues.length === 0) {
      ctx.print(`  Code review complete - no issues found.`);
    } else {
      ctx.print(`  Code review found ${result.issues.length} issue(s):`);
      result.issues.forEach((issue, i) => {
        ctx.print(``);
        ctx.print(`  Issue ${i + 1}: ${issue.title}`);
        if (issue.detail) ctx.print(`    ${issue.detail}`);
        if (issue.suggestion) ctx.print(`    Suggestion: ${issue.suggestion}`);
      });
    }
  } catch (err) {
    ctx.print(`[warn] code review failed: ${err.message}`);
  } finally {
    ctx.setPhase?.('idle');
  }
}
