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
 * Agent loop: a single prompt drives a turn cycle.
 *
 * Flow:
 *   1. Push the user message onto the transcript
 *   2. Stream the assistant response (may include tool_calls)
 *   3. Forward each assistant text delta to the UI via callback
 *   4. When the stream ends with tool_calls:
 *        a. executeToolCall for each
 *        b. emit tool_call_start / tool_call_end events to UI
 *        c. push the tool result onto the transcript (role:'tool')
 *        d. go back to step 2 (next turn)
 *   5. No more tool_calls → turn complete, emit turn_end
 *
 * Per-turn tool-result cache: identical calls to read-only tools
 * (read / find / grep / ast_grep / kb_*) within a single runLoop invocation
 * return the cached result instead of re-executing, so the LLM doesn't burn
 * turns re-asking the same question. The cache is invalidated by any
 * cache-busting call — bash / edit / write / ast_edit / resolve (which may
 * change underlying state). Note kb_save_knowledge is NOT in the busting
 * set: an identical cached kb_knowledge/kb_search_knowledge result from
 * earlier in the same runLoop can outlive a save until the cache clears.
 *
 * Loop termination — deliberately NOT a fixed cap:
 *   - The agent runs as many turns as the task requires (task-driven).
 *   - Safety stops it from looping forever:
 *       a. STUCK_REPEAT_LIMIT repeats of an identical tool-call signature
 *          AND result fingerprint (the counter starts at the SECOND
 *          identical round, so the trigger fires on the 4th identical
 *          round). The trigger response is an INTERVENTION, not an abort:
 *          a progressive corrective system message is injected (root-cause
 *          the failure / change the waiting strategy / stop and answer) and
 *          the repeat counter resets for a fresh window. Only after the
 *          corrective budget — HK2_STUCK_NUDGE_LIMIT, default
 *          DEFAULT_STUCK_NUDGE_LIMIT nudges — is exhausted without the
 *          model escaping the loop does the detector abort. A failing or
 *          misbehaving tool NEVER kills the run by itself; only proven,
 *          persistent no-progress after repeated correction does.
 *       b. NO_PROGRESS_TURNS — CURRENTLY UNREACHABLE: the check requires
 *          pendingToolCalls.length === 0, but the no-tool-calls return
 *          above it exits first. Kept for documentation; do not rely on it.
 *       c. ABSOLUTE_SAFETY_CAP — a very high backstop against pathological
 *          runaway; well beyond any realistic task scope.
 *   - Caller may pass maxTurns to override (e.g. for tests); production
 *     termination normally comes from (a) or the absolute cap, not a fixed
 *     task-length limit. The no-progress constant above is currently
 *     unreachable because the no-tool-call return occurs first.
 */

import { executeToolCall } from './tools.js';
import { shortHash } from '../util/hash.js';

const ABSOLUTE_SAFETY_CAP = 1000;     // pathological-runaway backstop only
const STUCK_REPEAT_LIMIT = 3;          // three repeats after the initial identical round; the 4th consecutive identical round triggers a corrective nudge
const DEFAULT_STUCK_NUDGE_LIMIT = 10;  // corrective nudges before the stuck detector may abort (HK2_STUCK_NUDGE_LIMIT overrides)
const NO_PROGRESS_TURNS = 6;           // CURRENTLY UNREACHABLE: no-tool rounds return first; retained as a documented dead check

const CACHEABLE_TOOLS = new Set(['read', 'find', 'grep', 'ast_grep', 'kb_search', 'kb_symbol', 'kb_outline', 'kb_neighbors', 'kb_callchain', 'kb_class', 'kb_refs', 'kb_implements', 'kb_knowledge', 'kb_search_knowledge']);
const CACHE_BUSTING_TOOLS = new Set(['bash', 'edit', 'write', 'ast_edit', 'resolve']);

/**
 * Resolve the corrective-nudge budget for the stuck detector from the
 * HK2_STUCK_NUDGE_LIMIT environment variable.
 *
 * - unset / empty / non-numeric / negative -> DEFAULT_STUCK_NUDGE_LIMIT
 * - explicit `0` -> 0 (nudges disabled: the very first trigger aborts,
 *   preserving the legacy fail-fast behavior for debugging)
 * - any non-negative integer -> that many nudges before aborting
 *
 * Re-read on every call (no caching) — same contract as llmApiNumOfRetries()
 * in ../llm/retries.js, so tests and long-lived REPL sessions observe
 * changes immediately.
 */
export function stuckNudgeLimit() {
  const raw = process.env.HK2_STUCK_NUDGE_LIMIT;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_STUCK_NUDGE_LIMIT;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STUCK_NUDGE_LIMIT;
  return n;
}

/**
 * Build the corrective system message injected when the stuck detector
 * fires. The nudge is DIAGNOSTIC and progressive — it states the observed
 * fact (N identical rounds), then directs the model to escape the loop:
 * root-cause a failing tool, change a polling strategy that never becomes
 * ready, or stop waiting and answer with what is known. Escaping the loop
 * (any different signature or result) resets the window; the budget only
 * runs out when the model repeatedly ignores the correction.
 *
 * `sig` is the repeat signature (for transparency), `nudgeNo` is 1-based.
 */
export function buildStuckNudgeText(sig, nudgeNo, nudgeLimit) {
  const sigPreview = String(sig || '').slice(0, 400);
  const escalation = nudgeNo >= nudgeLimit
    ? `This is the FINAL corrective notice (${nudgeNo}/${nudgeLimit}). If the very next round repeats the same call with the same result again, the run will be aborted.`
    : `Corrective notice ${nudgeNo}/${nudgeLimit}.`;
  return '## Loop correction (no progress detected)\n\n'
    + `The last ${STUCK_REPEAT_LIMIT + 1} tool-call rounds were IDENTICAL — same call and same result — so repeating this exact call again cannot make progress.\n\n`
    + `Repeated call: ${sigPreview}\n\n`
    + `${escalation} You must BREAK the loop now. Do NOT re-issue the same call unchanged. Instead:\n`
    + '1. If the tool reported an error or returned nothing useful: diagnose the ROOT CAUSE from the exact error text (bad arguments, missing dependency, wrong path, timeout, permission) and fix your invocation or take a different approach.\n'
    + '2. If you are polling and the value is legitimately unchanged: the poll is not ready yet. WAIT LONGER IN ONE CALL (e.g. a single sleep covering the full expected wait, or a larger timeout argument) instead of re-running the same short poll many times.\n'
    + '3. If the state you are waiting for may already have changed elsewhere: verify it once through a different command or source.\n'
    + '4. If no tool path can make progress: STOP calling tools and answer the user with what you have found, explicitly stating what is still unresolved.\n\n'
    + 'Choose the option that fits, act on it in this very round, and continue the task.';
}

/**
 * Single turn cycle.
 *
 * @param {object} opts
 * @param {import('../llm/client.js').LLMClient} opts.llm
 * @param {Array} opts.messages          transcript (mutated in place)
 * @param {Array} opts.tools             buildTools return value
 * @param {object} [opts.callbacks]      UI callbacks
 *   - onDelta(text)            text delta
 *   - onAssistantMessage(message, round) complete assistant message per round
 *   - onReasoning(text)        reasoning delta (optional display)
 *   - onToolCallStart(call)    tool execution begins
 *   - onToolCallEnd(call, result) tool execution finished
 *   - onTurnStart(turnIdx)
 *   - onTurnEnd(turnIdx)
 *   - onUsage({input, output, cache_read?, cache_creation?})  per-call token usage from the provider
 *   - onRetry(evt)             transient LLM failure, attempt restarted
 *   - onStuckNudge(info)       stuck detector fired: {round, signature, nudgeNo, nudgeLimit}
 *                              Fires when the corrective system message is injected. Never fatal by itself.
 * @param {number} [opts.maxTurns]
 * @param {{maxChars?: number, temperature?: number, enableReasoning?: boolean, signal?: AbortSignal}} [opts.llmOpts]
 * @param {AbortSignal} [opts.signal]
 *
 * @returns {Promise<{turns: number, lastText: string, toolCalls: number}>}
 */
export async function runLoop(opts) {
  const {
    llm, messages, tools, callbacks = {},
    maxTurns = ABSOLUTE_SAFETY_CAP,
    llmOpts = {},
    signal,
    // Async hook fired at the round boundary — after ALL tool_calls of the
    // current round finished executing, BEFORE the next LLM call starts.
    // This is the safe injection point for mid-task user input: the current
    // action completes undisturbed, and the user's follow-up instruction is
    // already in `messages` when the next LLM call reads it. Awaited so the
    // injector can do async work (e.g. transcript logging) before the next
    // call goes out. May push messages; must NOT remove or reorder existing
    // ones (the assistant tool_calls / tool result pairing must stay intact).
    onRoundBoundary,
  } = opts;

  let turns = 0;
  let totalToolCalls = 0;
  let lastText = '';
  // Per-run cache: key = `${name}|${argumentsJson}` → prior result
  const toolCache = new Map();
  // Stuck-detection state: a round counts as "no progress" only when BOTH the
  // call signature AND the observed result match the previous round. Tools
  // like plan_step are STATEFUL by design — the model may (and is told to)
  // call them repeatedly with identical arguments while each call genuinely
  // advances state ("Marked plan step 2" → "3" → "4"). Judging on signature
  // alone false-positives exactly there. The result fingerprint is computed
  // from the tool-result envelope that gets pushed to `messages`, so what the
  // detector sees matches what the model will see next round.
  let lastToolKey = null;      // `${name}|${args}`-joined round signature
  let lastResultFingerprint = null;  // shortHash of the round's results
  let identicalRepeatCount = 0;
  let noProgressTurns = 0;
  // Corrective-nudge state: when the identical-round counter trips, we inject
  // a corrective system message and RESET the repeat counter — the model gets
  // a fresh window to escape the loop. `stuckNudges` counts how many nudges
  // have been fired for CONSECUTIVELY stuck windows; it resets to zero the
  // moment any round makes real progress (different signature or result). A
  // failing tool therefore never kills the run by itself: the abort only
  // happens after nudgeLimit corrective messages have been ignored.
  const nudgeLimit = stuckNudgeLimit();
  let stuckNudges = 0;

  const toolSpec = tools && tools.length > 0 ? tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  })) : undefined;

  while (turns < maxTurns) {
    if (signal?.aborted) throw new Error('aborted');
    turns++;
    callbacks.onTurnStart?.(turns);

    let textBuf = '';
    let reasoningBuf = '';
    const pendingToolCalls = [];

    const stream = llm.stream(messages, {
      ...llmOpts,
      tools: toolSpec,
      signal,
    });

    for await (const evt of stream) {
      if (signal?.aborted) throw new Error('aborted');
      if (evt.type === 'delta') {
        textBuf += evt.text;
        callbacks.onDelta?.(evt.text);
      } else if (evt.type === 'reasoning') {
        reasoningBuf += evt.text;
        callbacks.onReasoning?.(evt.text);
      } else if (evt.type === 'tool_call') {
        pendingToolCalls.push({ id: evt.id, name: evt.name, arguments: evt.arguments });
      } else if (evt.type === 'usage') {
        // Adapter reports token usage for this LLM call. Some providers send
        // multiple usage chunks (e.g. Anthropic: message_start for input,
        // message_delta for final output). We forward each; the caller
        // aggregates.
        callbacks.onUsage?.(evt);
      } else if (evt.type === 'retry') {
        // The LLM call failed transiently and the client is retrying from
        // scratch (see lib/llm/retries.js). Everything this attempt streamed
        // so far is VOID: deltas were forwarded to onDelta / onReasoning and
        // tool_calls were queued, but the retried attempt re-generates the
        // whole turn. Reset the per-turn buffers so the final assistant
        // message reflects only the successful attempt, and tell the UI so it
        // can drop the orphaned partial render.
        textBuf = '';
        reasoningBuf = '';
        pendingToolCalls.length = 0;
        callbacks.onRetry?.(evt);
      } else if (evt.type === 'notice') {
        // Non-fatal adapter notice (e.g. an invalid modelOptions passthrough
        // key that was dropped from the request body). Forwarded to the UI but
        // never part of the assistant text — the model never saw the invalid
        // value, so it must not leak into the transcript as assistant output.
        callbacks.onNotice?.(evt);
      }
      // 'finish' / 'done' need no separate handling (stream ends naturally)
    }

    // Push and expose the complete assistant message for this round. Consumers
    // such as the transcript must persist this before tool results arrive so
    // replay can reproduce the original role/content ordering exactly.
    let assistantMessage;
    if (pendingToolCalls.length > 0) {
      assistantMessage = {
        role: 'assistant',
        content: textBuf || '',
        tool_calls: pendingToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    } else {
      assistantMessage = { role: 'assistant', content: textBuf };
      lastText = textBuf;
    }
    messages.push(assistantMessage);
    await callbacks.onAssistantMessage?.(assistantMessage, turns);

    if (pendingToolCalls.length === 0) {
      callbacks.onTurnEnd?.(turns);
      return { turns, lastText, toolCalls: totalToolCalls };
    }

    // ---- Per-round bookkeeping (stuck check runs AFTER execution) ------
    // A round counts as "no progress" only when BOTH the call signature and
    // the observed results match the previous round. Tools like plan_step are
    // STATEFUL by design — the model may (and is told to) call them repeatedly
    // with identical arguments while each call genuinely advances state
    // ("Marked plan step 2" → "3" → "4"). Judging on signature alone
    // false-positives exactly there. The result fingerprint covers the exact
    // JSON pushed to `messages`, so what the detector sees matches what the
    // model will see next round.
    const thisKey = pendingToolCalls.map(c => `${c.name}|${c.arguments || ''}`).sort().join('||');
    const roundResults = [];

    // This no-progress check is currently unreachable because a no-tool round
    // returns before it. Effective protections are the fourth identical
    // signature+result round, the absolute cap, and abort/exception paths.
    if (textBuf.trim() === '' && pendingToolCalls.length === 0) {
      noProgressTurns++;
      if (noProgressTurns >= NO_PROGRESS_TURNS) {
        throw new Error(`agent stuck: ${NO_PROGRESS_TURNS} turns with no text and no tool calls.`);
      }
    } else {
      noProgressTurns = 0;
    }

    // Execute each tool_call. Identical cacheable calls hit the per-run cache.
    // Any cache-busting call (bash/edit/write/ast_edit/resolve) clears the
    // cache before executing. kb_save_knowledge is intentionally not in this set.
    // `call.round` stamps each call with its loop round so consumers (the
    // transcript's logToolCall) can reconstruct round boundaries on replay
    // (issue #4) — the flat event stream previously couldn't tell N parallel
    // calls apart from N sequential single-call rounds.
    for (const call of pendingToolCalls) {
      call.round = turns;
      callbacks.onToolCallStart?.(call);
      const cacheKey = `${call.name}|${call.arguments || ''}`;
      let result;
      if (CACHE_BUSTING_TOOLS.has(call.name)) {
        toolCache.clear();
        result = await executeToolCall(tools, call);
      } else if (CACHEABLE_TOOLS.has(call.name) && toolCache.has(cacheKey)) {
        result = toolCache.get(cacheKey);
        // Cached KB calls still represent "the agent chose to use the KB this
        // LLM call" — the cache is just an optimization. Mark intent so the
        // per-call hint doesn't fire on a later bash/read fallback.
        const guard = tools.find(t => t.name === call.name)?._guard;
        if (call.name.startsWith('kb_')) guard?.noteKbUsage?.();
        // Refresh the guard snapshot on the returned envelope so the
        // transcript reflects this LLM call's state, not the cached one.
        result = { ...result, guard: guard?.snapshot?.() };
      } else {
        result = await executeToolCall(tools, call);
        // Only SUCCESSFUL results are cached (issue #3): a failed read/grep/
        // kb_* call may be transient (graph not yet built, IO hiccup) and
        // must not be frozen for the rest of the run — caching it would pin
        // the error and deny the model a same-run retry.
        if (CACHEABLE_TOOLS.has(call.name) && result.ok) toolCache.set(cacheKey, result);
      }
      totalToolCalls++;
      callbacks.onToolCallEnd?.(call, result);
      const resultContent = JSON.stringify(result.ok ? result.result : { error: result.error });
      roundResults.push(resultContent);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: resultContent,
      });
    }

    // ---- Stuck detection (signature + result fingerprint) ----------------
    // Evaluated here — after execution — because progress is only observable
    // from results. Same signature AND same fingerprint as the previous
    // round → count toward stuck; different results reset (stateful tool
    // advancing). The fingerprint covers the exact JSON the model sees.
    //
    // IMPORTANT: the trigger is an INTERVENTION, not an abort. A repeated
    // call can be legitimate (polling a server that is legitimately not up
    // yet — incident: `sleep 55; psql ...` x4 while PostgreSQL restarted) or
    // pathological (blindly retrying a broken invocation). Both look
    // identical from signatures+results alone, so the detector's job is to
    // CORRECT the behavior, not to kill the task: inject a progressive
    // nudge (root-cause it / change the wait strategy / stop and answer) and
    // reset the repeat window. Only after nudgeLimit nudges have been fired
    // for consecutive stuck windows without the model escaping does the
    // detector abort. This guarantees no tool failure — bash or otherwise —
    // can terminate the agent loop on its own.
    const thisFingerprint = shortHash(roundResults.join('\u0000'));
    if (thisKey === lastToolKey && thisFingerprint === lastResultFingerprint) {
      identicalRepeatCount++;
      if (identicalRepeatCount >= STUCK_REPEAT_LIMIT) {
        if (stuckNudges < nudgeLimit) {
          stuckNudges++;
          const nudgeText = buildStuckNudgeText(thisKey, stuckNudges, nudgeLimit);
          // Pushed AFTER the tool results of this round — a legal message
          // position (the tool pairing is complete). OpenAI consumes a
          // mid-stream system message natively; the Anthropic adapter lifts
          // system content into its top-level system prompt — the same
          // convention turn.js already uses for resume-context and per-turn
          // KB-context messages.
          messages.push({ role: 'system', content: nudgeText });
          // NOTE: deliberately NOT routed through onAssistantMessage — the
          // transcript's assistant_message events replay as role:'assistant',
          // but this text is guidance TO the model, not output from it. The
          // audit trail is onStuckNudge's logMeta('stuck-nudge') instead.
          callbacks.onStuckNudge?.({
            round: turns,
            signature: thisKey,
            repeats: identicalRepeatCount,
            nudgeNo: stuckNudges,
            nudgeLimit,
          });
          // Fresh grace window: the next trip needs STUCK_REPEAT_LIMIT more
          // identical rounds before the next nudge fires.
          identicalRepeatCount = 0;
        } else {
          throw new Error(`agent stuck: ${STUCK_REPEAT_LIMIT} repeated identical tool-call rounds after the initial occurrence (no progress), and ${nudgeLimit} corrective nudges were ignored. Last signature: ${thisKey}`);
        }
      }
    } else {
      identicalRepeatCount = 0;
      // Real progress observed: the escape worked (or the rounds never
      // repeated). Re-arm the full corrective budget for the next loop.
      stuckNudges = 0;
    }
    lastToolKey = thisKey;
    lastResultFingerprint = thisFingerprint;

    // ---- Round boundary: safe mid-task user-input injection point ----------
    // Every tool of this round finished; the next LLM call has not started.
    // Give the caller one await point to splice queued user instructions into
    // `messages` (appended AFTER the tool results — a legal position: the tool
    // pairing is complete, and the next LLM call sees them as fresh input).
    if (onRoundBoundary) {
      await onRoundBoundary(turns);
      if (signal?.aborted) throw new Error('aborted');
    }

    callbacks.onTurnEnd?.(turns);
  }

  throw new Error(`agent loop hit absolute safety cap (maxTurns=${maxTurns}). Set a higher cap only if you have a real reason.`);
}

export default runLoop;
