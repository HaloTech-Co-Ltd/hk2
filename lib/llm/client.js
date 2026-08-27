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
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与
 * 知识产权相关的权利，以及上述权利的所有续期和延长，无论此类权利是否在某
 * 个法域内的相关机构注册。
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
 * for use in any inherently dangerous applications or applications that
 * could create a risk of personal injury. If you use this software in
 * dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------*/

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
 *   - RETRY transient failures (see ./retries.js): network errors, HTTP
 *     408/429/5xx, and timeouts are retried up to HK2_LLMAPI_NUMOFRETRIES
 *     times (default 10) with exponential backoff. A `{ type: 'retry' }`
 *     event is emitted before each backoff sleep so consumers can reset
 *     any partial output they accumulated from the failed attempt —
 *     deltas already yielded from a broken attempt are NOT part of the
 *     retried call's output. User aborts (opts.signal) are never retried
 *     and never held hostage by a backoff sleep. Non-transient errors
 *     (other 4xx, config errors) fail fast without burning backoffs.
 *
 *   stream(messages, opts)  → async generator yielding { type, ... }
 *   complete(messages, opts) → Promise<string>
 */

import { streamOpenAI, completeOpenAI } from './openai_adapter.js';
import { streamAnthropic } from './anthropic_adapter.js';
import { llmApiTimeoutMs } from './timeout.js';
import {
  llmApiNumOfRetries,
  isRetryableLlmError,
  retryBackoffMs,
  abortableSleep,
} from './retries.js';

function normalizeStyle(s) {
  const v = String(s || 'openai').toLowerCase().trim();
  if (v === 'anthropic' || v.startsWith('anthropic-')) return 'anthropic';
  if (v === 'openai' || v.startsWith('openai-')) return 'openai';
  return v;
}

/** Rough chars → tokens estimate (English-ish text averages ~4 chars/token). */
export function estimateTokensFromChars(n) {
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

  /**
   * Shared args for stream()/complete(): built from config + per-call opts.
   * Keeping ONE builder prevents the two paths from drifting apart again
   * (issue #6: complete() used to miss signal/headers and all fail-fast
   * checks that stream() had).
   */
  _buildArgs(messages, opts = {}) {
    const args = {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      messages,
      maxChars: opts.maxChars ?? this.config.maxChars ?? 65536,
      // Explicit per-model maxTokens (from /model add|set --max-tokens) wins
      // over the adapters' maxChars-derived estimate; adapters fall back to
      // the estimate when this is unset (issue #5).
      maxOutputTokens: opts.maxOutputTokens ?? this.config.maxTokens ?? undefined,
      temperature: opts.temperature ?? this.config.temperature ?? 0.2,
      enableReasoning: opts.enableReasoning ?? this.config.enableReasoning ?? true,
      modelType: this.config.modelType || undefined,
      modelOptions: this.config.modelOptions || undefined,
      timeoutMs: opts.timeoutMs ?? this.config.timeout ?? llmApiTimeoutMs(),
      signal: opts.signal,
      headers: this.config.headers || undefined,
    };
    // Config errors fail fast — never retried (retrying can't fix them).
    if (!args.baseUrl) throw new Error('LLM baseUrl not configured');
    if (!args.apiKey) throw new Error('LLM apiKey not configured');
    if (!args.model) throw new Error('LLM model not configured');

    const style = normalizeStyle(this.config.style);
    if (style !== 'anthropic' && style !== 'openai') {
      throw new Error(`Unknown LLM style: ${style}`);
    }
    return { args, style };
  }

  async* stream(messages, opts = {}) {
    const { args, style } = this._buildArgs(messages, opts);
    args.tools = opts.tools;

    const maxRetries = llmApiNumOfRetries();
    let retriesUsed = 0;

    // ----- Retry loop -----
    // Each attempt re-invokes the adapter (fresh fetch + fresh timeout
    // timer). All per-call usage-tracking state below is RESET at the top
    // of every attempt: the values observed during a failed attempt are
    // meaningless for the retried call, and a stale partial-output
    // estimate would otherwise suppress the new attempt's estimate.
    while (true) {
      const inner = style === 'anthropic'
        ? streamAnthropic(args)
        : streamOpenAI(args);

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

      try {
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
        return; // success — leave the retry loop
      } catch (err) {
        // User abort: NEVER retry, and never sit through a backoff sleep.
        // This check must come before isRetryableLlmError() because an abort
        // surfaces as "... request failed: This operation was aborted", which
        // textually looks transient.
        if (opts.signal?.aborted) throw err;
        // Deterministic client errors (4xx, config, bad style) fail fast.
        if (!isRetryableLlmError(err)) throw err;
        if (retriesUsed >= maxRetries) {
          throw new Error(
            `LLM request failed after ${retriesUsed + 1} attempts: ${err.message}`
          );
        }
        retriesUsed++;
        const delayMs = retryBackoffMs(retriesUsed);
        // Tell consumers the failed attempt's partial output is void: they
        // should discard deltas/reasoning/tool_calls yielded so far for this
        // call and expect a fresh stream. (runLoop and the review phases
        // reset their buffers on this event.)
        yield { type: 'retry', attempt: retriesUsed, maxRetries, delayMs, error: err.message };
        await abortableSleep(delayMs, opts.signal);
        // Aborted during the backoff sleep → exit as a user abort, matching
        // runLoop's convention of throwing Error('aborted').
        if (opts.signal?.aborted) throw new Error('aborted');
        // loop continues with a fresh adapter stream and reset usage state
      }
    }
  }

  async complete(messages, opts = {}) {
    const style = normalizeStyle(this.config.style);
    if (style === 'anthropic') {
      // Goes through this.stream — inherits the retry loop above. This
      // drain loop is itself a retry-event consumer: reset `out` when the
      // client restarts the call, or a failed attempt's partial text would
      // be glued in front of the retried attempt's output.
      let out = '';
      for await (const evt of this.stream(messages, opts)) {
        if (evt.type === 'retry') out = '';
        else if (evt.type === 'delta') out += evt.text;
      }
      return out;
    }
    // Built via the SAME shared builder as stream() (incl. signal / headers /
    // maxOutputTokens and all fail-fast checks) — issue #6: the openai branch
    // used to construct args by hand and silently dropped signal + headers.
    const { args } = this._buildArgs(messages, opts);
    // Same retry policy as stream(), but as a plain promise loop (no events
    // to emit — complete() has no consumer listening mid-call).
    const maxRetries = llmApiNumOfRetries();
    let retriesUsed = 0;
    while (true) {
      try {
        return await completeOpenAI(args);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (!isRetryableLlmError(err)) throw err;
        if (retriesUsed >= maxRetries) {
          throw new Error(
            `LLM request failed after ${retriesUsed + 1} attempts: ${err.message}`
          );
        }
        retriesUsed++;
        await abortableSleep(retryBackoffMs(retriesUsed), opts.signal);
        if (opts.signal?.aborted) throw new Error('aborted');
      }
    }
  }
}

export default LLMClient;
