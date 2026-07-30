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
 * (read / find / grep / kb_*) within a single runLoop invocation return
 * the cached result instead of re-executing, so the LLM doesn't burn
 * turns re-asking the same question. Cache is invalidated by any
 * write/edit/bash call (which may change underlying state).
 *
 * Loop termination — deliberately NOT a fixed cap:
 *   - The agent runs as many turns as the task requires (task-driven).
 *   - Safety stops it from looping forever:
 *       a. STUCK_REPEAT_LIMIT consecutive identical tool calls (no progress)
 *       b. NO_PROGRESS_TURNS consecutive turns with neither new text nor
 *          new tool activity
 *       c. ABSOLUTE_SAFETY_CAP — a very high backstop against pathological
 *          runaway; well beyond any realistic task scope.
 *   - Caller may pass maxTurns to override (e.g. for tests); production
 *     code should let termination come from (a)/(b), not a fixed number.
 */

import { executeToolCall } from './tools.js';

const ABSOLUTE_SAFETY_CAP = 1000;     // pathological-runaway backstop only
const STUCK_REPEAT_LIMIT = 3;          // N identical tool calls in a row → abort
const NO_PROGRESS_TURNS = 6;           // N turns with no deltas and no tool calls → abort

const CACHEABLE_TOOLS = new Set(['read', 'find', 'grep', 'ast_grep', 'kb_search', 'kb_symbol', 'kb_outline', 'kb_neighbors', 'kb_callchain', 'kb_class', 'kb_refs', 'kb_implements', 'kb_knowledge', 'kb_search_knowledge']);
const CACHE_BUSTING_TOOLS = new Set(['bash', 'edit', 'write', 'ast_edit', 'resolve']);

/**
 * Single turn cycle.
 *
 * @param {object} opts
 * @param {import('../llm/client.js').LLMClient} opts.llm
 * @param {Array} opts.messages          transcript (mutated in place)
 * @param {Array} opts.tools             buildTools return value
 * @param {object} [opts.callbacks]      UI callbacks
 *   - onDelta(text)            text delta
 *   - onReasoning(text)        reasoning delta (optional display)
 *   - onToolCallStart(call)    tool execution begins
 *   - onToolCallEnd(call, result) tool execution finished
 *   - onTurnStart(turnIdx)
 *   - onTurnEnd(turnIdx)
 *   - onUsage({input, output, cache_read?, cache_creation?})  per-call token usage from the provider
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
  } = opts;

  let turns = 0;
  let totalToolCalls = 0;
  let lastText = '';
  // Per-run cache: key = `${name}|${argumentsJson}` → prior result
  const toolCache = new Map();
  // Stuck-detection state
  let lastToolKey = null;
  let identicalRepeatCount = 0;
  let noProgressTurns = 0;

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
      }
      // 'finish' / 'done' need no separate handling (stream ends naturally)
    }

    // Push the assistant message: with tool_calls if any, otherwise plain text
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: textBuf || '',
        tool_calls: pendingToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
    } else {
      messages.push({ role: 'assistant', content: textBuf });
      lastText = textBuf;
    }

    if (pendingToolCalls.length === 0) {
      callbacks.onTurnEnd?.(turns);
      return { turns, lastText, toolCalls: totalToolCalls };
    }

    // Stuck detection: identical tool-call signature repeated
    const thisKey = pendingToolCalls.map(c => `${c.name}|${c.arguments || ''}`).sort().join('||');
    if (thisKey === lastToolKey) {
      identicalRepeatCount++;
      if (identicalRepeatCount >= STUCK_REPEAT_LIMIT) {
        throw new Error(`agent stuck: ${STUCK_REPEAT_LIMIT} identical tool-call rounds in a row (no progress). Last signature: ${thisKey}`);
      }
    } else {
      identicalRepeatCount = 0;
      lastToolKey = thisKey;
    }

    // Stuck detection: no new text and no tool progress for too many turns
    if (textBuf.trim() === '' && pendingToolCalls.length === 0) {
      noProgressTurns++;
      if (noProgressTurns >= NO_PROGRESS_TURNS) {
        throw new Error(`agent stuck: ${NO_PROGRESS_TURNS} turns with no text and no tool calls.`);
      }
    } else {
      noProgressTurns = 0;
    }

    // Execute each tool_call. Identical cacheable calls hit the per-run cache.
    // Any cache-busting call (bash/edit/write) clears the cache before executing.
    for (const call of pendingToolCalls) {
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
        if (CACHEABLE_TOOLS.has(call.name)) toolCache.set(cacheKey, result);
      }
      totalToolCalls++;
      callbacks.onToolCallEnd?.(call, result);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(result.ok ? result.result : { error: result.error }),
      });
    }

    callbacks.onTurnEnd?.(turns);
  }

  throw new Error(`agent loop hit absolute safety cap (maxTurns=${maxTurns}). Set a higher cap only if you have a real reason.`);
}

export default runLoop;
