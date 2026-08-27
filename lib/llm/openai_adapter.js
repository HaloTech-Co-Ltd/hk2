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
 * OpenAI-style adapter: POST ${baseUrl}/v1/chat/completions
 *
 * Accepted message shapes:
 *   - {role:'system'|'user'|'assistant', content}
 *   - {role:'assistant', tool_calls: [{id, type:'function', function:{name, arguments}}]}
 *   - {role:'tool', tool_call_id, content}
 *
 * Stream (async generator) yields unified events:
 *   { type: 'delta', text }                       body text chunk
 *   { type: 'reasoning', text }                   reasoning chunk (e.g. GLM-4.7 reasoning_content)
 *   { type: 'tool_call', id, name, arguments }    one fully-assembled tool call (emitted after stream ends)
 *   { type: 'finish', reason }                    finish ('stop' | 'tool_calls' | 'length')
 *   { type: 'done' }                              generator end
 */

import { consumeSSE } from './sse.js';
import { modelTypeReasoningEffort } from '../config/home.js';
import { llmApiTimeoutMs } from './timeout.js';

/**
 * Apply model-type-specific features to an OpenAI-style /v1/chat/completions
 * request body (in place). Only types with declared features (see
 * MODEL_TYPE_FEATURES in lib/config/home.js) are touched; every other body
 * key is left alone.
 *
 * glm-5.3 (BigModel): deep-reasoning model —
 *   thinking:            { type: 'enabled' }   (deep reasoning on)
 *   reasoning_effort:    'max' | 'high' | 'low'  (default 'max', the
 *                         recommended deep-reasoning level; normalized from
 *                         the model's --model-options)
 */
export function applyModelTypeFeatures(body, { modelType, modelOptions, enableReasoning }) {
  if (enableReasoning === false) return;
  const effort = modelTypeReasoningEffort(modelType, modelOptions);
  if (!effort) return;
  if (modelType === 'glm-5.3') {
    // BigModel deep-reasoning: thinking on + the effort selector, mirroring
    // the v4 /chat/completions body shape.
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = effort;
  }
}


export async function* streamOpenAI({ baseUrl, apiKey, model, messages, maxChars, temperature, enableReasoning, modelType, modelOptions, timeoutMs, signal, tools, headers }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model,
    messages,
    stream: true,
    temperature: temperature ?? 0.2,
    stream_options: { include_usage: true },
  };
  if (maxChars) body.max_tokens = Math.min(32768, Math.max(256, Math.floor(maxChars / 4)));
  if (enableReasoning === false) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  applyModelTypeFeatures(body, { modelType, modelOptions, enableReasoning });
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const ctrl = new AbortController();
  // timeoutMs === 0 means NO timeout: wait for the stream to finish naturally
  // (plan-review / code-review rely on this — a review cut off mid-reply loses
  // its verdict JSON). clearTimeout(null) below is a safe no-op.
  const timeoutHandle = timeoutMs === 0
    ? null
    : setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs || llmApiTimeoutMs());
  // Forward user aborts to this request only, and detach the listener when
  // the request settles so a retried call reusing the same signal doesn't
  // accumulate listeners (Node warns past 10 on one EventEmitter).
  const onUserAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onUserAbort, { once: true });
  }

  let resp;
  try {
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
    };
    if (headers) Object.assign(reqHeaders, headers);
    resp = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener('abort', onUserAbort);
    // Surface the undici CAUSE code: retries.js classifies transport
    // failures by whether the request can already have been delivered
    // (ECONNREFUSED/ENOTFOUND = never left vs ECONNRESET/ETIMEDOUT = maybe).
    const cause = err?.cause?.code ? ` (${err.cause.code})` : '';
    throw new Error(`OpenAI request failed: ${err.message}${cause}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    clearTimeout(timeoutHandle);
    signal?.removeEventListener('abort', onUserAbort);
    throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 500)}`);
  }

  // Aggregate tool_calls by index
  const pendingToolCalls = new Map();   // index → {id, name, arguments}
  let finishReason = null;

  try {
    for await (const evt of iterateStream(resp, ctrl)) {
      if (evt.type === 'delta') yield evt;
      else if (evt.type === 'reasoning') yield evt;
      else if (evt.type === 'usage') yield evt;
      else if (evt.type === 'tool_call_delta') {
        const idx = evt.index;
        let cur = pendingToolCalls.get(idx);
        if (!cur) {
          cur = { id: evt.id || `call_${idx}`, name: '', arguments: '' };
          pendingToolCalls.set(idx, cur);
        }
        if (evt.id) cur.id = evt.id;
        if (evt.name) cur.name = cur.name + evt.name;
        if (evt.argsDelta) cur.arguments = cur.arguments + evt.argsDelta;
      } else if (evt.type === 'finish') {
        finishReason = evt.reason;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener('abort', onUserAbort);
  }

  // Emit aggregated tool_call events
  const sortedIdx = Array.from(pendingToolCalls.keys()).sort((a, b) => a - b);
  for (const idx of sortedIdx) {
    const tc = pendingToolCalls.get(idx);
    yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments };
  }
  yield { type: 'finish', reason: finishReason || 'stop' };
  yield { type: 'done' };
}

async function* iterateStream(resp, ctrl) {
  for await (const evt of consumeStreamAsync(resp)) {
    // Mid-stream transport failure (connection reset / truncated SSE).
    // Distinguish aborts from genuine network failures:
    //   - USER abort (ESC / opts.signal): end the stream quietly, exactly
    //     like the pre-retry behavior — the caller owns the signal and
    //     decides what an abort means (runLoop throws 'aborted' itself).
    //   - TIMEOUT abort (our own timer, reason.message === 'timeout') and
    //     every non-abort network failure: THROW so lib/llm/client.js can
    //     retry. Previously these were swallowed here ({__error} fell
    //     through the JSON.parse catch) and the stream just ENDED, silently
    //     delivering a truncated answer as if the model had finished.
    if (evt.__error) {
      const sig = ctrl.signal;
      const isTimeoutAbort = sig.aborted && String(sig.reason?.message || '') === 'timeout';
      if (sig.aborted && !isTimeoutAbort) return;
      throw new Error(`OpenAI request failed: ${evt.__error.message}`);
    }
    if (evt.data === '[DONE]') return;
    let json;
    try { json = JSON.parse(evt.data); } catch { continue; }
    // Usage chunk: when include_usage=true, OpenAI sends a final chunk with
    // choices: [] and a top-level `usage` object. Emit before skipping.
    if (json.usage) {
      yield {
        type: 'usage',
        input: json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0,
        output: json.usage.completion_tokens ?? json.usage.output_tokens ?? 0,
        cache_read: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
        total: json.usage.total_tokens ?? 0,
      };
    }
    const choice = json.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) yield { type: 'delta', text: delta.content };
    if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
    if (delta.reasoning) yield { type: 'reasoning', text: delta.reasoning };
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        yield {
          type: 'tool_call_delta',
          index: typeof tc.index === 'number' ? tc.index : 0,
          id: tc.id || null,
          name: tc.function?.name || '',
          argsDelta: tc.function?.arguments || '',
        };
      }
    }
    if (choice.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
  }
}

async function* consumeStreamAsync(resp) {
  const events = [];
  let resolve;
  let waitPromise = new Promise(r => { resolve = r; });
  let done = false;

  consumeSSE(resp.body, (evt) => {
    events.push(evt);
    resolve();
    waitPromise = new Promise(r => { resolve = r; });
  }, () => {
    done = true;
    resolve();
  }).catch(err => {
    done = true;
    events.push({ __error: err });
    resolve();
  });

  while (true) {
    if (events.length > 0) {
      yield events.shift();
    } else if (done) {
      return;
    } else {
      await waitPromise;
    }
  }
}

export async function completeOpenAI({ baseUrl, apiKey, model, messages, maxChars, temperature, modelType, modelOptions, enableReasoning, timeoutMs, headers }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model,
    messages,
    stream: false,
    temperature: temperature ?? 0.2,
  };
  if (maxChars) body.max_tokens = Math.min(32768, Math.max(256, Math.floor(maxChars / 4)));
  applyModelTypeFeatures(body, { modelType, modelOptions, enableReasoning });

  const ctrl = new AbortController();
  // timeoutMs === 0 means NO timeout (mirrors the streaming path).
  const timeoutHandle = timeoutMs === 0
    ? null
    : setTimeout(() => ctrl.abort(), timeoutMs || llmApiTimeoutMs());

  try {
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    if (headers) Object.assign(reqHeaders, headers);
    const resp = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 500)}`);
    }
    const json = await resp.json();
    return json.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeoutHandle);
  }
}
