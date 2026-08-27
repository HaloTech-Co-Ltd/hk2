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
 * Anthropic-style adapter: POST ${baseUrl}/v1/messages
 *
 * Accepted message shapes (mixed with OpenAI style):
 *   - {role:'system'|'user'|'assistant', content}
 *   - {role:'assistant', tool_calls:[{id, function:{name, arguments}}]}
 *   - {role:'tool', tool_call_id, content}
 * Stream output (generator):
 *   { type:'delta', text }
 *   { type:'reasoning', text }
 *   { type:'tool_call', id, name, arguments }
 *   { type:'finish', reason }
 *   { type:'done' }
 */

import { fetchWithRetry } from './retry_fetch.js';
import { consumeSSE } from './sse.js';
import { modelTypeReasoningEffort } from '../config/home.js';
import { llmApiTimeoutMs } from './timeout.js';

/**
 * Apply model-type-specific features to an Anthropic-style /v1/messages
 * request body (in place). See MODEL_TYPE_FEATURES in lib/config/home.js;
 * the OpenAI-style counterpart is applyModelTypeFeatures in
 * openai_adapter.js (both consume the same declaration).
 *
 * glm-5.3 (BigModel anthropic-compatible endpoint): a deep-reasoning model.
 * The Anthropic-style body already carries `thinking` when reasoning is on
 * (set below); the model-type declaration adds the effort selector as a
 * top-level `reasoning_effort` field (max = default/recommended, high, low),
 * mirroring the v4 /chat/completions API so both protocols expose the same
 * knob. Reasoning off → neither field is touched.
 */
function applyModelTypeFeatures(body, { modelType, modelOptions, enableReasoning }) {
  if (enableReasoning === false) return;
  const effort = modelTypeReasoningEffort(modelType, modelOptions);
  if (effort) body.reasoning_effort = effort;
}


export async function* streamAnthropic({ baseUrl, apiKey, model, messages, modelType, modelOptions, maxChars, temperature, enableReasoning, timeoutMs, signal, tools, headers, onRetry }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  // Extract system message
  let system = '';
  const userAssistant = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n' : '') + m.content;
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      // OpenAI-style assistant tool_calls → Anthropic content blocks
      const blocks = [];
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input;
        try { input = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); }
        catch { input = {}; }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input,
        });
      }
      userAssistant.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      // OpenAI-style tool result -> Anthropic tool_result block.
      // CRITICAL: Anthropic requires ALL tool_results for the tool_use blocks in
      // the immediately preceding assistant message to live in ONE following
      // user message. The agent loop pushes each result as its own role:'tool'
      // message, so we must coalesce consecutive role:'tool' messages into a
      // single user turn. Emitting them as separate user turns leaves the 2nd+
      // tool_use without a result in the very next message -> HTTP 400
      // ("tool_use ids found without tool_result blocks immediately after").
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || {}),
      };
      const prev = userAssistant[userAssistant.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) &&
          prev.content.every(b => !b || b.type === 'tool_result')) {
        prev.content.push(block);
      } else {
        userAssistant.push({ role: 'user', content: [block] });
      }
    } else {
      userAssistant.push({ role: m.role, content: m.content });
    }
  }

  // ---- Sanitize tool_use / tool_result pairing ----
  // Anthropic strictly requires every assistant `tool_use` block to be
  // immediately followed by a user `tool_result` with a matching id, and
  // rejects orphaned `tool_result` blocks. The conversation history can be
  // corrupted upstream - context compaction strips `tool` messages but keeps
  // the assistant `tool_calls`; an interrupted turn leaves a trailing
  // assistant `tool_use` with no result - which then 400s on the next call.
  // Repair both directions here so a broken history never reaches the API.
  const resultIds = new Set();
  for (const m of userAssistant) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'tool_result' && b.tool_use_id) resultIds.add(b.tool_use_id);
      }
    }
  }
  const survivingUseIds = new Set();
  const cleaned = [];
  for (const m of userAssistant) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      // Drop tool_use blocks whose result was lost (compaction / abort).
      const filtered = m.content.filter(b => !b || b.type !== 'tool_use' || (b.id && resultIds.has(b.id)));
      for (const b of filtered) if (b && b.type === 'tool_use') survivingUseIds.add(b.id);
      if (filtered.length === 0) continue;            // drop empty assistant turn
      cleaned.push({ role: 'assistant', content: filtered });
    } else if (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result')) {
      // Drop tool_result blocks whose tool_use didn't survive (reverse orphan).
      const filtered = m.content.filter(b => !b || b.type !== 'tool_result' || (b.tool_use_id && survivingUseIds.has(b.tool_use_id)));
      if (filtered.length === 0) continue;            // drop empty user turn
      cleaned.push({ role: 'user', content: filtered });
    } else {
      cleaned.push(m);
    }
  }
  // Adjacency enforcement (defense-in-depth on top of coalescing above).
  // Even after the existence-based pass, Anthropic demands that the message
  // IMMEDIATELY after an assistant turn carries a tool_result for EVERY
  // tool_use in that turn. If a tool_use's result landed in a later message
  // (e.g. history was hand-edited / replayed out of order) the existence pass
  // keeps it but Anthropic still 400s. Drop any tool_use whose result is not in
  // the very next user message, then re-prune resulting orphans.
  for (let i = 0; i < cleaned.length; i++) {
    const m = cleaned[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const useIds = m.content.filter(b => b && b.type === 'tool_use' && b.id).map(b => b.id);
    if (useIds.length === 0) continue;
    const next = cleaned[i + 1];
    const nextResultIds = new Set();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content) if (b && b.type === 'tool_result' && b.tool_use_id) nextResultIds.add(b.tool_use_id);
    }
    const adjacentIds = useIds.filter(id => nextResultIds.has(id));
    if (adjacentIds.length === useIds.length) continue;     // all paired adjacently
    // Some tool_use lacks an adjacent result -> drop those blocks. If none
    // remain adjacent, drop the whole tool_use set (keeps any text block).
    const adjacentSet = new Set(adjacentIds);
    m.content = m.content.filter(b => !b || b.type !== 'tool_use' || adjacentSet.has(b.id));
  }
  // Re-prune: drop empty turns and reverse-orphans created by the adjacency drop.
  const rePruned = [];
  const reSurvivingUseIds = new Set();
  for (const m of cleaned) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.type === 'tool_use' && b.id) reSurvivingUseIds.add(b.id);
      if (m.content.length === 0) continue;
      rePruned.push(m);
    } else if (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result')) {
      const filtered = m.content.filter(b => !b || b.type !== 'tool_result' || (b.tool_use_id && reSurvivingUseIds.has(b.tool_use_id)));
      if (filtered.length === 0) continue;
      rePruned.push({ role: 'user', content: filtered });
    } else {
      rePruned.push(m);
    }
  }
  cleaned.length = 0;
  cleaned.push(...rePruned);
  // Anthropic requires the first non-system message to be a user turn; a
  // leftover leading assistant (e.g. after compaction) would 400.
  while (cleaned.length > 0 && cleaned[0].role === 'assistant') cleaned.shift();

  // ---- Coalesce adjacent user turns (AFTER pairing sanitize) --------------
  // Runs LAST, deliberately: the pairing passes above must judge adjacency
  // on the ORIGINAL sequence (a tool_result that landed in a later message
  // than the interjected user text is corrupted history and its tool_use is
  // dropped), not on a shape we synthesized by merging. Two consecutive
  // user turns are legal in the OpenAI-style history — e.g. a mid-task
  // instruction injected right after the tool-result user turn by runLoop's
  // onRoundBoundary — but Anthropic demands strict user/assistant
  // alternation and 400s on "unexpected role user". Merge them into ONE: a
  // string user turn following a tool_result turn becomes a { type: 'text' }
  // block appended to that turn (Anthropic's canonical "tool_result + text"
  // mixed form); string+string merges keep a string.
  {
    const coalesced = [];
    for (const m of cleaned) {
      const prev = coalesced[coalesced.length - 1];
      if (m.role === 'user' && prev && prev.role === 'user') {
        if (Array.isArray(prev.content) && typeof m.content === 'string') {
          prev.content.push({ type: 'text', text: m.content });
        } else if (typeof prev.content === 'string' && Array.isArray(m.content)) {
          // Rare (hand-edited history): string user turn followed by a
          // tool_result array turn. Keep every block: results first, then the
          // texts in original order.
          const texts = m.content.filter(b => b && b.type === 'text');
          const others = m.content.filter(b => !b || b.type !== 'text');
          prev.content = [...others, { type: 'text', text: prev.content }, ...texts];
        } else if (typeof prev.content === 'string' && typeof m.content === 'string') {
          prev.content = prev.content + '\n\n' + m.content;
        } else {
          // array+array (or unusual shapes): concatenate blocks
          prev.content = [...(Array.isArray(prev.content) ? prev.content : [prev.content]),
                          ...(Array.isArray(m.content) ? m.content : [m.content])];
        }
      } else {
        coalesced.push(m);
      }
    }
    cleaned.length = 0;
    cleaned.push(...coalesced);
  }
  const messagesOut = cleaned;

  const charBudget = maxChars || 65536;
  // When thinking is enabled, budget_tokens is DEDUCTED from max_tokens by the
  // Anthropic API. So max_tokens must be strictly greater than budget_tokens,
  // leaving room for the actual text answer. We split: 40% for thinking,
  // 60% for text (both capped to API limits).
  const thinkingBudget = Math.min(16000, Math.floor(charBudget / 4 * 0.4));
  const textBudget = Math.min(64000, Math.max(4096, Math.floor(charBudget / 4 * 0.6)));
  const totalMaxTokens = thinkingBudget + textBudget;

  const body = {
    model,
    messages: messagesOut,
    stream: true,
    system: system || undefined,
    max_tokens: totalMaxTokens,
    // Anthropic requires temperature=1 when thinking is enabled; otherwise the
    // API silently returns empty content. Only apply the caller's temperature
    // when thinking is off.
    temperature: (enableReasoning !== false) ? 1 : (temperature ?? 0.2),
  };
  if (enableReasoning !== false) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }
  applyModelTypeFeatures(body, { modelType, modelOptions, enableReasoning });
  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.parameters,
    }));
  }

  const ctrl = new AbortController();
  // timeoutMs === 0 means NO timeout: wait for the stream to finish naturally
  // (plan-review / code-review rely on this — a review cut off mid-reply loses
  // its verdict JSON). clearTimeout(null) below is a safe no-op.
  const timeoutHandle = timeoutMs === 0
    ? null
    : setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs || llmApiTimeoutMs());
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason));

  let resp;
  try {
    resp = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Send BOTH Anthropic's native `x-api-key` header AND the OpenAI-style
        // `Authorization: Bearer` header. The official Anthropic API and
        // gateways that mirror it (e.g. BigModel's anthropic-compatible
        // endpoint) authenticate via `x-api-key`, so that header stays. Some
        // Anthropic-protocol-compatible local servers (observed: a local
        // glm-4.7 deployment at 10.16.6.162:18000) only honor
        // `Authorization: Bearer` and return `401 Unauthorized` without it.
        // Sending both is harmless to the former (they ignore the bearer
        // header) and mandatory for the latter, keeping every provider working.
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'Accept': 'text/event-stream',
        ...(headers || {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }, { onRetry });
  } catch (err) {
    clearTimeout(timeoutHandle);
    throw new Error(`Anthropic request failed: ${err.message}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    clearTimeout(timeoutHandle);
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 500)}`);
  }

  // Aggregate tool_use blocks by index
  const pending = new Map();   // index → {id, name, input:''}
  let finishReason = null;

  try {
    for await (const evt of iterateStream(resp)) {
      if (evt.type === 'delta') yield evt;
      else if (evt.type === 'reasoning') yield evt;
      else if (evt.type === 'usage') yield evt;
      else if (evt.type === 'tool_use_start') {
        pending.set(evt.index, { id: evt.id, name: evt.name, input: '' });
      } else if (evt.type === 'tool_use_delta') {
        const cur = pending.get(evt.index);
        if (cur) cur.input += evt.delta;
      } else if (evt.type === 'tool_use_stop') {
        const cur = pending.get(evt.index);
        if (cur) {
          yield { type: 'tool_call', id: cur.id, name: cur.name, arguments: cur.input };
          pending.delete(evt.index);
        }
      } else if (evt.type === 'finish') {
        finishReason = evt.reason;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Flush any tool_use blocks that started but never received a
  // content_block_stop (the stream ended, was interrupted, or an
  // Anthropic-compatible gateway omitted the final stop event). Without
  // this, a plan_step tool call that the model DID emit would be silently
  // dropped: the agent loop would see zero pending tool calls, treat the
  // turn as finished, and never execute plan_step - so the live progress
  // panel would never advance ("execution status not updated"). Emit each
  // survivor as a tool_call so the loop runs it. The input_json deltas
  // already accumulated in `cur.input`; if none arrived, default to "{}".
  for (const cur of pending.values()) {
    yield { type: 'tool_call', id: cur.id, name: cur.name, arguments: cur.input || '{}' };
  }
  pending.clear();

  yield { type: 'finish', reason: finishReason || 'stop' };
  yield { type: 'done' };
}

async function* iterateStream(resp) {
  for await (const evt of consumeStreamAsync(resp)) {
    if (evt.event === 'message_stop') {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (evt.event === 'message_start') {
      // Contains message.usage with input_tokens (and cache stats)
      let json;
      try { json = JSON.parse(evt.data); } catch { continue; }
      const u = json.message?.usage;
      if (u) {
        yield {
          type: 'usage',
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0,
          cache_creation: u.cache_creation_input_tokens ?? 0,
        };
      }
      continue;
    }
    if (evt.event === 'message_delta') {
      let json;
      try { json = JSON.parse(evt.data); } catch { continue; }
      // Final usage counts come in the message_delta's usage field. Some
      // Anthropic-compatible gateways (observed: Volcengine ark for
      // glm-5.2) report input_tokens=0 in message_start and only surface
      // the real input_tokens here; others (native Anthropic) put both
      // input + output here. Forward input when present so the status bar
      // shows the real (non-estimated) input token count for those models.
      const u = json.usage;
      if (u && typeof u.output_tokens === 'number') {
        yield {
          type: 'usage',
          input: (typeof u.input_tokens === 'number' && u.input_tokens > 0) ? u.input_tokens : 0,
          output: u.output_tokens,
        };
      }
      const reason = json.delta?.stop_reason;
      if (reason) yield { type: 'finish', reason };
      continue;
    }
    if (evt.event !== 'content_block_start' && evt.event !== 'content_block_delta' && evt.event !== 'content_block_stop') continue;
    let json;
    try { json = JSON.parse(evt.data); } catch { continue; }
    if (evt.event === 'content_block_start' && json.content_block?.type === 'tool_use') {
      yield {
        type: 'tool_use_start',
        index: json.index,
        id: json.content_block.id,
        name: json.content_block.name,
      };
    } else if (evt.event === 'content_block_start' && json.content_block?.type === 'thinking') {
      // thinking block start; subsequent deltas arrive via thinking_delta
    } else if (evt.event === 'content_block_delta') {
      const d = json.delta;
      if (!d) continue;
      if (d.type === 'text_delta' && d.text) yield { type: 'delta', text: d.text };
      else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking };
      else if (d.type === 'input_json_delta' && d.partial_json) {
        // Forward to the tool_use block at this index (already started)
        yield { type: 'tool_use_delta', index: json.index, delta: d.partial_json };
      }
    } else if (evt.event === 'content_block_stop') {
      const idx = json.index;
      yield { type: 'tool_use_stop', index: idx };
    }
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
