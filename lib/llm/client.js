/**
 * Unified LLM client: dispatches to the openai / anthropic adapter based on
 * config.style. Wraps the adapter stream to:
 *   - Always emit usage events during the call (progressive estimates when
 *     the provider doesn't include them in SSE), so the status bar updates
 *     live during streaming — not only at the end.
 *   - Use max() semantics for cumulative-within-call values, since adapter
 *     events are themselves cumulative snapshots (Anthropic: message_start
 *     reports input, message_delta reports final output; we take the running
 *     max rather than summing).
 *
 *   stream(messages, opts)  → async generator yielding { type, ... }
 *   complete(messages, opts) → Promise<string>
 */

import { streamOpenAI, completeOpenAI } from './openai_adapter.js';
import { streamAnthropic } from './anthropic_adapter.js';

function normalizeStyle(s) {
  const v = String(s || 'openai').toLowerCase().trim();
  if (v === 'anthropic' || v.startsWith('anthropic-')) return 'anthropic';
  if (v === 'openai' || v.startsWith('openai-')) return 'openai';
  return v;
}

/** Rough chars → tokens estimate (English-ish text averages ~4 chars/token). */
function estimateTokensFromChars(n) {
  return Math.ceil((n || 0) / 4);
}

/** Sum content size across messages (stringify non-string fields). */
function estimateInputTokens(messages) {
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

export class LLMClient {
  constructor(config) {
    this.config = config || {};
  }

  async* stream(messages, opts = {}) {
    const args = {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      messages,
      maxChars: opts.maxChars ?? this.config.maxChars ?? 65536,
      temperature: opts.temperature ?? this.config.temperature ?? 0.2,
      enableReasoning: opts.enableReasoning ?? this.config.enableReasoning ?? true,
      timeoutMs: opts.timeoutMs ?? this.config.timeout ?? 600000,
      signal: opts.signal,
      tools: opts.tools,
      headers: this.config.headers || undefined,
    };
    if (!args.baseUrl) throw new Error('LLM baseUrl not configured');
    if (!args.apiKey) throw new Error('LLM apiKey not configured');
    if (!args.model) throw new Error('LLM model not configured');

    const style = normalizeStyle(this.config.style);
    let inner;
    if (style === 'anthropic') inner = streamAnthropic(args);
    else if (style === 'openai') inner = streamOpenAI(args);
    else throw new Error(`Unknown LLM style: ${style}`);

    // ----- Progressive usage tracking -----
    // The wrapper maintains `currentInput` / `currentOutput` as the best
    // cumulative-within-call values seen so far — either from adapter
    // usage events or from progressive estimates. It emits a usage snapshot
    // whenever either value advances meaningfully, so callers (status bar)
    // see live updates during streaming rather than only at the end.
    let currentInput = 0;
    let currentOutput = 0;
    let lastSentInput = -1;
    let lastSentOutput = -1;
    let outputChars = 0;
    // Whether the adapter itself reported a real value (suppressed estimate
    // once a real value arrives, so we never report a worse number than the
    // provider gave us).
    let realInputReported = false;
    let realOutputReported = false;
    // Throttle: don't emit more than one snapshot per ~8 tokens of progress
    const OUTPUT_EMIT_STEP = 8;

    const maybeEmit = function* (force = false) {
      const inputChanged = currentInput !== lastSentInput;
      const outputChanged = currentOutput !== lastSentOutput;
      if (!force && !inputChanged && !outputChanged) return;
      lastSentInput = currentInput;
      lastSentOutput = currentOutput;
      const evt = { type: 'usage', input: currentInput, output: currentOutput };
      if (!realInputReported && currentInput > 0) evt.inputEstimated = true;
      if (!realOutputReported && currentOutput > 0) evt.outputEstimated = true;
      yield evt;
    };

    // 1. Emit an immediate input estimate BEFORE the stream starts so the
    //    status bar shows a non-zero input count from the very first chunk.
    currentInput = estimateInputTokens(messages);
    yield* maybeEmit(true);

    for await (const evt of inner) {
      if (evt.type === 'usage') {
        if (typeof evt.input === 'number' && evt.input > 0) {
          if (evt.input > currentInput) currentInput = evt.input;
          realInputReported = true;
        }
        if (typeof evt.output === 'number' && evt.output > 0) {
          if (evt.output > currentOutput) currentOutput = evt.output;
          realOutputReported = true;
        }
        if (typeof evt.cache_read === 'number') {
          yield { type: 'usage_cache', read: evt.cache_read, creation: evt.cache_creation || 0 };
        }
        yield* maybeEmit();
      } else {
        if (evt.type === 'delta' && typeof evt.text === 'string') {
          outputChars += evt.text.length;
          // Progressive output estimate (only if the adapter hasn't already
          // reported a real output value, which it usually does at the end).
          if (!realOutputReported) {
            const est = estimateTokensFromChars(outputChars);
            if (est > currentOutput) currentOutput = est;
            // Throttle: emit when output advances by OUTPUT_EMIT_STEP
            if (currentOutput - lastSentOutput >= OUTPUT_EMIT_STEP) {
              yield* maybeEmit();
            }
          }
        }
        yield evt;
      }
    }

    // Final snapshot — always emit so caller sees the post-stream values.
    yield* maybeEmit(true);
  }

  async complete(messages, opts = {}) {
    const style = normalizeStyle(this.config.style);
    if (style === 'anthropic') {
      let out = '';
      for await (const evt of this.stream(messages, opts)) {
        if (evt.type === 'delta') out += evt.text;
      }
      return out;
    }
    const args = {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      messages,
      maxChars: opts.maxChars ?? this.config.maxChars ?? 65536,
      temperature: opts.temperature ?? this.config.temperature ?? 0.2,
      timeoutMs: opts.timeoutMs ?? this.config.timeout ?? 600000,
    };
    return completeOpenAI(args);
  }
}

export default LLMClient;
